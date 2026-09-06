/**
 * writer.test.ts — `autocrew_writer` 四个动作（P3 spec §5）。
 *
 * 备料与审稿**两头都是异步的**（`pack`/`pack_status`、`submit`/`submit_status`），所以这里额外钉住三件事：
 * 中间态不许被当成能写的包或能收工的稿、重入不许起第二条后台任务、被 `force` 顶掉的旧任务不许覆盖新包。
 *
 * 这条链的要害是**闭包状态落了盘还作不作数**：修复计数、证据账本、`find_evidence` 配额
 * 全部跨调用，任何一样没续上都是静默的门禁失效（额度重置 = 没有上限，账本没续 = 新证据被吞）。
 * 其次是幂等与 fencing：同 attempt 重放不许有副作用，旧 pack_id 的提交必须被拒。
 *
 * 零网络、零真 LLM：审稿与补证的 loop 全从 deps 注入替身；断言只落在确定的形状与门禁判据上，
 * 绝不对 LLM 文本做逐字匹配。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { executeWriter } from "./writer.js";
import { PACK_JSON, PACK_MD, type WritingPackFile } from "./writer-pack.js";
import { packPreparation } from "./writer-prepare.js";
import { forgetReview, reviewInFlight } from "./writer-review.js";
import { executeWorkflow } from "./workflow.js";
import { buildWritingContext, generateScript } from "../modules/writing/generate-script.js";
import {
  BRIEF_SCHEMA_VERSION,
  saveBrief,
  type AngleCardV3,
  type ResearchBrief,
} from "../modules/research/brief-store.js";
import {
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type ResearchJob,
} from "../modules/research/research-job-store.js";
import { EXTERNAL_BLOCK_END, EXTERNAL_BLOCK_START } from "../modules/inbox/triage.js";
import { getContent, saveTopic, updateTopic, type Topic } from "../storage/local-store.js";
import type { EngineConfig } from "../engine/config.js";
import type { LoopOptions, LoopResult, LoopTool } from "../engine/loop.js";

let testDir: string;

const TITLE = "AI 编程助手横评";
const DESC = "对比 5 个主流工具的真实提效";
const SOURCE_URL = "https://research.example.com/reports/2026/agent-rework-study?ref=deep";
const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-writer-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "sk-test", strongModel: "m-strong", fastModel: "m-fast" }),
  );
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── 夹具 ─────────────────────────────────────────────────────────────────────

function card(over: Partial<AngleCardV3> = {}): AngleCardV3 {
  return {
    cardVersion: 3,
    id: "angle-1",
    angle: "算一笔维护账",
    thesis: "省下的编码时间被维护成本吃回去了",
    evidenceLevel: "grounded",
    coreEvidenceIds: ["ev-1"],
    antiScope: "不写工具横评",
    hookDraft: "提效是真的，只是账没算完。",
    primaryPersona: "grow",
    misconception: "他以为提效数字就是净收益",
    mechanism: "AI 写得快，返工的活落回人身上",
    payoff: "把返工工时也记进去，你当场知道这笔账划不划算",
    nextAction: "今晚把上周的返工工时记一次",
    counterResponse: "有人说熟练了就不返工——实测里熟练组也没降",
    personaGains: { grow: "听懂提效数字的水分", trust: "拿到可复用的核算口径", convert: "评估要不要全员铺开" },
    elements: ["新奇点"],
    evidenceNeeds: [],
    structure: "myth-busting",
    score: 4,
    scoreReasons: ["有简报证据"],
    ...over,
  };
}

function makeBrief(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "厂商口径与独立评测差了四倍。",
    perspectives: [],
    tensions: ["厂商宣称的提效幅度，独立评测没测到"],
    angleSuggestions: [],
    angleCards: [card()],
    evidence: [{ claim: "提效幅度远低于厂商口径", quote: "平均完成时间缩短约 12%。", sourceUrl: SOURCE_URL }],
    assetPicks: [],
    missingPerspectives: [],
    gaps: ["缺一手返工工时"],
    generatedAt: "2026-09-04T10:00:00.000Z",
    revision: 1,
    topicHash: topicHashOf(TITLE, DESC),
    ...over,
  };
}

/** 落一份「当前生效简报」（台账指针 CAS 过） */
async function seed(brief: ResearchBrief | null = makeBrief()): Promise<Topic> {
  const topic = await saveTopic({ title: TITLE, description: DESC, tags: [] }, testDir);
  if (brief) {
    await saveBrief(topic.id, brief, testDir);
    const job: ResearchJob = {
      topicId: topic.id,
      status: "succeeded",
      startedAt: "2026-09-04T09:00:00.000Z",
      settledAt: "2026-09-04T10:00:00.000Z",
      perspectives: pendingPerspectives(),
      briefRevision: brief.revision,
      topicHash: topicHashOf(TITLE, DESC),
    };
    await upsertJob(job, testDir);
  }
  return topic;
}

/** 创始人点了卡（不点卡开写会被立意闸口拒——那条另有专测） */
async function pickAngle(topicId: string, brief = makeBrief()): Promise<void> {
  await updateTopic(
    topicId,
    {
      selectedAngle: {
        briefRevision: brief.revision,
        angleId: "angle-1",
        card: brief.angleCards![0]!,
        selectedAt: "2026-09-04T11:00:00.000Z",
      },
    },
    testDir,
  );
}

const run = (params: Record<string, unknown>, deps = {}) =>
  executeWriter({ ...params, _dataDir: testDir }, { onWarn: () => {}, ...deps });

/** 一份干净的成稿：没有数字、没有镜头标注，三道门全过 */
const GOOD = {
  title: "写代码更快之后，账为什么反而不好看",
  hook: "同事说他现在写得飞快，可上线前的通宵一次没少。",
  body: "他省下的是敲字的时间，花掉的是回头看的时间。这两笔账记在不同的本子上，所以看起来像赚了。",
  cta: "今晚记一次你的返工时间，明早再看这笔账。",
  hashtags: ["#AI编程", "#提效"],
};

function submitArgs(contentId: string, packId: string, attempt: number, over: Record<string, unknown> = {}) {
  return {
    action: "submit",
    content_id: contentId,
    pack_id: packId,
    attempt,
    ...GOOD,
    review: "none",
    ...over,
  };
}

/** 领一份包，**不等**备料（`pack` 现在是秒回的领号动作） */
async function issue(over: Record<string, unknown> = {}, deps = {}): Promise<Record<string, any>> {
  const topic = await seed();
  await pickAngle(topic.id);
  const res = await run({ action: "pack", topic_id: topic.id, platform: "douyin", ...over }, deps);
  return { ...res, topicId: topic.id };
}

/** 等后台备料落地，再按宿主的真实读法（pack_status）把 ready 的完整回执取回来 */
async function settle(contentId: string): Promise<Record<string, any>> {
  await packPreparation(contentId);
  return (await run({ action: "pack_status", content_id: contentId })) as Record<string, any>;
}

/** 领一份**已经备好**的包（多数测试要的是 ready 之后那一段） */
async function pack(over: Record<string, unknown> = {}, deps = {}): Promise<Record<string, any>> {
  const started = await issue(over, deps);
  if (started.ok === false) return started;
  return { ...started, ...(await settle(started.content_id as string)) };
}

/**
 * 可控备料替身：`gate` 卡住的这段时间就是「还在准备中」，`release()` 之后才真去装配材料。
 * 这样中间态是**确定**可观测的，不靠 sleep。
 */
function deferredContext(): {
  impl: typeof buildWritingContext;
  release: () => void;
  calls: () => number;
} {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let calls = 0;
  const impl: typeof buildWritingContext = async (req, dataDir, warn, deps) => {
    calls += 1;
    await gate;
    return buildWritingContext(req, dataDir, warn, deps);
  };
  return { impl, release: () => open(), calls: () => calls };
}

async function readPackFile(contentId: string): Promise<WritingPackFile> {
  const raw = await fs.readFile(path.join(testDir, "contents", contentId, PACK_JSON), "utf-8");
  return JSON.parse(raw) as WritingPackFile;
}

/** 交一稿 → 等后台审稿落地 → 按宿主的真实读法（submit_status）把终态取回来 */
async function submitAndWait(
  contentId: string,
  packId: string,
  attempt: number,
  over: Record<string, unknown> = {},
  deps = {},
): Promise<{ first: Record<string, any>; final: Record<string, any> }> {
  const first = (await run(submitArgs(contentId, packId, attempt, { review: "engine", ...over }), deps)) as Record<
    string,
    any
  >;
  await reviewInFlight(contentId);
  const final = (await run({ action: "submit_status", content_id: contentId }, deps)) as Record<string, any>;
  return { first, final };
}

// ─── loop 替身 ────────────────────────────────────────────────────────────────

const isReview = (opts: LoopOptions): boolean => (opts.tools ?? []).some((t: LoopTool) => t.name === "submit_review");

const DONE: LoopResult = { finalMessage: "ok", turns: 1, totalTokens: 12, toolCallCount: 1, stopReason: "no_tool_calls" };

/** 审稿替身：按队列逐轮交结论；队列空 = 测试写漏了，炸出来而不是静默通过 */
function reviewLoop(rounds: Array<Record<string, unknown>>) {
  const queue = [...rounds];
  const seen: LoopOptions[] = [];
  const impl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    if (!isReview(opts)) throw new Error("这条测试只该起审稿 loop");
    seen.push(opts);
    const next = queue.shift();
    if (!next) throw new Error("审稿替身没有下一轮剧本");
    await (opts.tools ?? [])[0]!.execute(next);
    return DONE;
  };
  return { impl, seen };
}

/** 卡住的审稿替身：`release()` 之前后台那一遍不出结论——「审稿中」这个中间态因此可确定观测，不靠 sleep */
function heldReviewLoop(rounds: Array<Record<string, unknown>>) {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const inner = reviewLoop(rounds);
  const impl = async (cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    await gate;
    return inner.impl(cfg, opts);
  };
  return { impl, release: () => open(), seen: inner.seen };
}

/** 补证替身：不调用任何检索工具，直接空转 —— 配额照扣，结果是「没找到」 */
const emptyResearchLoop = async (_cfg: EngineConfig, _opts: LoopOptions): Promise<LoopResult> => ({
  finalMessage: "没查到",
  turns: 1,
  totalTokens: 5,
  toolCallCount: 0,
  stopReason: "no_tool_calls",
});

// ─── pack ─────────────────────────────────────────────────────────────────────

describe("writer pack", () => {
  it("发包：建占位稿、落两个文件、稿件上记下 pack 与 writtenBy", async () => {
    const res = await pack();
    expect(res.ok).toBe(true);
    expect(res.pack_id).toMatch(/^wp-/);
    expect(res.budget).toEqual({ find_evidence_left: 3, repair_rounds_left: expect.any(Number) });

    const content = await getContent(res.content_id, testDir);
    expect(content?.status).toBe("drafting");
    expect(content?.pack).toMatchObject({ packId: res.pack_id, host: "local-user" });
    expect(content?.pack?.submittedAt).toBeUndefined();
    expect(content?.writtenBy).toEqual({ kind: "host", host: "local-user" });
    // 归因在发包这一刻就落：补证已经花过钱了，宿主一直不交稿也要查得到手上有哪些证据
    expect(content?.evidenceLedger?.entries.map((e) => e.id)).toContain("ev-1");
    expect(content?.usedAngle?.id).toBe("angle-1");

    const dir = path.join(testDir, "contents", res.content_id);
    await expect(fs.stat(path.join(dir, PACK_MD))).resolves.toBeTruthy();
    const file = await readPackFile(res.content_id);
    expect(file).toMatchObject({
      packId: res.pack_id,
      host: "local-user",
      angleId: "angle-1",
      ledgerBudget: { max: 3, used: 0 },
      repair: { used: 0 },
      reviewRounds: 0,
      attempts: {},
    });
    expect(file.briefHash).toBeTruthy();
  });

  it("_host 由 MCP 层注入，落进 pack 与 writtenBy", async () => {
    const res = await pack({ _host: "codex" });
    const content = await getContent(res.content_id, testDir);
    expect(content?.pack?.host).toBe("codex");
    expect(content?.writtenBy).toEqual({ kind: "host", host: "codex" });
  });

  it("包顶三行固定 + 写手 system/user 逐字进包（不重写、不摘要）", async () => {
    const res = await pack();
    const md: string = res.pack_md;
    expect(md).toContain("这是你要写的稿");
    expect(md).toContain("autocrew_writer submit");
    expect(md).toContain("submit_status"); // 五步走的第五步要写在包里，不能只写在工具描述里
    expect(md).toContain("缺证据先");
    expect(md).toContain(`pack_id=${res.pack_id}`);

    const file = await readPackFile(res.content_id);
    expect(md).toContain(file.context.prompts.system);
    expect(md).toContain(file.context.prompts.user);
    // 落盘的 markdown 与返回的是同一份
    const onDisk = await fs.readFile(path.join(testDir, "contents", res.content_id, PACK_MD), "utf-8");
    expect(onDisk).toBe(md);
  });

  it("包里只有校验过的引文：外部文本在定界符内，原始网页 URL 不进包", async () => {
    const res = await pack();
    const md: string = res.pack_md;
    const starts = md.split(EXTERNAL_BLOCK_START).length - 1;
    const ends = md.split(EXTERNAL_BLOCK_END).length - 1;
    expect(starts).toBeGreaterThan(0);
    expect(starts).toBe(ends);
    // 简报引文进来了，但只带域名——原始 URL（含路径与查询串）留在账本里，不进 prompt
    expect(md).toContain("平均完成时间缩短约 12%");
    expect(md).not.toContain(SOURCE_URL);
    expect(md).not.toContain("/reports/2026/");
    // 引文落在定界区之内，不是裸文本
    const firstQuote = md.indexOf("平均完成时间缩短约 12%");
    const openBefore = md.lastIndexOf(EXTERNAL_BLOCK_START, firstQuote);
    const closeBefore = md.lastIndexOf(EXTERNAL_BLOCK_END, firstQuote);
    expect(openBefore).toBeGreaterThan(closeBefore);
  });

  it("有候选卡却没选 → 拒单（回去问创始人，不许自己挑）", async () => {
    const topic = await seed();
    const res = await run({ action: "pack", topic_id: topic.id, platform: "douyin" });
    expect(res).toMatchObject({ ok: false, needsAngle: true });
    expect(String(res.error)).toContain("angle-1");
  });

  it("force 再领一次包 = 同一篇稿换新 pack_id，旧号的提交与补证一律被拒", async () => {
    const first = await pack();
    const second = await run({
      action: "pack",
      topic_id: first.topicId,
      platform: "douyin",
      force: true,
    });
    expect(second.content_id).toBe(first.content_id);
    expect(second.pack_id).not.toBe(first.pack_id);

    const stale = await run(submitArgs(first.content_id, first.pack_id, 1));
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toContain("写作包已作废");
    const staleLookup = await run({
      action: "find_evidence",
      content_id: first.content_id,
      pack_id: first.pack_id,
      need: "返工工时",
    });
    expect(staleLookup.ok).toBe(false);
    expect(String(staleLookup.error)).toContain("写作包已作废");
  });

  it("平台非法 / 选题不存在 / 未知 action 一律 ok:false，不猜", async () => {
    const topic = await seed();
    await pickAngle(topic.id);
    expect(await run({ action: "pack", topic_id: topic.id, platform: "tiktok" })).toMatchObject({ ok: false });
    expect(await run({ action: "pack", topic_id: "topic-nope", platform: "douyin" })).toMatchObject({ ok: false });
    expect(await run({ action: "wander" })).toMatchObject({ ok: false });
  });
});

// ─── pack 异步备料（2026-09-06 实机复盘） ─────────────────────────────────────

describe("writer pack 异步备料", () => {
  it("pack 秒回 preparing → 备料期间不许写 → pack_status 变 ready 才拿到材料", async () => {
    const gathering = deferredContext();
    const started = await issue({}, { buildContextImpl: gathering.impl });
    expect(started).toMatchObject({ ok: true, status: "preparing" });
    expect(started.pack_id).toMatch(/^wp-/);
    expect(started.pack_md).toBeUndefined(); // 材料还没有，绝不能先给一份空包
    expect(String(started.note)).toContain("pack_status");

    const mid = await run({ action: "pack_status", content_id: started.content_id });
    expect(mid).toMatchObject({ ok: true, status: "preparing", pack_id: started.pack_id });
    expect(typeof mid.elapsed_s).toBe("number");
    expect(String(mid.started_at)).toBeTruthy();
    const preparingFile = await readPackFile(started.content_id);
    expect(preparingFile.state).toBe("preparing");
    expect(preparingFile.context).toBeUndefined();

    // 这段时间里交稿与补证一律被拒，并且告诉他该去等什么
    const early = await run(submitArgs(started.content_id, started.pack_id, 1));
    expect(early.ok).toBe(false);
    expect(String(early.error)).toContain("pack_status");
    const earlyLookup = await run({
      action: "find_evidence",
      content_id: started.content_id,
      pack_id: started.pack_id,
      need: "返工工时",
    });
    expect(earlyLookup.ok).toBe(false);
    expect(String(earlyLookup.error)).toContain("准备中");

    gathering.release();
    const ready = await settle(started.content_id);
    expect(ready).toMatchObject({ ok: true, status: "ready", pack_id: started.pack_id });
    expect(String(ready.pack_md)).toContain("写作包");
    expect(ready.budget).toEqual({ find_evidence_left: 3, repair_rounds_left: expect.any(Number) });
    expect((await readPackFile(started.content_id)).state).toBe("ready");
    // ready 之后就能正常交稿（同一个 pack_id，不必重新领）
    expect((await run(submitArgs(started.content_id, started.pack_id, 1))).status).toBe("accepted_unreviewed");
  });

  it("备料中再 pack 一次：同号返回，绝不起第二条后台任务", async () => {
    const gathering = deferredContext();
    const first = await issue({}, { buildContextImpl: gathering.impl });
    const again = await run(
      { action: "pack", topic_id: first.topicId, platform: "douyin" },
      { buildContextImpl: gathering.impl },
    );
    expect(again).toMatchObject({ status: "preparing", pack_id: first.pack_id, content_id: first.content_id });
    expect(gathering.calls()).toBe(1);

    gathering.release();
    await settle(first.content_id);
    // 已经备好之后再 pack 一次：原样还回同一份包，不重跑（备料花的是真钱）
    const third = await run({ action: "pack", topic_id: first.topicId, platform: "douyin" });
    expect(third).toMatchObject({ status: "ready", pack_id: first.pack_id });
    expect(gathering.calls()).toBe(1);
  });

  it("force 重来：旧号当场作废，迟到的旧备料不许覆盖新包", async () => {
    const slow = deferredContext();
    const first = await issue({}, { buildContextImpl: slow.impl });
    const firstTask = packPreparation(first.content_id)!;

    const fresh = deferredContext();
    const second = await run(
      { action: "pack", topic_id: first.topicId, platform: "douyin", force: true },
      { buildContextImpl: fresh.impl },
    );
    expect(second.status).toBe("preparing");
    expect(second.pack_id).not.toBe(first.pack_id);
    expect(second.content_id).toBe(first.content_id);

    // 旧任务这时候才跑完：它的结果必须被丢掉，否则就是实机那条 bug（旧包覆盖新包）
    slow.release();
    await firstTask;
    const afterLate = await readPackFile(first.content_id);
    expect(afterLate.packId).toBe(second.pack_id);
    expect(afterLate.state).toBe("preparing");

    fresh.release();
    const ready = await settle(first.content_id);
    expect(ready).toMatchObject({ status: "ready", pack_id: second.pack_id });
    const stale = await run(submitArgs(first.content_id, first.pack_id, 1));
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toContain("写作包已作废");
  });

  it("备料炸了 → state failed，人话原因进 pack_status 与稿件，force 能重来", async () => {
    const boom: typeof buildWritingContext = async () => {
      throw new Error("relay 断流：ECONNRESET");
    };
    const started = await issue({}, { buildContextImpl: boom });
    const failed = await settle(started.content_id);
    expect(failed.status).toBe("failed");
    // P2 翻译器：说的是「哪条线怎么了」，不是复述 ECONNRESET
    expect(String(failed.error)).toContain("连不上");
    expect(String(failed.note)).toContain("force");
    expect((await readPackFile(started.content_id)).state).toBe("failed");
    expect(String((await getContent(started.content_id, testDir))?.lastError)).toContain("写作包准备失败");

    const rejected = await run(submitArgs(started.content_id, started.pack_id, 1));
    expect(rejected.ok).toBe(false);
    expect(String(rejected.error)).toContain("写作包准备失败");
    expect(String(rejected.error)).toContain("force");

    const retry = await run({ action: "pack", topic_id: started.topicId, platform: "douyin", force: true });
    expect(retry.status).toBe("preparing");
    expect((await settle(started.content_id)).status).toBe("ready");
  });

  it("改异步之前发出的老包（没有 state 字段）算 ready，不许卡成假的「准备中」", async () => {
    const res = await pack();
    const file = await readPackFile(res.content_id);
    delete (file as Partial<WritingPackFile>).state;
    await fs.writeFile(
      path.join(testDir, "contents", res.content_id, PACK_JSON),
      JSON.stringify(file),
      "utf-8",
    );
    expect((await run({ action: "pack_status", content_id: res.content_id })).status).toBe("ready");
    expect((await run(submitArgs(res.content_id, res.pack_id, 1))).status).toBe("accepted_unreviewed");
  });

  it("pack_status 查一篇没领过包的稿 → ok:false，不编一个状态出来", async () => {
    expect(await run({ action: "pack_status", content_id: "content-nope" })).toMatchObject({ ok: false });
    expect(await run({ action: "pack_status" })).toMatchObject({ ok: false });
  });
});

// ─── find_evidence ────────────────────────────────────────────────────────────

describe("writer find_evidence", () => {
  async function packWithSearch(): Promise<Record<string, any>> {
    await fs.writeFile(path.join(testDir, "search.json"), JSON.stringify({ provider: "bocha", apiKey: "k-test" }));
    // 用手写 direction 走这条路：发包阶段就不会去跑立意卡的定向补证（那要花钱）
    return pack({ direction: "只算维护账" }, { runLoopImpl: emptyResearchLoop });
  }

  it("三次额度用完就说已用完，且 used 跨调用落在盘上", async () => {
    const res = await packWithSearch();
    const call = (n: number) =>
      run(
        { action: "find_evidence", content_id: res.content_id, pack_id: res.pack_id, need: `返工工时数据 ${n}` },
        { runLoopImpl: emptyResearchLoop },
      );

    for (const n of [1, 2, 3]) {
      const out = await call(n);
      expect(out.ok).toBe(true);
      expect(out.status).toBe("empty"); // 替身查不到：本轮如实说「没找到，不要编」
      expect(String(out.evidence)).toContain("不要编");
      expect(out.find_evidence_left).toBe(3 - n);
      // 每一次都写回盘：不写回就等于下一次调用把额度还给宿主
      expect((await readPackFile(res.content_id)).ledgerBudget.used).toBe(n);
    }

    const fourth = await call(4);
    expect(fourth.status).toBe("exhausted");
    expect(String(fourth.evidence)).toContain("已用完");
    expect(fourth.find_evidence_left).toBe(0);
    expect((await readPackFile(res.content_id)).ledgerBudget.used).toBe(3);
  });

  it("查证记录进账本，恢复后不丢（lookups 累加而不是每次归零）", async () => {
    const res = await packWithSearch();
    for (const n of [1, 2]) {
      await run(
        { action: "find_evidence", content_id: res.content_id, pack_id: res.pack_id, need: `需求 ${n}` },
        { runLoopImpl: emptyResearchLoop },
      );
    }
    const file = await readPackFile(res.content_id);
    expect(file.ledger.lookups).toHaveLength(2);
    expect(file.ledger.lookups.map((l) => l.need)).toEqual(["需求 1", "需求 2"]);
  });

  it("单次 45 秒墙钟：到点如实说超时，额度照扣（宿主 60 秒掐调用之前先收口）", async () => {
    const res = await packWithSearch();
    const hang = (): Promise<LoopResult> => new Promise<LoopResult>(() => {}); // 永不返回的补证
    const out = await run(
      { action: "find_evidence", content_id: res.content_id, pack_id: res.pack_id, need: "返工工时数据" },
      { runLoopImpl: hang, findDeadlineMs: 20 },
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("empty");
    expect(String(out.evidence)).toContain("超时");
    expect(String(out.evidence)).toContain("额度照扣");
    expect(out.find_evidence_left).toBe(2);
    expect((await readPackFile(res.content_id)).ledgerBudget.used).toBe(1);
  });

  it("need 为空、稿件不存在、搜索没配好各自拒绝并说明", async () => {
    const res = await packWithSearch();
    expect(await run({ action: "find_evidence", content_id: res.content_id, pack_id: res.pack_id })).toMatchObject({
      ok: false,
    });
    expect(await run({ action: "find_evidence", content_id: "content-nope", pack_id: res.pack_id })).toMatchObject({
      ok: false,
    });
    await fs.rm(path.join(testDir, "search.json"));
    const noSearch = await run({
      action: "find_evidence",
      content_id: res.content_id,
      pack_id: res.pack_id,
      need: "返工工时",
    });
    expect(noSearch.ok).toBe(false);
  });
});

// ─── submit：门禁 ─────────────────────────────────────────────────────────────

describe("writer submit 门禁", () => {
  it("格式门打回 → repair，稿件状态不动，修复轮扣一次（门禁这一段仍是同步的）", async () => {
    const res = await pack();
    const out = await run(
      submitArgs(res.content_id, res.pack_id, 1, { review: "engine", body: "（镜头：推近）他省下的是敲字的时间。" }),
    );
    expect(Object.keys(out)[0]).toBe("status");
    expect(out.status).toBe("repair");
    expect(reviewInFlight(res.content_id)).toBeUndefined(); // 门没过就没有稿可审
    expect((out.failures as any[]).some((f) => f.check === "format_markers")).toBe(true);
    expect(out.rounds_left).toBe(1);

    const content = await getContent(res.content_id, testDir);
    expect(content?.status).toBe("drafting");
    expect(content?.body).toBe(""); // 被打回的稿不落盘
    expect((await readPackFile(res.content_id)).repair.used).toBe(1);
  });

  it("数字门打回：账本里没有的数字进不了成稿", async () => {
    const res = await pack();
    const out = await run(
      submitArgs(res.content_id, res.pack_id, 1, { body: "独立评测说返工率涨了 37%，这笔账要自己算。" }),
    );
    expect(out.status).toBe("repair");
    expect((out.failures as any[]).some((f) => f.check === "unverified_numbers")).toBe(true);
    expect(String((out.failures as any[])[0].detail)).toContain("37%");
  });

  it("同 attempt 重放：原样返回上次结果，不再扣修复轮", async () => {
    const res = await pack();
    const bad = { body: "（镜头：推近）他省下的是敲字的时间。" };
    const first = await run(submitArgs(res.content_id, res.pack_id, 1, bad));
    const again = await run(submitArgs(res.content_id, res.pack_id, 1, bad));
    expect(again.status).toBe("repair");
    expect(again.rounds_left).toBe(first.rounds_left);
    expect(again.replayed).toBe(true);
    expect((await readPackFile(res.content_id)).repair.used).toBe(1);
  });

  it("attempt 比已记录的小 → 过期重试，拒收", async () => {
    const res = await pack();
    await run(submitArgs(res.content_id, res.pack_id, 2, { body: "（镜头：推近）先来一版。" }));
    const stale = await run(submitArgs(res.content_id, res.pack_id, 1));
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toContain("过期重试");
  });

  it("修复轮用尽仍过不了硬门 → blocked，稿件标缺证据", async () => {
    const res = await pack();
    const bad = (n: number) => ({ body: `独立评测说返工率涨了 3${n}%，这笔账要自己算。` });
    expect((await run(submitArgs(res.content_id, res.pack_id, 1, bad(1)))).status).toBe("repair");
    expect((await run(submitArgs(res.content_id, res.pack_id, 2, bad(2)))).status).toBe("repair");
    const out = await run(submitArgs(res.content_id, res.pack_id, 3, bad(3)));
    expect(out.status).toBe("blocked");
    expect(out.content_status).toBe("needs_evidence");
    expect(String(out.reason)).toBeTruthy();

    const content = await getContent(res.content_id, testDir);
    expect(content?.status).toBe("needs_evidence");
    expect(content?.blockedReason).toBeTruthy();
    expect(content?.body).toContain("返工率");
    // 交过稿了：稿卡不该再说「写作包已发出未收到稿」
    expect(content?.pack?.submittedAt).toBeTruthy();
  });

  it("长度门：正文超 12000 字 / 标题超 80 字 / hashtags 超 10 个都拒收（不扣修复轮）", async () => {
    const res = await pack();
    const long = await run(submitArgs(res.content_id, res.pack_id, 1, { body: "字".repeat(12_001) }));
    expect(long.ok).toBe(false);
    expect(String(long.error)).toContain("12000");
    const title = await run(submitArgs(res.content_id, res.pack_id, 1, { title: "标".repeat(81) }));
    expect(title.ok).toBe(false);
    const tags = await run(
      submitArgs(res.content_id, res.pack_id, 1, { hashtags: Array.from({ length: 11 }, (_, i) => `#t${i}`) }),
    );
    expect(tags.ok).toBe(false);
    const notArray = await run(submitArgs(res.content_id, res.pack_id, 1, { hashtags: "#AI" }));
    expect(notArray.ok).toBe(false);
    expect((await readPackFile(res.content_id)).repair.used).toBe(0);
  });

  it("pack_id 不匹配 / 稿件不在可写状态 / attempt 缺失 一律拒收", async () => {
    const res = await pack();
    expect(await run(submitArgs(res.content_id, "wp-someone-else", 1))).toMatchObject({ ok: false });
    const noAttempt = await run({ ...submitArgs(res.content_id, res.pack_id, 1), attempt: undefined });
    expect(noAttempt.ok).toBe(false);

    // 推到 draft_ready 之后就不再收稿
    await run(submitArgs(res.content_id, res.pack_id, 1));
    const closed = await run(submitArgs(res.content_id, res.pack_id, 2));
    expect(closed.ok).toBe(false);
    expect(String(closed.error)).toContain("不收稿");
  });
});

// ─── submit：审稿（2026-09-06 实机复盘：审一遍 161 秒 > 宿主 60 秒超时） ──────

describe("writer submit 审稿", () => {
  it("review=none → 当场 accepted_unreviewed（瞬时判断不必转后台），稿件转草稿就绪", async () => {
    const res = await pack();
    const out = await run(submitArgs(res.content_id, res.pack_id, 1));
    expect(out.status).toBe("accepted_unreviewed");
    expect(out.content_status).toBe("draft_ready");
    expect(String(out.review_skipped_reason)).toBeTruthy();
    expect(reviewInFlight(res.content_id)).toBeUndefined();

    const content = await getContent(res.content_id, testDir);
    expect(content?.status).toBe("draft_ready");
    expect(content?.review?.status).toBe("skipped");
    expect(content?.draftReadyAt).toBeTruthy();
    expect(content?.title).toBe(GOOD.title);
    expect(content?.body).toContain("敲字的时间");
    expect(content?.writtenBy).toEqual({ kind: "host", host: "local-user" });
  });

  it("审稿线没配（引擎读不出来）→ 当场 accepted_unreviewed，不挂一个等不到头的「审稿中」", async () => {
    const res = await pack();
    await fs.rm(path.join(testDir, "engine.json"));
    const out = await run(submitArgs(res.content_id, res.pack_id, 1, { review: "engine" }));
    expect(out.status).toBe("accepted_unreviewed");
    expect(String(out.review_skipped_reason)).toBeTruthy();
    expect(reviewInFlight(res.content_id)).toBeUndefined();
    expect((await getContent(res.content_id, testDir))?.status).toBe("draft_ready");
  });

  it("审稿线跑着炸了 → 后台收口成 accepted_unreviewed，原因进 review_skipped_reason 与 lastError", async () => {
    const res = await pack();
    const boom = async (_cfg: EngineConfig, _opts: LoopOptions): Promise<LoopResult> => {
      throw new Error("relay 断流：ECONNRESET");
    };
    const { first, final } = await submitAndWait(res.content_id, res.pack_id, 1, {}, { runLoopImpl: boom });
    expect(first.status).toBe("reviewing");
    expect(final.status).toBe("accepted_unreviewed");
    // P2 翻译器：说的是「审稿这条线怎么了、这次做了什么」，不是复述 ECONNRESET
    expect(String(final.review_skipped_reason)).toContain("审稿");
    expect(String(final.review_skipped_reason)).toContain("连不上");
    const content = await getContent(res.content_id, testDir);
    expect(content?.status).toBe("draft_ready");
    expect(content?.review?.status).toBe("skipped");
    expect(content?.lastError).toBe(final.review_skipped_reason);
  });

  it("门禁全过 → 先回 reviewing（稿已落盘），submit_status 才拿到 accepted", async () => {
    const res = await pack();
    const { impl } = reviewLoop([{ verdict: "pass", issues: [] }]);
    const first = await run(submitArgs(res.content_id, res.pack_id, 1, { review: "engine" }), { runLoopImpl: impl });
    expect(Object.keys(first)[0]).toBe("status");
    expect(first).toMatchObject({ status: "reviewing", attempt: 1, content_id: res.content_id });
    expect(String(first.note)).toContain("submit_status");
    // 「稿已落盘」不是口号：这一刻正文、归属、submittedAt 都已经在盘上
    const mid = await getContent(res.content_id, testDir);
    expect(mid?.status).toBe("drafting");
    expect(mid?.body).toContain("敲字的时间");
    expect(mid?.pack?.submittedAt).toBeTruthy();
    expect((await readPackFile(res.content_id)).attempts["1"]!.status).toBe("reviewing");

    await reviewInFlight(res.content_id);
    const final = await run({ action: "submit_status", content_id: res.content_id });
    expect(final).toMatchObject({ ok: true, status: "accepted", attempt: 1, content_status: "draft_ready" });
    expect(typeof final.elapsed_s).toBe("number");
    expect(final.title).toBe(GOOD.title);
    expect((await getContent(res.content_id, testDir))?.review?.status).toBe("passed");
    // 终态落进 attempts：再问一次还是同一个答案，不重审
    expect((await readPackFile(res.content_id)).attempts["1"]!.status).toBe("accepted");
    expect((await run({ action: "submit_status", content_id: res.content_id })).status).toBe("accepted");
  });

  it("审稿点名 → review_required + 稿件退 revision；改完再交 → accepted", async () => {
    const res = await pack();
    const blocker = {
      severity: "blocker",
      quote: "他省下的是敲字的时间",
      rule: "论点只是材料复述",
      instruction: "把这句换成一个具体场景",
    };
    const { impl } = reviewLoop([{ verdict: "revise", issues: [blocker] }, { verdict: "pass", issues: [] }]);

    const one = await submitAndWait(res.content_id, res.pack_id, 1, {}, { runLoopImpl: impl });
    expect(one.first.status).toBe("reviewing");
    expect(one.final.status).toBe("review_required");
    expect(one.final.round).toBe(1);
    expect((one.final.issues as any[])[0].rule).toBe("论点只是材料复述");
    expect((await getContent(res.content_id, testDir))?.status).toBe("revision");

    const two = await submitAndWait(
      res.content_id,
      res.pack_id,
      2,
      { body: "那天他上线前又通宵了一次，敲字确实快了，回头看的活一点没少。" },
      { runLoopImpl: impl },
    );
    expect(two.first.status).toBe("reviewing");
    expect(two.final).toMatchObject({ status: "accepted", attempt: 2 });
    const content = await getContent(res.content_id, testDir);
    expect(content?.status).toBe("draft_ready");
    expect(content?.review?.rounds).toBe(1);
    // 真机 2026-09-06：稿已 draft_ready 后宿主重发同一 attempt，要拿回「已收下」的原结果，不是「不收稿」
    const again = (await run(submitArgs(res.content_id, res.pack_id, 2, { review: "engine" }), { runLoopImpl: impl })) as Record<string, any>;
    expect(again).toMatchObject({ status: "accepted", replayed: true });
  });

  it("点满两轮仍有 blocker → accepted_with_issues，残留清单落盘", async () => {
    const res = await pack();
    const blocker = {
      severity: "blocker",
      quote: "他省下的是敲字的时间",
      rule: "论点只是材料复述",
      instruction: "换成一个具体场景",
    };
    const { impl } = reviewLoop([
      { verdict: "revise", issues: [blocker] },
      { verdict: "revise", issues: [blocker] },
      { verdict: "revise", issues: [blocker] },
    ]);
    const opts = { runLoopImpl: impl };
    expect((await submitAndWait(res.content_id, res.pack_id, 1, {}, opts)).final.status).toBe("review_required");
    expect((await submitAndWait(res.content_id, res.pack_id, 2, {}, opts)).final.status).toBe("review_required");
    const third = await submitAndWait(res.content_id, res.pack_id, 3, {}, opts);
    expect(third.final.status).toBe("accepted_with_issues");
    expect(third.final.issues as any[]).toHaveLength(1);

    const content = await getContent(res.content_id, testDir);
    expect(content?.status).toBe("draft_ready");
    expect(content?.review?.status).toBe("failed");
    expect(content?.review?.rounds).toBe(2);
  });

  it("审稿中重放同一个 attempt：还回 reviewing，不起第二遍审稿", async () => {
    const res = await pack();
    const held = heldReviewLoop([{ verdict: "pass", issues: [] }]);
    const opts = { runLoopImpl: held.impl };
    const first = await run(submitArgs(res.content_id, res.pack_id, 1, { review: "engine" }), opts);
    expect(first.status).toBe("reviewing");

    const again = await run(submitArgs(res.content_id, res.pack_id, 1, { review: "engine" }), opts);
    expect(again.status).toBe("reviewing");
    expect(again.replayed).toBe(true);
    expect((await run({ action: "submit_status", content_id: res.content_id })).status).toBe("reviewing");

    held.release();
    await reviewInFlight(res.content_id);
    expect(held.seen).toHaveLength(1); // 重放没有让审稿多跑一遍（那是真金白银）
    expect((await run({ action: "submit_status", content_id: res.content_id })).status).toBe("accepted");
  });

  it("上一稿还在审时交下一个 attempt → 拒收，让他先等结果", async () => {
    const res = await pack();
    const held = heldReviewLoop([{ verdict: "pass", issues: [] }]);
    const opts = { runLoopImpl: held.impl };
    expect((await run(submitArgs(res.content_id, res.pack_id, 1, { review: "engine" }), opts)).status).toBe("reviewing");

    const next = await run(submitArgs(res.content_id, res.pack_id, 2, { review: "engine" }), opts);
    expect(next.ok).toBe(false);
    expect(String(next.error)).toContain("attempt 1");
    expect(String(next.error)).toContain("submit_status");
    expect((await readPackFile(res.content_id)).attempts["2"]).toBeUndefined();

    held.release();
    await reviewInFlight(res.content_id);
    expect(held.seen).toHaveLength(1);
  });

  it("进程重启：盘上留着 reviewing → 下一次 submit_status 把这一遍重跑起来", async () => {
    const res = await pack();
    const held = heldReviewLoop([{ verdict: "pass", issues: [] }]);
    expect((await run(submitArgs(res.content_id, res.pack_id, 1, { review: "engine" }), { runLoopImpl: held.impl })).status).toBe(
      "reviewing",
    );
    held.release();
    await reviewInFlight(res.content_id);
    // 装成「审稿跑到一半进程没了」：盘上是 reviewing，进程里没人在跑
    await fs.writeFile(
      path.join(testDir, "contents", res.content_id, PACK_JSON),
      JSON.stringify({
        ...(await readPackFile(res.content_id)),
        attempts: {
          "1": {
            status: "reviewing",
            at: new Date().toISOString(),
            result: { status: "reviewing", attempt: 1, content_id: res.content_id, note: "审稿中" },
            pending: {
              host: "local-user",
              payload: { ...GOOD, hashtags: [...GOOD.hashtags] },
              humanizedText: GOOD.body,
              needsHuman: [],
              gateNotes: [],
            },
          },
        },
      }),
      "utf-8",
    );
    forgetReview(res.content_id);

    const { impl, seen } = reviewLoop([{ verdict: "pass", issues: [] }]);
    const resumed = await run({ action: "submit_status", content_id: res.content_id }, { runLoopImpl: impl });
    expect(resumed.status).toBe("reviewing"); // 这一次先如实说「还在审」，同时把它重跑起来
    await reviewInFlight(res.content_id);
    expect(seen).toHaveLength(1);
    expect((await run({ action: "submit_status", content_id: res.content_id })).status).toBe("accepted");
    expect((await getContent(res.content_id, testDir))?.status).toBe("draft_ready");
  });

  it("submit_status 查没交过稿 / 不存在的 attempt / 没领过包 → ok:false，不编一个状态出来", async () => {
    const res = await pack();
    const never = await run({ action: "submit_status", content_id: res.content_id });
    expect(never.ok).toBe(false);
    expect(String(never.error)).toContain("submit");

    await run(submitArgs(res.content_id, res.pack_id, 1));
    const wrong = await run({ action: "submit_status", content_id: res.content_id, attempt: 7 });
    expect(wrong.ok).toBe(false);
    expect(String(wrong.error)).toContain("attempt 7");
    expect(await run({ action: "submit_status", content_id: "content-nope" })).toMatchObject({ ok: false });
    expect(await run({ action: "submit_status" })).toMatchObject({ ok: false });
  });
});

// ─── draft 视图 ───────────────────────────────────────────────────────────────

describe("draft 视图", () => {
  it("包发出去没收到稿 → 说「已发给谁、多久了」，不再误报「还在后台写」", async () => {
    const res = await pack({ _host: "claude-code" });
    const view = (await executeWorkflow({
      action: "draft",
      content_id: res.content_id,
      _dataDir: testDir,
    })) as Record<string, any>;
    expect(view.status).toBe("drafting");
    expect(view.note).toContain("写作包已发给 claude-code");
    expect(view.note).not.toContain("还在后台写");
    expect(view.packOutstanding).toBe(true);
    expect(view.writtenByLabel).toBe("claude-code");
  });

  it("稿交了、审稿还没出结论 → 说「稿已交，审稿中」，不再说成「已发给谁、未收到稿」", async () => {
    const res = await pack({ _host: "claude-code" });
    const held = heldReviewLoop([{ verdict: "pass", issues: [] }]);
    await run(submitArgs(res.content_id, res.pack_id, 1, { review: "engine" }), { runLoopImpl: held.impl });
    const view = (await executeWorkflow({
      action: "draft",
      content_id: res.content_id,
      _dataDir: testDir,
    })) as Record<string, any>;
    expect(view.status).toBe("drafting");
    expect(view.note).toContain("稿已交，审稿中");
    expect(view.note).not.toContain("未收到稿");
    held.release();
    await reviewInFlight(res.content_id);
  });

  it("交稿之后 draft 视图带上 writtenBy 与 pack", async () => {
    const res = await pack({ _host: "codex" });
    // 交稿的宿主就是 writtenBy 的那个（发包与交稿分属两家时以交稿者为准）
    await run(submitArgs(res.content_id, res.pack_id, 1, { _host: "codex" }));
    const view = (await executeWorkflow({
      action: "draft",
      content_id: res.content_id,
      _dataDir: testDir,
    })) as Record<string, any>;
    expect(view.status).toBe("draft_ready");
    expect(view.packOutstanding).toBe(false);
    expect(view.pack.submittedAt).toBeTruthy();
    expect(view.writtenBy).toEqual({ kind: "host", host: "codex" });
  });
});

// ─── 两条路径的门禁输入一致（spec §5.4） ─────────────────────────────────────

describe("门禁输入快照：内部写手 vs 宿主", () => {
  it("同一条选题上，两条路径拿到同一份 prompt、同一本账、同一份门禁判据", async () => {
    const topic = await seed();
    await pickAngle(topic.id);

    // 宿主路径：领包 → 等备料 → 交一版带镜头标注的稿，拿门禁的打回文案
    const issued = (await run({ action: "pack", topic_id: topic.id, platform: "douyin" })) as Record<string, any>;
    const hostPack = { ...issued, ...(await settle(issued.content_id as string)) };
    const hostSubmit = await run(
      submitArgs(hostPack.content_id, hostPack.pack_id, 1, { body: "（镜头：推近）他省下的是敲字的时间。" }),
    );
    const hostFile = await readPackFile(hostPack.content_id);
    const hostLedger = (await getContent(hostPack.content_id, testDir))?.evidenceLedger;

    // 内部路径：同一条选题起一轮生成，写手交同一版稿，捕获 submit_script 的打回文案
    let internalSystem = "";
    let internalUser = "";
    const execResults: string[] = [];
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      if (isReview(opts)) return { ...DONE, toolCallCount: 0 };
      internalSystem = opts.systemPrompt ?? "";
      internalUser = opts.userMessage ?? "";
      const submit = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
      execResults.push(await submit.execute({ ...GOOD, body: "（镜头：推近）他省下的是敲字的时间。" }));
      return DONE;
    };
    const internal = await generateScript(
      { topic: TITLE, platform: "douyin", topicId: topic.id },
      testDir,
      { runLoopImpl, onWarn: () => {} },
    );
    const internalLedger = (await getContent(internal.contentId, testDir))?.evidenceLedger;

    // 1) 两段提示词逐字相同（写作指令不因换宿主而变）
    expect(hostFile.context.prompts.system).toBe(internalSystem);
    expect(hostFile.context.prompts.user).toBe(internalUser);
    // 2) 同一本账（同样的条目 id，含简报证据与用户材料）
    expect(hostLedger?.entries.map((e) => e.id)).toEqual(internalLedger?.entries.map((e) => e.id));
    expect(hostLedger?.budget).toEqual(internalLedger?.budget);
    // 3) 同一份门禁判据：同一稿在两条路上拿到同一段打回文案
    const hostDetail = (hostSubmit.failures as any[]).map((f) => f.detail).join("\n\n");
    expect(execResults[0]).toContain(hostDetail);
    // 4) 内部路径这一轮同样被硬门拦下（判据没有单边放松）
    expect(internal.needsEvidence).toBe(true);
  });
});
