/**
 * generate-script-evidence.test.ts — P1b 接进生产管线的那一刀（spec §3.3 / §4.2 / §4.4）。
 *
 * 骨架同 generate-script-angle.test.ts（全 mock、零网络、零真睡）。验六件事：
 * 1. 定向补证**只**为选中的 v3 卡跑：手写 direction、明说跳过、v2 卡、无卡都不跑；
 * 2. 账本在写手开工**之前**就落了盘——中途崩掉也留得住「这稿手上有哪些证据」；
 * 3. 数字硬门耗尽修复轮 → 稿件落 `needs_evidence`，不是 `draft_ready`；
 * 4. 有据的数字照常转正；
 * 5. `needs_evidence` 稿可以就地重写（不新建卡）；
 * 6. 回合预算按 `4 + 查证额度 + 修复轮×2`，与包有没有 gate 无关；跳过角度的原话进结构化 run-log。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateScript, retryGenerateScript } from "./generate-script.js";
import type { GeneratedScript } from "./generate-script.js";
import { BRIEF_SCHEMA_VERSION, saveBrief, type AngleCard, type ResearchBrief } from "../research/brief-store.js";
import { pendingPerspectives, topicHashOf, upsertJob, type ResearchJob } from "../research/research-job-store.js";
import { saveSearchConfig } from "../research/search-provider.js";
import { getContent, saveTopic, updateTopic, type Topic } from "../../storage/local-store.js";
import type { LoopOptions, LoopResult, LoopTool } from "../../engine/loop.js";
import type { EngineConfig } from "../../engine/config.js";

let testDir: string;
const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-genscript-evidence-"));
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

// ─── 夹具 ────────────────────────────────────────────────────────────────────

const TOPIC_TITLE = "AI 编程助手横评";
const TOPIC_DESC = "对比主流工具的真实提效";
const TEST_REQ = { topic: TOPIC_TITLE, platform: "douyin" as const };

/** 不含任何数字的稿：数字硬门对它没有意见 */
const CLEAN_PAYLOAD = {
  title: "AI 编程助手值不值",
  hook: "厂商说能提效，我实测下来差得远",
  body: "差距出在任务类型上：重构类几乎没用，样板代码确实快。",
  cta: "关注我，下周拆解实测方法",
  hashtags: ["#AI编程"],
};

/** 正文里凭空多了一个数——账本里没有这个数 */
const BOGUS_NUMBER_PAYLOAD = { ...CLEAN_PAYLOAD, body: "实测下来，一年能省下 4200 万美元的工程成本。" };

/** 引文里那个数（简报证据），写进正文就该放行 */
const GROUNDED_NUMBER_PAYLOAD = { ...CLEAN_PAYLOAD, body: "受控实验里平均完成时间只缩短了 12%。" };

const V3_CARD: AngleCard = {
  cardVersion: 3,
  id: "angle-1",
  angle: "算一笔维护账",
  thesis: "省下的编码时间被维护成本吃回去了",
  evidenceLevel: "grounded",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不写工具横评",
  hookDraft: "账没算完。",
  primaryPersona: "trust",
  misconception: "以为提效数字等于净收益",
  mechanism: "省下的时间落在写代码那一步，维护成本落在读代码那一步，两笔账不在同一个人身上",
  payoff: "看完你知道该拿哪个数字去跟老板谈",
  nextAction: "把上周的返工工时也记进提效表",
  counterResponse: "有人说熟练了就好——熟练降低的是写的成本，不是读的成本",
  personaGains: { grow: "听懂提效数字的水分", trust: "拿到一份能复算的账", convert: "知道落地时该盯哪一项" },
  elements: ["痛点→理想状态", "新奇点"],
  evidenceNeeds: ["一个企业公开披露的 AI 编码维护成本数字"],
  structure: "claim-case-claim",
};

const V2_CARD: AngleCard = {
  id: "angle-2",
  angle: "算一笔维护账",
  thesis: "翻车集中在重构类任务",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不做成本测算",
  audiencePain: "老板拿提效数字压 KPI",
  holdTrigger: "看到自己上周那笔返工账",
  hookDraft: "账没算完。",
};

function makeBrief(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "厂商口径与独立评测差了四倍。",
    perspectives: [],
    tensions: ["厂商宣称提效很多，独立评测测到的少得多"],
    angleSuggestions: [],
    angleCards: [V3_CARD, V2_CARD],
    evidence: [
      {
        claim: "独立评测的提效幅度远低于厂商口径",
        quote: "在受控实验中，参与者平均完成时间缩短约 12%。",
        sourceUrl: "https://www.example.com/study/1",
      },
    ],
    assetPicks: [],
    missingPerspectives: [],
    gaps: [],
    generatedAt: "2026-08-24T10:00:00.000Z",
    revision: 1,
    topicHash: topicHashOf(TOPIC_TITLE, TOPIC_DESC),
    ...over,
  };
}

async function seedResearched(brief = makeBrief()): Promise<Topic> {
  const topic = await saveTopic({ title: TOPIC_TITLE, description: TOPIC_DESC, tags: [] }, testDir);
  await saveBrief(topic.id, brief, testDir);
  const job: ResearchJob = {
    topicId: topic.id,
    status: "succeeded",
    startedAt: "2026-08-24T09:00:00.000Z",
    settledAt: "2026-08-24T10:00:00.000Z",
    perspectives: pendingPerspectives(),
    briefRevision: brief.revision,
    topicHash: topicHashOf(TOPIC_TITLE, TOPIC_DESC),
  };
  await upsertJob(job, testDir);
  return topic;
}

async function pick(topicId: string, card: AngleCard): Promise<void> {
  await updateTopic(
    topicId,
    { selectedAngle: { briefRevision: 1, angleId: card.id, card, selectedAt: "2026-08-24T11:00:00.000Z" } },
    testDir,
  );
}

const nameOf = (t: LoopTool) => t.name;
const roleOf = (opts: LoopOptions): "writer" | "reviser" | "targeted" | "reviewer" => {
  const names = (opts.tools ?? []).map(nameOf);
  if (names.includes("submit_evidence")) return "targeted";
  if (names.includes("submit_review")) return "reviewer";
  return (opts.logMeta?.agent as "writer" | "reviser") ?? "writer";
};

interface Seen {
  writer: LoopOptions[];
  targeted: LoopOptions[];
  /** 写手开工那一刻磁盘上的稿件（验「账本先落盘」） */
  atWriterStart?: Awaited<ReturnType<typeof getContent>>;
}

/**
 * 剧本化 loop 替身：写手轮按 `payloads` 逐份提交；补证轮/审稿轮一律不出手
 * （补证按「没找到」记账，审稿按「未经 AI 审稿」降级）——本文件的断言都不落在它们的产出上。
 */
function makeLoop(payloads: Array<Record<string, unknown>>, seen: Seen, contentIdRef: { id?: string }) {
  return async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    const role = roleOf(opts);
    if (role === "targeted") {
      seen.targeted.push(opts);
      return { finalMessage: "", turns: 1, totalTokens: 0, toolCallCount: 0, stopReason: "no_tool_calls" };
    }
    if (role === "reviewer") {
      return { finalMessage: "", turns: 1, totalTokens: 0, toolCallCount: 0, stopReason: "no_tool_calls" };
    }
    seen.writer.push(opts);
    if (seen.atWriterStart === undefined && contentIdRef.id) {
      seen.atWriterStart = await getContent(contentIdRef.id, testDir);
    }
    const submit = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
    for (const p of payloads) await submit.execute(p);
    return { finalMessage: "ok", turns: 2, totalTokens: 100, toolCallCount: payloads.length, stopReason: "no_tool_calls" };
  };
}

/** 跑一稿。`contentIdRef` 让替身在写手开工那一刻能回头读磁盘上的占位稿 */
async function write(
  req: Parameters<typeof generateScript>[0],
  payloads: Array<Record<string, unknown>> = [CLEAN_PAYLOAD],
): Promise<{ res: GeneratedScript; seen: Seen; warns: string[] }> {
  const seen: Seen = { writer: [], targeted: [] };
  const ref: { id?: string } = {};
  const warns: string[] = [];
  const res = await generateScript(req, testDir, {
    runLoopImpl: makeLoop(payloads, seen, ref),
    onWarn: (m) => warns.push(m),
  });
  ref.id = res.contentId;
  return { res, seen, warns };
}

/** 搜索配好 = 补证与 find_evidence 都可用（未配是另一条分支，单独验） */
async function configureSearch(): Promise<void> {
  await saveSearchConfig({ provider: "bocha", apiKey: "sk-search" }, testDir);
}

// ─── 1. 定向补证的触发条件（§4.2 调用点） ────────────────────────────────────

describe("定向补证只为选中的 v3 卡跑", () => {
  it("选了 v3 卡 → 按卡上的 evidenceNeeds 跑一轮补证，写手也拿到 find_evidence", async () => {
    await configureSearch();
    const topic = await seedResearched();
    await pick(topic.id, V3_CARD);

    const { seen } = await write({ ...TEST_REQ, topicId: topic.id });

    expect(seen.targeted).toHaveLength(1);
    expect(seen.targeted[0].userMessage).toContain(V3_CARD.evidenceNeeds[0]);
    expect((seen.writer[0].tools ?? []).map(nameOf)).toEqual(["submit_script", "find_evidence"]);
  });

  it("选了 v2 卡 → 不补证（v2 卡没有「这个主张缺什么证据」这个字段）", async () => {
    await configureSearch();
    const topic = await seedResearched();
    await pick(topic.id, V2_CARD);

    const { seen } = await write({ ...TEST_REQ, topicId: topic.id });
    expect(seen.targeted).toHaveLength(0);
  });

  it("手写 direction 压过选中卡 → 不补证（角度是创始人自己定的）", async () => {
    await configureSearch();
    const topic = await seedResearched();
    await pick(topic.id, V3_CARD);

    const { seen } = await write({ ...TEST_REQ, topicId: topic.id, direction: "就写我自己那次翻车" });
    expect(seen.targeted).toHaveLength(0);
  });

  it("明说跳过角度点选 → 不补证，原话进结构化 run-log（不只是一句 warn）", async () => {
    await configureSearch();
    const topic = await seedResearched();

    const { seen, warns } = await write({
      ...TEST_REQ,
      topicId: topic.id,
      angleSkipReason: "这条我心里有数，先写了再说",
    });
    expect(seen.targeted).toHaveLength(0);
    expect(seen.writer[0].logMeta?.angleSkipReason).toBe("这条我心里有数，先写了再说");
    expect(warns.some((w) => w.includes("跳过角度点选"))).toBe(true);
  });

  it("压根没有选题 → 整条补证链不参与，写手也没有 find_evidence", async () => {
    await configureSearch();
    const { seen } = await write(TEST_REQ);
    expect(seen.targeted).toHaveLength(0);
    // 搜索配好了就给写手查证工具：写到一半缺个数据是所有稿都会遇到的事
    expect((seen.writer[0].tools ?? []).map(nameOf)).toEqual(["submit_script", "find_evidence"]);
  });

  it("搜索未配置 → warn + 跳过补证 + 版本注记「未补证」，写手没有查证工具（§5）", async () => {
    const topic = await seedResearched();
    await pick(topic.id, V3_CARD);

    const { res, seen, warns } = await write({ ...TEST_REQ, topicId: topic.id });
    expect(seen.targeted).toHaveLength(0);
    expect((seen.writer[0].tools ?? []).map(nameOf)).toEqual(["submit_script"]);
    expect(warns.some((w) => w.includes("搜索未配置"))).toBe(true);
    const saved = await getContent(res.contentId, testDir);
    expect(saved!.versions?.at(-1)?.note).toContain("未补证");
  });
});

// ─── 2. 账本先落盘（§3.3 / codex #15） ───────────────────────────────────────

describe("账本在写手开工之前就落盘", () => {
  it("写手拿到工具那一刻，磁盘上的占位稿已经带着账本与角度归因", async () => {
    await configureSearch();
    const topic = await seedResearched();
    await pick(topic.id, V3_CARD);

    const seen: Seen = { writer: [], targeted: [] };
    const ref: { id?: string } = {};
    // 占位稿 id 在 generateScript 返回前拿不到——用 listContents 之外的办法：
    // 替身第一次被叫到写手轮时，磁盘上只有这一篇 drafting 稿
    const impl = makeLoop([CLEAN_PAYLOAD], seen, ref);
    await generateScript({ ...TEST_REQ, topicId: topic.id }, testDir, {
      runLoopImpl: async (cfg, opts) => {
        if (roleOf(opts) === "writer" && !ref.id) {
          const dirs = await fs.readdir(path.join(testDir, "contents"));
          ref.id = dirs[0];
        }
        return impl(cfg, opts);
      },
    });

    const atStart = seen.atWriterStart!;
    expect(atStart).not.toBeNull();
    expect(atStart!.status).toBe("drafting"); // 还没转正
    expect(atStart!.evidenceLedger).toBeDefined();
    // 简报证据 ev-1 已经在账本里；补证那一条查空了但留了痕
    expect(atStart!.evidenceLedger!.entries.map((e) => e.id)).toContain("ev-1");
    expect(atStart!.evidenceLedger!.lookups.map((l) => l.need)).toEqual(V3_CARD.evidenceNeeds);
    expect(atStart!.usedAngle).toEqual({ id: "angle-1", cardVersion: 3, hash: expect.any(String) });
  });
});

// ─── 3/4. 硬门与状态（§4.4 / §5） ────────────────────────────────────────────

describe("数字硬门 → needs_evidence", () => {
  it("修复轮耗尽仍有无据数字 → 稿件落 needs_evidence，正文与清单都留下", async () => {
    const topic = await seedResearched();
    await pick(topic.id, V3_CARD);

    // 三稿都带同一个凭空的数：默认修复轮 2 轮，第三稿耗尽
    const { res, warns } = await write({ ...TEST_REQ, topicId: topic.id }, [
      BOGUS_NUMBER_PAYLOAD,
      BOGUS_NUMBER_PAYLOAD,
      BOGUS_NUMBER_PAYLOAD,
    ]);

    expect(res.needsEvidence).toBe(true);
    expect(res.blockedReason).toContain("4200");
    const saved = await getContent(res.contentId, testDir);
    expect(saved!.status).toBe("needs_evidence");
    expect(saved!.body).toContain("4200");
    expect(saved!.blockedReason).toBeTruthy();
    expect(saved!.unverifiedNumbers.length).toBeGreaterThan(0);
    // 没成的稿不盖「稿成」戳
    expect(saved!.draftReadyAt).toBeUndefined();
    expect(warns.some((w) => w.includes("硬门拦下"))).toBe(true);
  });

  it("被拦的稿不进审稿轮——审一篇不能发的稿是浪费", async () => {
    const topic = await seedResearched();
    await pick(topic.id, V3_CARD);
    const seen: Seen = { writer: [], targeted: [] };
    let reviewerCalls = 0;
    await generateScript({ ...TEST_REQ, topicId: topic.id }, testDir, {
      runLoopImpl: async (cfg, opts) => {
        if (roleOf(opts) === "reviewer") reviewerCalls += 1;
        return makeLoop([BOGUS_NUMBER_PAYLOAD, BOGUS_NUMBER_PAYLOAD, BOGUS_NUMBER_PAYLOAD], seen, {})(cfg, opts);
      },
      onWarn: () => {},
    });
    expect(reviewerCalls).toBe(0);
  });

  it("数字有据（简报引文里的 12%）→ 照常转正 draft_ready", async () => {
    const topic = await seedResearched();
    await pick(topic.id, V3_CARD);

    const { res } = await write({ ...TEST_REQ, topicId: topic.id }, [GROUNDED_NUMBER_PAYLOAD]);

    expect(res.needsEvidence).toBe(false);
    const saved = await getContent(res.contentId, testDir);
    expect(saved!.status).toBe("draft_ready");
    expect(saved!.draftReadyAt).toBeTruthy();
    expect(saved!.blockedReason).toBeNull();
  });

  it("第二稿把数字删了 → 硬门放行，稿件照常转正（打回通道是活的）", async () => {
    const topic = await seedResearched();
    await pick(topic.id, V3_CARD);

    const { res } = await write({ ...TEST_REQ, topicId: topic.id }, [BOGUS_NUMBER_PAYLOAD, CLEAN_PAYLOAD]);

    expect(res.needsEvidence).toBe(false);
    const saved = await getContent(res.contentId, testDir);
    expect(saved!.status).toBe("draft_ready");
  });

  it("镜头标注（口播格式硬门）同样拦到 needs_evidence 那条路上", async () => {
    const marked = { ...CLEAN_PAYLOAD, body: "[画面] 一张对比表\n[口播] 差距出在任务类型上。" };
    const { res } = await write(TEST_REQ, [marked, marked, marked]);
    expect(res.needsEvidence).toBe(true);
    expect(res.blockedReason).toContain("口播格式硬门");
    const saved = await getContent(res.contentId, testDir);
    expect(saved!.status).toBe("needs_evidence");
  });
});

// ─── 5. 从 needs_evidence 重写 ───────────────────────────────────────────────

describe("缺证据稿可以就地重写", () => {
  it("retryGenerateScript 认 needs_evidence：不新建卡，状态退回 drafting 再转正", async () => {
    const topic = await seedResearched();
    await pick(topic.id, V3_CARD);
    const first = await write({ ...TEST_REQ, topicId: topic.id }, [
      BOGUS_NUMBER_PAYLOAD,
      BOGUS_NUMBER_PAYLOAD,
      BOGUS_NUMBER_PAYLOAD,
    ]);
    expect((await getContent(first.res.contentId, testDir))!.status).toBe("needs_evidence");

    const seen: Seen = { writer: [], targeted: [] };
    const started = await retryGenerateScript(first.res.contentId, testDir, {
      runLoopImpl: makeLoop([CLEAN_PAYLOAD], seen, {}),
    });
    await started.completion;

    expect(started.contentId).toBe(first.res.contentId); // 同一张卡
    const after = await getContent(first.res.contentId, testDir);
    expect(after!.status).toBe("draft_ready");
    expect(after!.blockedReason).toBeNull();
    expect(after!.unverifiedNumbers).toEqual([]);
    const all = await fs.readdir(path.join(testDir, "contents"));
    expect(all).toHaveLength(1);
  });

  it("既没中断也不缺证据的好稿仍然拒绝重写", async () => {
    const { res } = await write(TEST_REQ);
    await expect(retryGenerateScript(res.contentId, testDir)).rejects.toThrow("没有中断记录");
  });
});

// ─── 6. 回合预算 ─────────────────────────────────────────────────────────────

describe("写手回合预算 = 4 + 查证额度 + 修复轮×2", () => {
  it("抖音包没有 gate，回合数照样按公式给（codex #12）", async () => {
    const { seen } = await write(TEST_REQ);
    expect(seen.writer[0].maxTurns).toBe(4 + 3 + 2 * 2);
  });

  it("公众号包有 gate（修复轮 2）→ 同一个公式，同一个数", async () => {
    const { seen } = await write({ topic: TOPIC_TITLE, platform: "wechat_mp" as const }, [
      { ...CLEAN_PAYLOAD, body: `${CLEAN_PAYLOAD.body}${"字".repeat(1600)}` },
    ]);
    expect(seen.writer[0].maxTurns).toBe(4 + 3 + 2 * 2);
  });
});

// ─── 7. 整稿墙钟 ─────────────────────────────────────────────────────────────

describe("整稿墙钟（§4.4）", () => {
  it("到点即作废：占位稿标〔生成中断〕+ lastError，可点重新生成", async () => {
    const slow = async (_cfg: EngineConfig, _opts: LoopOptions): Promise<LoopResult> =>
      new Promise((resolve) => setTimeout(resolve, 300));

    await expect(
      generateScript(TEST_REQ, testDir, { runLoopImpl: slow, wallClockMs: 20, onWarn: () => {} }),
    ).rejects.toThrow("整稿墙钟");

    const dirs = await fs.readdir(path.join(testDir, "contents"));
    const stuck = await getContent(dirs[0], testDir);
    expect(stuck!.title).toContain("［生成中断］");
    expect(stuck!.lastError).toContain("整稿墙钟");
  });
});
