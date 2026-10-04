import { executeEditorial } from "./editorial.js";
import { appendHypotheses, listHypotheses } from "../modules/retro/hypotheses.js";
import { createCreativeTask } from "../modules/writing/creative-task.js";
/**
 * writer.test.ts — `autocrew_writer` 四个动作（P3 spec §5）。
 *
 * 备料与审稿**两头都是异步的**（`pack`/`pack_status`、`submit`/`submit_status`；宿主模式 `pack` 就地等至多 15 秒），
 * 所以这里额外钉住：中间态不许被当成能写的包或能收工的稿、重入不许起第二条后台任务、被 `force` 顶掉或
 * 被判死的旧任务不许覆盖现行的包、每个等待都有终点（轮询上限、孤儿重跑、启动清扫）。
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
import { executeScout } from "./scout.js";
import { failStalePreparingPacks, PACK_JSON, PACK_MD, STALE_PREPARING_MS, type WritingPackFile } from "./writer-pack.js";
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
import { getContent, saveTopic, updateTopic, updateContent, type Topic } from "../storage/local-store.js";
import { addWritingRule, updateProfile } from "../modules/profile/creator-profile.js";
import { addApprovedRuleForTest } from "../modules/profile/rule-fixtures.js";
import type { EngineConfig } from "../engine/config.js";
import type { LoopOptions, LoopResult, LoopTool, runLoop } from "../engine/loop.js";
import { hashClaimToken } from "../storage/claim-token.js";
import { asFounder, founderAuthored } from "../modules/research/angle-gate.test-helper.js";

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

const run = async (params: Record<string, unknown>, deps = {}) => {
  await asFounder(testDir, params);
  return executeWriter({ ...params, _dataDir: testDir }, { onWarn: () => {}, ...deps });
};

/** 一份干净的成稿：没有数字、没有镜头标注，三道门全过 */
const GOOD = {
  title: "写代码更快之后，账为什么反而不好看",
  hook: "同事说他现在写得飞快，可上线前的通宵一次没少。",
  body: "他省下的是敲字的时间，花掉的是回头看的时间。这两笔账记在不同的本子上，所以看起来像赚了。",
  cta: "今晚记一次你的返工时间，明早再看这笔账。",
  hashtags: ["#AI编程", "#提效"],
};

/** 新写作包交稿必带的稿件摘要（spec 2026-09-28 §3 A） */
const OUTLINE = {
  thesis: "AI 省下的是敲字时间，返工时间记在另一本账上。",
  points: [{ text: "同事写得快但通宵没少", kind: "case", seconds: 60 }, { text: "两本账为什么看起来像赚了", kind: "cause", seconds: 90 }],
  structure: { opening: "同事写得飞快的反差", progression: "拆两本账", ending: "今晚记一次返工时间" },
  said: [{ id: "two-ledgers", kind: "metaphor", text: "敲字时间和回头看的时间是两本账" }],
};

function submitArgs(contentId: string, packId: string, attempt: number, over: Record<string, unknown> = {}) {
  return {
    action: "submit",
    content_id: contentId,
    pack_id: packId,
    attempt,
    ...GOOD,
    outline: OUTLINE,
    review: "none",
    ...over,
  };
}

/** 领一份包（宿主模式通常就地备好；卡住的备料替身要带 `deps` 把同步等待归零） */
async function issue(over: Record<string, unknown> = {}, deps = {}): Promise<Record<string, any>> {
  const topic = await seed(makeBrief({ creativeTask: createCreativeTask({ platform: "douyin", ...over }) }));
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
 * 这样中间态是**确定**可观测的，不靠 sleep。`deps` 顺带把 `pack` 的同步等待归零——
 * 否则卡住的备料会让每次 pack 都干等满 15 秒。
 */
function deferredContext(): {
  impl: typeof buildWritingContext;
  deps: { buildContextImpl: typeof buildWritingContext; packSyncDeadlineMs: number };
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
  return { impl, deps: { buildContextImpl: impl, packSyncDeadlineMs: 0 }, release: () => open(), calls: () => calls };
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
  it("requirements 完整进包与原请求，保留已选立意；它本身不能绕过选卡", async () => {
    const requirements = "写给第一次用 AI 的人；先讲真实返工，再解释原因；不做工具清单。";
    const topic = await seed(makeBrief({ creativeTask: createCreativeTask({ platform: "douyin", requirements }) }));
    expect(await run({ action: "pack", topic_id: topic.id, platform: "douyin", requirements }))
      .toMatchObject({ ok: false, needsAngle: true });
    await pickAngle(topic.id);
    const started = await run({ action: "pack", topic_id: topic.id, platform: "douyin", requirements });
    await settle(started.content_id as string);
    const file = await readPackFile(started.content_id as string);
    expect(file.context?.req.requirements).toBe(requirements);
    expect(file.context?.req.direction).toBeUndefined();
    expect(file.angleId).toBe("angle-1");
    expect(file.request?.topicDescription).toBe(DESC);
    expect((await getContent(started.content_id as string, testDir))?.genRequest)
      .toMatchObject({ requirements, topicDescription: DESC });
  });

  it("发包：建占位稿、落两个文件、稿件上记下 pack 与 writtenBy", async () => {
    const res = await pack();
    expect(res.ok).toBe(true);
    expect(res.pack_id).toMatch(/^wp-/);
    expect(res.budget).toEqual({ evidence_mode: "host", host_evidence_left: 12, find_evidence_left: 3, repair_rounds_left: expect.any(Number) });

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

// ─── 手工建的选题：没有简报也得有账本（2026-09-22 实机复盘） ──────────────────

describe("writer pack — 手工建的选题（没有简报）", () => {
  const MANUAL_DESC = "自己扒的转录：三家客户上线后返工工时平均多了 18%，出处见对方的复盘会纪要。";

  const manualTopic = async (): Promise<Topic> => {
    const topic = await saveTopic({ title: TITLE, description: MANUAL_DESC, tags: [] }, testDir);
    return topic;
  };

  it("选题描述与宿主给的 research 都登记成 user_claim——没简报不等于没账本", async () => {
    const topic = await manualTopic();
    const started = await run({
      action: "pack",
      topic_id: topic.id,
      platform: "douyin",
      research_mode: "provided", direction: "只讲这次亲历的返工问题",
      research: "宿主自己查到的：同一批客户的人力成本一年多花了 24 万。",
    });
    expect(started.ok).toBe(true);
    await settle(started.content_id as string);

    const file = await readPackFile(started.content_id as string);
    expect(file.briefHash).toBe(""); // 确认走的就是「没简报」那条路
    const byId = new Map(file.ledger.entries.map((e) => [e.id, e]));
    expect(byId.get("user-topic")).toMatchObject({ source: "user_claim", quote: MANUAL_DESC });
    expect(byId.get("user-research")).toMatchObject({ source: "user_claim" });
    expect(String(byId.get("user-research")?.quote)).toContain("24 万");
  });

  it("正文引用选题描述里的数字 → 数字门放行（这条路以前全量打回）", async () => {
    const topic = await manualTopic();
    const started = await run({ action: "pack", topic_id: topic.id, platform: "douyin", research_mode: "provided", research: MANUAL_DESC, direction: "按现有实测材料解释返工" });
    await settle(started.content_id as string);

    const out = await run(
      submitArgs(started.content_id as string, started.pack_id as string, 1, {
        body: "他们上线之后返工工时平均多了 18%，这笔账得自己记一次。",
      }),
    );
    const failures = (out.failures as Array<{ check: string }> | undefined) ?? [];
    expect(failures.some((f) => f.check === "unverified_numbers")).toBe(false);
  });

  /**
   * P5-0 验收（spec §7）。口径是**模型调用次数 = 0**，不是「没报错」——
   * 2026-09-22 那次之所以还能领包，是因为配置在、只是端点连不上，
   * 那证明不了「完全没配也能跑」。所以这条把 engine.json 删掉，并让 runLoop 一调就炸。
   */
  it("完全没配 engine 也能领包 → 备料 → 交稿过门，全程零模型调用", async () => {
    await fs.rm(path.join(testDir, "engine.json"));
    const modelCalls: unknown[] = [];
    const runLoopImpl = ((...args: unknown[]) => {
      modelCalls.push(args);
      throw new Error("零配置路径不该调用模型");
    }) as unknown as typeof runLoop;

    const topic = await manualTopic();
    const started = await run({ action: "pack", topic_id: topic.id, platform: "douyin", research_mode: "provided", research: MANUAL_DESC, direction: "按现有实测材料解释返工" }, { runLoopImpl });
    expect(started.ok).toBe(true);

    const ready = await settle(started.content_id as string);
    expect(ready).toMatchObject({ ok: true, status: "ready" });

    // 账本照样建起来了：没有引擎，选题描述这条 user_claim 仍然是数字的出处
    const file = await readPackFile(started.content_id as string);
    expect(file.ledger.entries.map((e) => e.id)).toContain("user-topic");

    const out = await run(
      submitArgs(started.content_id as string, started.pack_id as string, 1, {
        body: "他们上线之后返工工时平均多了 18%，这笔账得自己记一次。",
      }),
    );
    expect(out.status).toBe("accepted_unreviewed");
    expect(modelCalls).toHaveLength(0);
  });

  it.each(["host", "engine"])("engine.json 损坏：%s 路径按执行模式处理", async (execution) => {
    await fs.writeFile(path.join(testDir, "engine.json"), "{broken");
    const topic = await manualTopic();
    const started = await run({ action: "pack", execution, topic_id: topic.id, platform: "douyin", research_mode: "provided", research: MANUAL_DESC, direction: "按现有实测材料解释返工" });
    // engine 模式仍是异步领号（30 秒回查），宿主模式就地备完
    expect(started).toMatchObject(execution === "host" ? { status: "ready", synchronous: true } : { status: "preparing", poll_after_seconds: 30 });
    const status = await settle(started.content_id as string);
    expect(status.status).toBe(execution === "host" ? "ready" : "failed");
    if (execution === "engine") expect(String(status.error)).toContain("engine.json");
  });
});

// ─── provided 模式：推算出来的数怎么进账（§11 待修第一条，P6-e 行为 eval 场景 1） ──────

describe("writer provided 模式：证据台账带编号，推算数走写手侧登记", () => {
  const FACTS = "每周开 3 场例会；每场会后整理纪要要 40 分钟，用了自动纪要后每场只要 10 分钟。";
  const BODY = "以前每场会后整理纪要要 40 分钟，现在 10 分钟，一场省三十分钟。";

  async function providedPack(): Promise<Record<string, any>> {
    const topic = await saveTopic({ title: "例会纪要", description: "", tags: [] }, testDir);
    const started = await run({ action: "pack", topic_id: topic.id, platform: "douyin", research_mode: "provided", research: FACTS, direction: "讲自动纪要省下的时间" });
    expect(started).toMatchObject({ ok: true, status: "ready" });
    return started;
  }

  it("pack_md 在数字纪律前列出证据台账编号，结构化回执给 ledger_ids", async () => {
    const res = await providedPack();
    const md = String(res.pack_md);
    expect(md).toContain("## 证据台账");
    expect(md).toContain("- user-research（用户材料）：每周开 3 场例会");
    expect(md.indexOf("## 证据台账")).toBeLessThan(md.indexOf("数字必须能指到证据编号"));
    expect(md).toContain("claim_offline");
    expect(res.ledger_ids).toContain("user-research");
  });

  it("find_evidence 不另起研究任务，给 claim_offline 入口；登记「一场省三十分钟」后数字门放行", async () => {
    const res = await providedPack();
    const contentId = res.content_id as string;
    const packId = res.pack_id as string;
    const before = await run(submitArgs(contentId, packId, 1, { body: BODY }));
    expect(before.status).toBe("repair");
    expect(JSON.stringify(before.failures)).toContain("三十分钟");

    const found = await run({ action: "find_evidence", content_id: contentId, pack_id: packId, claim_token: res.claim_token, need: "一场省多少时间" });
    expect(found).toMatchObject({
      ok: true, status: "awaiting_host_evidence", model_api_calls: 0,
      citation_target: { content_id: contentId, pack_id: packId },
      next_action: { tool: "autocrew_scout", params: { action: "claim_offline", content_id: contentId, pack_id: packId, claim_token: res.claim_token } },
    });
    expect(found.task_id).toBeUndefined();
    expect(String(found.note)).toContain("推算出来的数先登记成 user_claim，说明推算依据");

    const registered = await executeScout({
      ...(found.next_action as { params: Record<string, unknown> }).params,
      claim: "一场省三十分钟", reason: "user-research：40 分钟减去 10 分钟", _dataDir: testDir,
    });
    expect(registered).toMatchObject({ ok: true, claim_id: "user-1", verified: false });

    const after = await run(submitArgs(contentId, packId, 2, { body: BODY, claim_token: res.claim_token }));
    const failures = (after.failures as Array<{ check: string }> | undefined) ?? [];
    expect(failures.some((f) => f.check === "unverified_numbers")).toBe(false);
    expect(after.status).toBe("accepted_unreviewed");
    const status = await run({ action: "pack_status", content_id: contentId });
    expect(String(status.pack_md)).toContain("- user-1（用户材料）：一场省三十分钟");
    expect(status.budget).toMatchObject({ host_evidence_left: 11 });
  });
});

// ─── pack 异步备料（2026-09-06 实机复盘） ─────────────────────────────────────

describe("writer pack 异步备料", () => {
  it("备料中新要求不静默复用旧包，也不重复启动备料", async () => {
    const gathering = deferredContext();
    const first = await issue({ requirements: "先讲真实返工，再解释原因。" }, gathering.deps);
    const changed = await run({
      action: "pack", topic_id: first.topicId, platform: "douyin", requirements: "按一天的经历展开。",
    }, gathering.deps);
    expect(changed).toMatchObject({ ok: false, code: "pack_request_changed", pack_id: first.pack_id });
    expect(String(changed.error)).toContain("force:true");
    expect(gathering.calls()).toBe(1);
    expect((await readPackFile(first.content_id)).request?.req.requirements).toBe("先讲真实返工，再解释原因。");
    gathering.release();
    await settle(first.content_id);
  });

  it("已备包继承未重提要求；新要求先拒绝，force 刷新请求并保留旧材料", async () => {
    const first = await pack({ requirements: "按一天经历展开。", direction: "只讲维护成本", research: "用户实测材料", research_mode: "provided" });
    const again = await run({ action: "pack", topic_id: first.topicId, platform: "douyin" });
    expect(again, JSON.stringify(again).slice(0, 400)).toMatchObject({ status: "ready", pack_id: first.pack_id });
    const changedArgs = { action: "pack", topic_id: first.topicId, platform: "douyin", requirements: "保留经历，开头先说结果。" };
    expect(await run(changedArgs)).toMatchObject({ ok: false, code: "pack_request_changed" });
    expect((await getContent(first.content_id, testDir))?.genRequest?.requirements).toBe("按一天经历展开。");
    const fresh = await run({ ...changedArgs, force: true });
    expect(fresh.pack_id).not.toBe(first.pack_id);
    await settle(first.content_id);
    const req = (await readPackFile(first.content_id)).context?.req;
    expect(req).toMatchObject({ requirements: changedArgs.requirements, direction: "只讲维护成本", research: "用户实测材料" });
    expect((await getContent(first.content_id, testDir))?.genRequest).toEqual(req);
  });

  it.each(["direction", "research", "requirements"])("已备包显式改变 %s 必须换包，前后空白不误判", async (field) => {
    const first = await pack({ [field]: "原始要求或材料" });
    expect(await run({ action: "pack", topic_id: first.topicId, platform: "douyin", [field]: "  原始要求或材料  " }))
      .toMatchObject({ status: "ready", pack_id: first.pack_id });
    expect(await run({ action: "pack", topic_id: first.topicId, platform: "douyin", [field]: "" }))
      .toMatchObject({ ok: false, code: "pack_request_changed" });
  });

  it.each(["title", "description"])("选题 %s 更新不能继续复用旧包", async (field) => {
    const first = await pack();
    await updateTopic(first.topicId, { [field]: "创作者更新后的内容规划" }, testDir);
    expect(await run({ action: "pack", topic_id: first.topicId, platform: "douyin" }))
      .toMatchObject({ ok: false, code: "pack_request_changed", pack_id: first.pack_id });
  });

  it("旧包无 request 快照仍可复用，并能从 context.req 识别新要求", async () => {
    const first = await pack({ requirements: "保留作者自己的经历。" });
    const old = await readPackFile(first.content_id);
    delete old.request;
    await fs.writeFile(path.join(testDir, "contents", first.content_id, PACK_JSON), JSON.stringify(old));
    expect(await run({ action: "pack", topic_id: first.topicId, platform: "douyin" }))
      .toMatchObject({ status: "ready", pack_id: first.pack_id });
    expect(await run({ action: "pack", topic_id: first.topicId, platform: "douyin", requirements: "删除个人经历。" }))
      .toMatchObject({ ok: false, code: "pack_request_changed" });
  });

  it("更换选中的立意也使旧包失效；force 并清空 direction 才改用新卡", async () => {
    const first = await pack({ direction: "只讲原来的角度" });
    const changedCard = card({ thesis: "新论点：返工来自没有验收标准" });
    const renewed = makeBrief({ revision: 2, angleCards: [changedCard], creativeTask: createCreativeTask({ platform: "douyin" }) });
    await saveBrief(first.topicId, renewed, testDir);
    await upsertJob({ topicId: first.topicId, status: "succeeded", startedAt: "2026-09-22T00:00:00Z", perspectives: [], briefRevision: renewed.revision, topicHash: topicHashOf(TITLE, DESC), creativeTask: renewed.creativeTask }, testDir);
    await pickAngle(first.topicId, renewed);
    expect(await run({ action: "pack", topic_id: first.topicId, platform: "douyin" }))
      .toMatchObject({ ok: false, code: "pack_request_changed", pack_id: first.pack_id });
    const fresh = await run({ action: "pack", topic_id: first.topicId, platform: "douyin", direction: "", force: true });
    expect(fresh.pack_id).not.toBe(first.pack_id);
    await settle(first.content_id);
    const file = await readPackFile(first.content_id);
    expect(file.context?.req.direction).toBe("");
    expect(file.context?.angleCard?.thesis).toBe(changedCard.thesis);
    expect(file.context?.writingContract).toContain(changedCard.thesis);
  });

  it("创作者档案规则变化使旧包失效，force 后规划快照和合同同步更新", async () => {
    const first = await pack();
    const original = await readPackFile(first.content_id);
    const rule = "先说观众今天能做什么，不要讲师式开场";
    await addApprovedRuleForTest({ rule, source: "user_explicit", confidence: 1 }, testDir);
    expect(await run({ action: "pack", topic_id: first.topicId, platform: "douyin" }))
      .toMatchObject({ ok: false, code: "pack_request_changed", pack_id: first.pack_id });
    expect((await readPackFile(first.content_id)).request?.planningFingerprint).toBe(original.request?.planningFingerprint);
    await run({ action: "pack", topic_id: first.topicId, platform: "douyin", force: true });
    await settle(first.content_id);
    const refreshed = await readPackFile(first.content_id);
    expect(refreshed.request?.planningFingerprint).not.toBe(original.request?.planningFingerprint);
    expect(refreshed.context?.writingContract).toContain(rule);
  });

  it("新增待批规则、审批日志和别的平台规则都不改变写作包指纹，不触发 pack_request_changed（spec §3 D）", async () => {
    await updateProfile({ industry: "真实 AI 实操" }, testDir);
    const first = await pack();
    const original = await readPackFile(first.content_id);
    await addWritingRule({ rule: "自动提炼出来还没批的规则", source: "auto_distilled", confidence: 0.9, evidence: ["改稿 A"] }, testDir);
    await addApprovedRuleForTest({ rule: "只管小红书的规则", source: "user_explicit", confidence: 1, scope: "platform:xiaohongshu" }, testDir);
    const again = await run({ action: "pack", topic_id: first.topicId, platform: "douyin" });
    expect(again, JSON.stringify(again).slice(0, 400)).toMatchObject({ status: "ready", pack_id: first.pack_id });
    expect((await readPackFile(first.content_id)).request?.planningFingerprint).toBe(original.request?.planningFingerprint);
    expect(String(again.pack_md)).not.toContain("自动提炼出来还没批的规则");
  });

  it("相同规划快照即使对象键顺序改变也复用原包", async () => {
    await updateProfile({ industry: "真实 AI 实操", expressionPersona: "像朋友复盘" }, testDir);
    const first = await pack();
    const profilePath = path.join(testDir, "creator-profile.json");
    const profile = JSON.parse(await fs.readFile(profilePath, "utf-8"));
    await fs.writeFile(profilePath, JSON.stringify(Object.fromEntries(Object.entries(profile).reverse())));
    expect(await run({ action: "pack", topic_id: first.topicId, platform: "douyin" }))
      .toMatchObject({ status: "ready", pack_id: first.pack_id });
  });

  it("旧包没有规划指纹时不把当前档案冒充历史快照；force 后开始完整追踪", async () => {
    const first = await pack();
    const legacy = await readPackFile(first.content_id);
    delete legacy.request!.planningFingerprint;
    await fs.writeFile(path.join(testDir, "contents", first.content_id, PACK_JSON), JSON.stringify(legacy));
    await updateProfile({ industry: "新的内容定位" }, testDir);
    expect(await run({ action: "pack", topic_id: first.topicId, platform: "douyin" }))
      .toMatchObject({ status: "ready", pack_id: first.pack_id });
    await run({ action: "pack", topic_id: first.topicId, platform: "douyin", force: true });
    await settle(first.content_id);
    expect((await readPackFile(first.content_id)).request?.planningFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("宿主模式到点没备完 → 回 preparing（5 秒回查）→ 备料期间不许写 → pack_status 变 ready 才拿到材料", async () => {
    const gathering = deferredContext();
    const t0 = Date.now();
    const started = await issue({}, { ...gathering.deps, packSyncDeadlineMs: 30 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25); // 真在等，只是到点了
    expect(started).toMatchObject({ ok: true, status: "preparing", poll_after_seconds: 5 });
    expect(started.synchronous).toBeUndefined();
    expect(started.pack_id).toMatch(/^wp-/);
    expect(started.pack_md).toBeUndefined(); // 材料还没有，绝不能先给一份空包
    expect(String(started.note)).toContain("pack_status");

    const mid = await run({ action: "pack_status", content_id: started.content_id });
    expect(mid).toMatchObject({
      ok: true, status: "preparing", pack_id: started.pack_id,
      preparation: JSON.parse(JSON.stringify(started.preparation)), writing_source: started.writing_source,
      next_action: started.next_action, poll_after_seconds: 5,
    });
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
    expect(ready.budget).toEqual({ evidence_mode: "host", host_evidence_left: 12, find_evidence_left: 3, repair_rounds_left: expect.any(Number) });
    expect((await readPackFile(started.content_id)).state).toBe("ready");
    // ready 之后就能正常交稿（同一个 pack_id，不必重新领）
    expect((await run(submitArgs(started.content_id, started.pack_id, 1))).status).toBe("accepted_unreviewed");
  });

  it("备料中再 pack 一次：同号返回，绝不起第二条后台任务", async () => {
    const gathering = deferredContext();
    const first = await issue({}, gathering.deps);
    const again = await run(
      { action: "pack", topic_id: first.topicId, platform: "douyin" },
      gathering.deps,
    );
    expect(again).toMatchObject({
      status: "preparing", pack_id: first.pack_id, content_id: first.content_id,
      preparation: JSON.parse(JSON.stringify(first.preparation)), writing_source: first.writing_source,
      next_action: first.next_action, poll_after_seconds: 5,
    });
    expect(gathering.calls()).toBe(1);

    gathering.release();
    await settle(first.content_id);
    // 已经备好之后再 pack 一次：原样还回同一份包，不重跑（备料花的是真钱）
    const third = await run({ action: "pack", topic_id: first.topicId, platform: "douyin" });
    expect(third).toMatchObject({ status: "ready", pack_id: first.pack_id });
    expect(gathering.calls()).toBe(1);
  });

  it("新调研完成后，即使手写角度没变也不能复用旧材料包", async () => {
    const started = await issue({ direction: "从返工经历解释", requirements: "保留这个完整规划" });
    await settle(started.content_id);
    const latest = makeBrief({ revision: 2, summary: "新的调研发现", creativeTask: createCreativeTask({ platform: "douyin", direction: "从返工经历解释", requirements: "保留这个完整规划" }) });
    await saveBrief(started.topicId, latest, testDir);
    await upsertJob({ topicId: started.topicId, status: "succeeded", startedAt: "2026-09-22T00:00:00Z", perspectives: [], briefRevision: 2, topicHash: topicHashOf(TITLE, DESC) }, testDir);
    const result = await run({ action: "pack", topic_id: started.topicId, platform: "douyin" });
    expect(result).toMatchObject({ ok: false, code: "pack_request_changed", next_action: { params: { force: true, requirements: "保留这个完整规划", direction: "从返工经历解释" } } });
    expect((await readPackFile(started.content_id)).briefHash).not.toBe(result.preparation.research.briefHash);
  });

  it("异步备料读到新简报时拒绝把旧准备快照贴到新材料上", async () => {
    const gathering = deferredContext();
    const first = await issue({ direction: "从返工经历解释", requirements: "我的完整规划" }, gathering.deps);
    await saveBrief(first.topicId, makeBrief({ revision: 2, summary: "新简报" }), testDir);
    await upsertJob({ topicId: first.topicId, status: "succeeded", startedAt: "2026-09-22T00:00:00Z", perspectives: [], briefRevision: 2, topicHash: topicHashOf(TITLE, DESC) }, testDir);
    gathering.release();
    const result = await settle(first.content_id);
    expect(result).toMatchObject({ status: "failed", preparation: JSON.parse(JSON.stringify(first.preparation)), writing_source: first.writing_source, next_action: { params: { action: "pack", force: true, requirements: "我的完整规划", direction: "从返工经历解释" } } });
    expect(String(result.error)).toContain("准备状态与实际材料不一致");
    expect((await readPackFile(first.content_id)).context).toBeUndefined();
  });

  it("材料装配后规划变化也停止旧结果，不伪称已按最新规划备好", async () => {
    const changedDuringBuild: typeof buildWritingContext = async (req, dataDir, warn, deps) => {
      const context = await buildWritingContext(req, dataDir, warn, deps);
      await updateTopic(req.topicId!, { description: "刚刚更新的规划" }, dataDir);
      return context;
    };
    const first = await issue({ requirements: "完整规划" }, { buildContextImpl: changedDuringBuild });
    const result = await settle(first.content_id);
    expect(result.status).toBe("failed");
    expect(String(result.error)).toContain("旧准备结果已停止");
  });

  it("force 重来：旧号当场作废，迟到的旧备料不许覆盖新包", async () => {
    const slow = deferredContext();
    const first = await issue({}, slow.deps);
    const firstTask = packPreparation(first.content_id)!;

    const fresh = deferredContext();
    const second = await run(
      { action: "pack", topic_id: first.topicId, platform: "douyin", force: true },
      fresh.deps,
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

  it("本稿用到复盘实验 → 备好后稿件挂到对应假设上，重领不重复挂", async () => {
    await appendHypotheses([{
      id: "hyp-bind", statement: "先给结果的开头完播更高", metricFocus: "completion5s", direction: "up",
      scope: { platform: "douyin" }, contentIds: [], proposedAt: "2026-09-27T00:00:00Z",
      retroRunId: "retro-weekly-2026-09-27T000000", status: "open", nextAction: "前 5 秒先给结果",
    }], testDir);
    await fs.writeFile(path.join(testDir, "editorial-experiments.json"), JSON.stringify({ version: 1, experiments: [{
      id: "exp-hyp-bind", hypothesisId: "hyp-bind", status: "active", platform: "douyin", topicIds: [],
      expiresAt: "2099-01-01T00:00:00Z", observation: "开头流失高", action: "前 5 秒先给结果",
      metricFocus: "completion5s", sourceReport: "retro-weekly-2026-09-27T000000.md",
    }] }));
    const ready = await pack();
    expect(ready.status).toBe("ready");
    await run({ action: "pack", topic_id: ready.topicId, platform: "douyin", force: true });
    await settle(ready.content_id);
    const bound = (await listHypotheses(testDir)).find((h) => h.id === "hyp-bind");
    expect(bound?.contentIds).toEqual([ready.content_id]);
  });

  it("备料炸了 → state failed，人话原因进 pack_status 与稿件，force 能重来", async () => {
    const boom: typeof buildWritingContext = async () => {
      throw new Error("relay 断流：ECONNRESET");
    };
    const started = await issue({}, { buildContextImpl: boom });
    // 宿主模式就地等到了结果：失败也当场说，不先给一个要轮询的 preparing
    expect(started).toMatchObject({ ok: true, status: "failed", synchronous: true, next_action: { params: { action: "pack", force: true } } });
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
    expect(retry).toMatchObject({ status: "ready", synchronous: true });
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

  it("宿主模式 pack 就地备完：直接回 ready（synchronous:true），与 pack_status 同一份回执", async () => {
    const started = await issue();
    expect(started).toMatchObject({ ok: true, status: "ready", synchronous: true, content_id: expect.any(String), pack_id: expect.stringMatching(/^wp-/) });
    expect(String(started.pack_md)).toContain("写作包");
    expect(packPreparation(started.content_id)).toBeUndefined(); // 没有留在后台的任务
    expect(await run({ action: "pack_status", content_id: started.content_id })).toMatchObject({
      status: "ready", pack_id: started.pack_id, pack_md: started.pack_md, budget: started.budget, preparation: started.preparation,
    });
    expect((await run(submitArgs(started.content_id, started.pack_id, 1))).status).toBe("accepted_unreviewed");
  });

  it("preparing 期间第 4 次轮询 → pack_stalled，给出带原请求的 force 重领；备完后照常回 ready", async () => {
    const gathering = deferredContext();
    const started = await issue({ requirements: "保留完整规划" }, gathering.deps);
    for (let i = 1; i <= 3; i += 1) {
      expect(await run({ action: "pack_status", content_id: started.content_id }), `poll ${i}`).toMatchObject({ ok: true, status: "preparing" });
    }
    const stalled = await run({ action: "pack_status", content_id: started.content_id });
    expect(stalled).toMatchObject({
      ok: false, code: "pack_stalled", status: "needs_review", error: "备料超过预期仍未就绪", pack_id: started.pack_id, polls: 4,
      next_action: { tool: "autocrew_writer", params: { action: "pack", force: true, topic_id: started.topicId, platform: "douyin", requirements: "保留完整规划" } },
    });
    expect((await readPackFile(started.content_id)).polls).toBe(4);
    expect(gathering.calls()).toBe(1); // 轮询不会起第二条备料
    gathering.release();
    expect(await settle(started.content_id)).toMatchObject({ status: "ready", pack_id: started.pack_id });
  });

  it("盘上 preparing 却没有任务在跑（进程重启的孤儿）→ pack_status 按原请求重跑，换新号直接备好", async () => {
    const first = await pack({ requirements: "保留完整规划" });
    const orphan = await readPackFile(first.content_id);
    delete orphan.context;
    await fs.writeFile(path.join(testDir, "contents", first.content_id, PACK_JSON), JSON.stringify({ ...orphan, state: "preparing" }));
    expect(packPreparation(first.content_id)).toBeUndefined();

    const status = await run({ action: "pack_status", content_id: first.content_id });
    expect(status).toMatchObject({ ok: true, status: "ready", synchronous: true, restarted: true, content_id: first.content_id });
    expect(status.pack_id).not.toBe(first.pack_id);
    const file = await readPackFile(first.content_id);
    expect(file).toMatchObject({ state: "ready", packId: status.pack_id, host: "local-user" });
    expect(file.context?.req.requirements).toBe("保留完整规划");
    expect(String((await run(submitArgs(first.content_id, first.pack_id, 1))).error)).toContain("写作包已作废");
  });

  it("启动清扫：超 2 分钟的 preparing 标 failed(daemon_restarted)，迟到的备料写回被拒，pack_status 给出重领", async () => {
    const gathering = deferredContext();
    const warnings: string[] = [];
    const started = await issue({}, { ...gathering.deps, onWarn: (m: string) => warnings.push(m) });
    const task = packPreparation(started.content_id)!;
    expect(await failStalePreparingPacks(testDir)).toEqual([]); // 2 分钟内的留给可能还活着的并行进程
    expect(await failStalePreparingPacks(testDir, Date.now() + STALE_PREPARING_MS + 1000)).toEqual([started.content_id]);
    expect(await readPackFile(started.content_id)).toMatchObject({ state: "failed", reason: "daemon_restarted", packId: started.pack_id });

    // 判死之前起的任务这时才备完：结果必须丢掉，不许把包改回 ready
    gathering.release();
    await task;
    const after = await readPackFile(started.content_id);
    expect(after).toMatchObject({ state: "failed", reason: "daemon_restarted" });
    expect(after.context).toBeUndefined();
    expect(warnings.some((w) => w.includes("stale_pack"))).toBe(true);
    expect(String((await getContent(started.content_id, testDir))?.lastError)).toContain("daemon_restarted");
    expect(await run({ action: "pack_status", content_id: started.content_id })).toMatchObject({
      ok: true, status: "failed", reason: "daemon_restarted", next_action: { params: { action: "pack", force: true } },
    });
    expect((await run(submitArgs(started.content_id, started.pack_id, 1))).ok).toBe(false);
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
        { action: "find_evidence", execution: "engine", content_id: res.content_id, pack_id: res.pack_id, need: `返工工时数据 ${n}` },
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
        { action: "find_evidence", execution: "engine", content_id: res.content_id, pack_id: res.pack_id, need: `需求 ${n}` },
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
      { action: "find_evidence", execution: "engine", content_id: res.content_id, pack_id: res.pack_id, need: "返工工时数据" },
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
    expect(await run({ action: "find_evidence", execution: "engine", content_id: res.content_id, pack_id: res.pack_id })).toMatchObject({
      ok: false,
    });
    expect(await run({ action: "find_evidence", execution: "engine", content_id: "content-nope", pack_id: res.pack_id })).toMatchObject({
      ok: false,
    });
    await fs.rm(path.join(testDir, "search.json"));
    const noSearch = await run({
      action: "find_evidence", execution: "engine",
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
  it("MCP 新包把本次要求、手写方向与内容定位完整交给审稿，收稿后保留约定", async () => {
    const requirements = "先讲真实返工场景，再解释维护账；不做工具清单。";
    const direction = "只讲维护成本这件事";
    const industry = "帮助普通运营判断 AI 实操的真实收益";
    await updateProfile({ industry, expressionPersona: "像朋友复盘，不像培训讲师" }, testDir);
    const res = await pack({ requirements, direction });
    const contract = (await readPackFile(res.content_id)).context?.writingContract;
    expect(contract).toBeTruthy();
    const { impl, seen } = reviewLoop([{ verdict: "pass", issues: [] }]);
    const result = await submitAndWait(res.content_id, res.pack_id, 1, {}, { runLoopImpl: impl });
    expect(result.final.status).toBe("accepted");
    expect(seen).toHaveLength(1);
    expect(seen[0].systemPrompt).toContain("创作者规划遵循");
    expect(seen[0].userMessage).toContain(contract!);
    for (const value of [requirements, direction, industry, DESC]) expect(seen[0].userMessage).toContain(value);
    const content = await getContent(res.content_id, testDir);
    expect(content?.genRequest).toBeUndefined();
    expect(content?.writingContract).toBe(contract);
  });

  it("MCP 旧包缺 writingContract 时由 req.direction 恢复审稿依据并持久保存", async () => {
    const direction = "按创作者真实一天的返工经历讲，不改成泛泛科普";
    const res = await pack({ direction });
    const legacy = await readPackFile(res.content_id);
    delete legacy.context!.writingContract;
    await fs.writeFile(path.join(testDir, "contents", res.content_id, PACK_JSON), JSON.stringify(legacy));
    const { impl, seen } = reviewLoop([{ verdict: "pass", issues: [] }]);
    expect((await submitAndWait(res.content_id, res.pack_id, 1, {}, { runLoopImpl: impl })).final.status).toBe("accepted");
    expect(seen[0].systemPrompt).toContain("创作者规划遵循");
    expect(seen[0].userMessage).toContain(direction);
    expect((await getContent(res.content_id, testDir))?.writingContract).toContain(direction);
  });

  it("MCP 旧包的已选立意在收稿后仍进入持久约定，后续改稿不会丢论点与禁区", async () => {
    const res = await pack();
    const legacy = await readPackFile(res.content_id);
    delete legacy.context!.writingContract;
    await fs.writeFile(path.join(testDir, "contents", res.content_id, PACK_JSON), JSON.stringify(legacy));
    const { impl, seen } = reviewLoop([{ verdict: "pass", issues: [] }]);
    expect((await submitAndWait(res.content_id, res.pack_id, 1, {}, { runLoopImpl: impl })).final.status).toBe("accepted");
    const content = await getContent(res.content_id, testDir);
    for (const value of [card().thesis, card().antiScope]) {
      expect(seen[0].userMessage).toContain(value);
      expect(content?.writingContract).toContain(value);
    }
  });

  it("review=none → 当场 accepted_unreviewed（瞬时判断不必转后台），稿件转草稿就绪", async () => {
    const res = await pack();
    const out = await run(submitArgs(res.content_id, res.pack_id, 1));
    expect(out.status).toBe("accepted_unreviewed");
    expect(out).toMatchObject({
      saved: true,
      quality_status: "unreviewed",
      needs_attention: true,
      writing_source: { kind: "host", host: "local-user" },
      next_action: { action: "disclose_review_gap" },
    });
    expect(String(out.human_next_step)).toContain("尚未经过产品审稿");
    expect(String(out.note)).not.toContain("收工");
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

  it("自然完整正文不必硬拆开头和 CTA，空 hashtags 可原样提交", async () => {
    const res = await pack();
    const naturalBody = "我们把返工记录摊在桌上。看完才发现，代码写得快了，回头确认的活依然不少。先把这件事说清楚，下一次才知道哪里值得改。";
    const out = await run(submitArgs(res.content_id, res.pack_id, 1, {
      hook: undefined,
      body: naturalBody,
      cta: undefined,
      hashtags: [],
    }));
    expect(out).toMatchObject({ status: "accepted_unreviewed", saved: true, quality_status: "unreviewed" });
    expect((await getContent(res.content_id, testDir))?.body).toBe(naturalBody);
  });

  it("旧包没有流程快照时回执明确 unknown，不根据有材料追认已完成调研", async () => {
    const res = await pack();
    const legacy = await readPackFile(res.content_id);
    delete legacy.context!.readiness;
    await fs.writeFile(path.join(testDir, "contents", res.content_id, PACK_JSON), JSON.stringify(legacy));
    const out = await run(submitArgs(res.content_id, res.pack_id, 1));
    expect(out.preparation).toMatchObject({
      status: "unknown",
      available_materials: { research_brief: true, selected_angle: true },
    });
    expect((out.preparation as { note: string }).note).toContain("材料存在不等于已完成调研");
  });

  it("旧提交重放与状态查询也显示质量缺口，不保留让宿主直接收工的旧回执", async () => {
    const res = await pack();
    await run(submitArgs(res.content_id, res.pack_id, 1));
    const legacy = await readPackFile(res.content_id);
    delete legacy.context!.readiness;
    legacy.attempts["1"]!.result = {
      status: "accepted_unreviewed",
      content_id: res.content_id,
      review: { status: "skipped", rounds: 0, issues: [] },
      note: "稿子收下了，收工。",
    };
    await fs.writeFile(path.join(testDir, "contents", res.content_id, PACK_JSON), JSON.stringify(legacy));
    const replay = await run(submitArgs(res.content_id, res.pack_id, 1));
    const status = await run({ action: "submit_status", content_id: res.content_id });
    for (const out of [replay, status]) {
      expect(out).toMatchObject({ status: "accepted_unreviewed", saved: true, quality_status: "unreviewed", needs_attention: true, preparation: { status: "unknown" } });
      expect(String(out.note)).not.toContain("收工");
      expect(String(out.human_next_step)).toContain("不代表你已认可");
    }
    expect(replay.replayed).toBe(true);
  });

  it("写作包说明完整正文可直接提交，同时区分保存、AI 审稿与作者认可", async () => {
    const res = await pack();
    expect(String(res.pack_md)).toContain("`body` 可以直接放自然完整的正文");
    expect(String(res.pack_md)).toContain("`hook`、`cta` 可省略或留空");
    expect(String(res.pack_md)).toContain("`hashtags` 可省略或传空数组");
    expect(String(res.pack_md)).toContain("尚不代表创作者认可");
    expect(String(res.pack_md)).not.toContain("稿子收下了，收工");
  });

  it("审稿线没配（引擎读不出来）→ 当场 accepted_unreviewed，不挂一个等不到头的「审稿中」", async () => {
    const res = await pack();
    await fs.rm(path.join(testDir, "engine.json"));
    const out = await run(submitArgs(res.content_id, res.pack_id, 1, { review: "engine" }));
    expect(out.status).toBe("accepted_unreviewed");
    expect(out).toMatchObject({ saved: true, quality_status: "unreviewed", needs_attention: true });
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
    expect(final).toMatchObject({ saved: true, quality_status: "unreviewed", needs_attention: true });
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
    expect(first).toMatchObject({
      saved: true,
      quality_status: "reviewing",
      needs_attention: true,
      next_action: { action: "wait_for_review", params: { action: "submit_status", content_id: res.content_id } },
    });
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
    expect(final).toMatchObject({ saved: true, quality_status: "passed_with_notes", needs_attention: true, audience_review: { status: "unavailable" }, next_action: { action: "present_draft" } });
    expect(String(final.human_next_step)).toContain("不等于你已认可");
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
    expect(one.final).toMatchObject({ saved: true, quality_status: "needs_revision", needs_attention: true, next_action: { action: "revise_and_resubmit" } });
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
    // 真机 2026-09-06：稿已 draft_ready 后宿主重发同一 attempt（同一份正文），要拿回「已收下」的原结果，不是「不收稿」
    const revisedBody = { body: "那天他上线前又通宵了一次，敲字确实快了，回头看的活一点没少。" };
    const again = (await run(submitArgs(res.content_id, res.pack_id, 2, { review: "engine", ...revisedBody }), { runLoopImpl: impl })) as Record<string, any>;
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
    expect(third.final).toMatchObject({ saved: true, quality_status: "issues_remaining", needs_attention: true, next_action: { action: "resolve_review_issues" } });
    expect(String(third.final.note)).toContain("质量未通过");
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
              humanizedText: (await getContent(res.content_id, testDir))!.body,
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

// ─── 写门：令牌是凭据（P6 §3.8） ─────────────────────────────────────────────

describe("写门：令牌是凭据（P6 §3.8）", () => {
  it("pack 把 claim_token 交给认领者；同宿主不带令牌的 submit 被拒，带上就放行", async () => {
    const res = await pack({ _host: "claude-code" });
    expect(res.claim_token).toMatch(/^clm-/);
    expect((await getContent(res.content_id, testDir))?.claim).toMatchObject({ host: "claude-code", token: hashClaimToken(String(res.claim_token)) });

    // 同宿主的另一个会话：手里没令牌 → claim_held，稿子不动
    const denied = await run(submitArgs(res.content_id, res.pack_id, 1, { _host: "claude-code" }));
    expect(denied).toMatchObject({ ok: false, code: "claim_held" });
    expect(String(denied.error)).toContain("同宿主");
    expect(JSON.stringify(denied)).not.toContain(res.claim_token);
    expect((await getContent(res.content_id, testDir))?.pack?.submittedAt).toBeFalsy();

    const passed = await run(submitArgs(res.content_id, res.pack_id, 1, { _host: "claude-code", claim_token: res.claim_token }));
    expect(passed.ok).not.toBe(false);
    expect(passed.claim_token).toBe(res.claim_token);
    expect((await getContent(res.content_id, testDir))?.pack?.submittedAt).toBeTruthy();
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
    await run(submitArgs(res.content_id, res.pack_id, 1, { _host: "codex", claim_token: res.claim_token }));
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


describe("draft feedback re-enters the host writing pack", () => {
  it("reopens the exact submitted draft and injects its feedback without changing the saved body", async () => {
    const first = await pack();
    const submitted = await run(submitArgs(first.content_id, first.pack_id, 1));
    expect(submitted.status).toBe("accepted_unreviewed");
    const before = await getContent(first.content_id, testDir);
    const inspect = await executeEditorial({ action: "inspect", content_id: first.content_id, _dataDir: testDir });
    const feedback = "保留第一段的真实经历，第二段不要突然讲大道理。";
    const captured = await executeEditorial({ action: "feedback", content_id: first.content_id, draft_hash: inspect.draft_hash, event_id: "writer-feedback-reopen", feedback, user_confirmed: true, _dataDir: testDir });
    expect(captured).toMatchObject({ ok: true, status: "recorded" });
    const next = (captured.next_action as { params: Record<string, unknown> }).params;
    const reissued = await run(next);
    expect(reissued).toMatchObject({ ok: true, content_id: first.content_id, status: "ready", synchronous: true });
    expect(reissued.pack_id).not.toBe(first.pack_id);
    const prepared = await settle(first.content_id);
    expect(prepared.status).toBe("ready");
    const newPack = await readPackFile(first.content_id);
    expect(newPack.context?.prompts.user).toContain(feedback);
    expect(newPack.context?.prompts.user).toContain(GOOD.body);
    expect(newPack.context?.writingContract).toContain(feedback);
    const current = await getContent(first.content_id, testDir);
    expect(current?.body).toBe(before?.body);
    expect(current?.status).toBe("drafting");
  });

  it("invalidates a prepared pack when the creator adds more feedback", async () => {
    const first = await pack();
    const inspect = await executeEditorial({ action: "inspect", content_id: first.content_id, _dataDir: testDir });
    await executeEditorial({ action: "feedback", content_id: first.content_id, draft_hash: inspect.draft_hash, event_id: "writer-feedback-invalidates", feedback: "不套营销口号", user_confirmed: true, _dataDir: testDir });
    const stale = await run({ action: "pack", content_id: first.content_id, topic_id: first.topicId, platform: "douyin" });
    expect(stale).toMatchObject({ ok: false, code: "pack_request_changed" });
    expect(String(stale.error)).toContain("修改反馈");
  });

  it("rejects a mismatched explicit draft target instead of guessing a replacement", async () => {
    const first = await pack();
    const other = await seed();
    const wrong = await run({ action: "pack", content_id: first.content_id, topic_id: other.id, platform: "douyin", force: true });
    expect(wrong).toMatchObject({ ok: false });
    expect(String(wrong.error)).toContain("必须属于本次");
    expect((await readPackFile(first.content_id)).packId).toBe(first.pack_id);
  });
});

describe("persisted creative task reaches writing and review", () => {
  it("recovers omitted requirements from the research brief and preserves the original wording", async () => {
    const task = createCreativeTask({ platform: "douyin", requirements: "  写给门店老板\n保留犹豫过程，不要营销口号。  ", direction: "从一次返工经历展开" });
    const topic = await seed(makeBrief({ creativeTask: task }));
    // 调研任务里继承来的方向也要是创始人记下的那一句
    await founderAuthored(testDir, topic.id, task.direction!);
    const started = await run({ action: "pack", topic_id: topic.id, platform: "douyin" });
    expect(started.ok).toBe(true);
    const ready = await settle(started.content_id as string);
    expect(ready.status).toBe("ready");
    const frozen = await readPackFile(started.content_id as string);
    expect(frozen.context?.req.requirements).toBe(task.requirements);
    expect(frozen.context?.req.direction).toBe(task.direction);
    expect(frozen.context?.prompts.user).toContain(task.requirements!.trim());
    expect(frozen.context?.writingContract).toContain(task.requirements);
    expect(frozen.context?.readiness?.creativeTask).toEqual(task);
  });
});


describe("audience review in the host writing flow", () => {
  const audience = { coreStops: false, verdicts: [{ tier: "core", name: "仓管", wouldStop: false, why: "结尾太泛", losesAt: [] }], suggestions: ["把结尾留在具体工作场景"], personaUsed: "仓管" };
  it("默认交稿同时返回真实受众建议，保留同稿任务，不把不满写成通过", async () => {
    await updateProfile({ audiencePersona: { core: { name: "仓管" }, calibratedAt: "2026-09-22" } }, testDir);
    const res = await pack();
    const { impl } = reviewLoop([{ verdict: "pass", issues: [] }]);
    let input: Record<string, unknown> = {};
    const { final } = await submitAndWait(res.content_id, res.pack_id, 1, {}, { runLoopImpl: impl, audienceReviewImpl: async (seen: Record<string, unknown>) => { input = seen; return audience; } });
    expect(final).toMatchObject({ status: "accepted", quality_status: "passed_with_notes", needs_attention: true, audience_review: { status: "reviewed", result: audience } });
    expect(input.body).toBe((await getContent(res.content_id, testDir))?.body);
    expect(input.writingContract).toBe((await readPackFile(res.content_id)).context?.writingContract);
    expect((await run({ action: "submit_status", content_id: res.content_id })).audience_review).toEqual(final.audience_review);
  });
  it("受众点评故障明确缺口；review=none明确未执行", async () => {
    await updateProfile({ audiencePersona: { core: { name: "仓管" }, calibratedAt: "2026-09-22" } }, testDir);
    const res = await pack();
    const { impl } = reviewLoop([{ verdict: "pass", issues: [] }]);
    const { final } = await submitAndWait(res.content_id, res.pack_id, 1, {}, { runLoopImpl: impl, audienceReviewImpl: async () => { throw new Error("受众点评临时不可用"); } });
    expect(final).toMatchObject({ audience_review: { status: "unavailable", reason: "受众点评临时不可用" }, needs_attention: true });
    const next = await pack();
    const noReview = await run(submitArgs(next.content_id, next.pack_id, 1, { review: "none" }));
    expect(noReview).toMatchObject({ audience_review: { status: "skipped" }, quality_status: "unreviewed" });
  });
  it("审稿时编辑器修改正文，迟到结论不覆盖新稿或推进状态", async () => {
    const res = await pack();
    const held = heldReviewLoop([{ verdict: "pass", issues: [] }]);
    await run(submitArgs(res.content_id, res.pack_id, 1, { review: "engine" }), { runLoopImpl: held.impl });
    await updateContent(res.content_id, { body: "用户在编辑器改过的新正文" }, testDir);
    held.release();
    await reviewInFlight(res.content_id);
    expect(await run({ action: "submit_status", content_id: res.content_id })).toMatchObject({ quality_status: "stale_review", needs_attention: true });
    expect(await getContent(res.content_id, testDir)).toMatchObject({ body: "用户在编辑器改过的新正文", status: "drafting" });
  });
});

describe("provided materials do not inherit stale research", () => {
  it("can refresh from explicit materials after the topic changes without mixing the old brief", async () => {
    const first = await pack({ direction: "从返工经历展开" });
    await updateTopic(first.topicId, { description: "换成门店自己的复盘" }, testDir);
    const next = await run({ action: "pack", topic_id: first.topicId, platform: "douyin", force: true, research_mode: "provided", research: "门店主理人的口述经历", direction: "从返工经历展开" });
    expect(next.ok).toBe(true);
    const ready = await settle(first.content_id);
    expect(ready.status).toBe("ready");
    const frozen = await readPackFile(first.content_id);
    expect(frozen.briefHash).toBe("");
    expect(frozen.context?.researchSlot).toContain("门店主理人的口述经历");
    expect(frozen.context?.readiness?.research.autoResearched).toBe(false);
  });
});
