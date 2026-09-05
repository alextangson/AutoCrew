/**
 * generate-script-brief.test.ts — 调研简报注入统一入口（深调研 spec §6）。
 *
 * 骨架同 generate-script-patterns.test.ts（全 mock、零网络）。这里验四件事：
 * 1. 注入点唯一：三条写稿入口共用 runGeneration，产出的简报块逐字相同；
 * 2. 预算表：简报优先占 research 槽，知识库吃剩余，剩余不足 400 整块省略；
 * 3. 无简报路径与改动前**逐字一致**（快照对比，不是"看起来差不多"）；
 * 4. 归因 usedBriefRevision 落 run-log 元数据与稿件元数据，空则不写字段。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateScript, startGenerateScript } from "./generate-script.js";
import { executeGenerate } from "../../tools/generate.js";
import {
  BRIEF_BLOCK_END,
  BRIEF_BLOCK_START,
  BRIEF_BUDGET,
  RESEARCH_SLOT_BUDGET,
} from "../research/brief-inject.js";
import { BRIEF_SCHEMA_VERSION, briefPath, saveBrief, type ResearchBrief } from "../research/brief-store.js";
import { briefHash } from "../research/brief-snapshot.js";
import {
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type ResearchJob,
  type ResearchJobStatus,
} from "../research/research-job-store.js";
import { getContent, saveTopic, type Topic } from "../../storage/local-store.js";
import type { LoopResult, LoopOptions } from "../../engine/loop.js";
import type { EngineConfig } from "../../engine/config.js";

let testDir: string;

const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-genscript-brief-"));
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

const GOOD_PAYLOAD = {
  title: "AI 编程助手值不值",
  hook: "厂商说能提效，实测差得远",
  body: "把这些数字摆在一起看，差距出在任务类型上",
  cta: "关注我，下周拆解实测方法",
  hashtags: ["#AI编程"],
};

const TOPIC_TITLE = "AI 编程助手横评";
const TOPIC_DESC = "对比 5 个主流工具的真实提效";
const TEST_REQ = { topic: TOPIC_TITLE, platform: "douyin" as const };

/**
 * 写稿收束后还有一轮 AI 审稿（script-review）走同一个注入口，工具带是 submit_review——
 * 替身不出手，审稿按「未经 AI 审稿」降级，写稿轮的注入/归因断言与改动前逐字一致。
 */
const REVIEW_ABSTAIN: LoopResult = {
  finalMessage: "审稿替身不出手",
  turns: 1,
  totalTokens: 0,
  toolCallCount: 0,
  stopReason: "no_tool_calls",
};

/** 捕获 loop 入参：注入面（userMessage/systemPrompt）与归因面（logMeta）都在这上面验 */
function capturingLoop(seen: { opts?: LoopOptions }) {
  return async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    if (!(opts.tools ?? []).some((t) => t.name === "submit_script")) return REVIEW_ABSTAIN;
    seen.opts = opts;
    const tool = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
    await tool.execute(GOOD_PAYLOAD);
    return { finalMessage: "ok", turns: 2, totalTokens: 100, toolCallCount: 1, stopReason: "no_tool_calls" };
  };
}

// ─── 夹具 ────────────────────────────────────────────────────────────────────

function makeBrief(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "厂商口径与独立评测差了四倍，差距集中在重构类任务上。",
    perspectives: [],
    tensions: ["厂商宣称提效 55%，独立评测只测到 12%"],
    angleSuggestions: ["从一线开发者的实际工时切入"],
    evidence: [
      {
        claim: "独立评测的提效幅度远低于厂商口径",
        quote: "在受控实验中，参与者平均完成时间缩短约 12%。",
        sourceUrl: "https://www.example.com/study/1",
      },
    ],
    assetPicks: [],
    missingPerspectives: [],
    gaps: ["缺 2026 年国内团队的采纳率数据"],
    generatedAt: "2026-07-26T10:00:00.000Z",
    revision: 1,
    topicHash: topicHashOf(TOPIC_TITLE, TOPIC_DESC),
    ...over,
  };
}

/** 各字段都溢出的巨型简报：渲染后必然撞上 2800 硬顶，用于验「简报优先占预算」 */
function hugeBrief(): ResearchBrief {
  return makeBrief({
    summary: "摘".repeat(2000),
    tensions: ["张".repeat(600), "力".repeat(600), "点".repeat(600)],
    angleSuggestions: ["角".repeat(600), "度".repeat(600), "三".repeat(600)],
    evidence: Array.from({ length: 20 }, (_, i) => ({
      claim: `主张${i}`.repeat(200),
      quote: "引".repeat(800),
      sourceUrl: `https://news.example${i}.com/a/b`,
    })),
    gaps: Array.from({ length: 20 }, () => "缺".repeat(200)),
  });
}

async function seedTopic(): Promise<Topic> {
  return saveTopic({ title: TOPIC_TITLE, description: TOPIC_DESC, tags: [] }, testDir);
}

async function seedJob(topicId: string, over: Partial<ResearchJob> = {}): Promise<ResearchJob> {
  const job: ResearchJob = {
    topicId,
    status: "succeeded" as ResearchJobStatus,
    startedAt: "2026-07-26T09:00:00.000Z",
    settledAt: "2026-07-26T10:00:00.000Z",
    perspectives: pendingPerspectives(),
    briefRevision: 1,
    topicHash: topicHashOf(TOPIC_TITLE, TOPIC_DESC),
    ...over,
  };
  return upsertJob(job, testDir);
}

/** 选题 + 简报 + 指向该简报的 job：写稿时应当注入 */
async function seedResearched(brief = makeBrief()): Promise<{ topic: Topic; brief: ResearchBrief }> {
  const topic = await seedTopic();
  await saveBrief(topic.id, brief, testDir);
  await seedJob(topic.id, { briefRevision: brief.revision });
  return { topic, brief };
}

const KNOWLEDGE_FILE = "AI编程助手实测笔记.md";

async function seedKnowledge(chars = 5000): Promise<void> {
  await fs.mkdir(path.join(testDir, "knowledge"), { recursive: true });
  await fs.writeFile(path.join(testDir, "knowledge", KNOWLEDGE_FILE), "字".repeat(chars));
}

function briefBlockOf(userMessage: string): string {
  const start = userMessage.indexOf(BRIEF_BLOCK_START);
  if (start < 0) return "";
  const end = userMessage.indexOf(BRIEF_BLOCK_END, start);
  return userMessage.slice(start, end + BRIEF_BLOCK_END.length);
}

/** research 槽里的知识片段（槽内最后一段，到「目标平台」前为止） */
function knowledgeChunk(userMessage: string): string {
  const start = userMessage.indexOf("【知识库参考】");
  if (start < 0) return "";
  const end = userMessage.indexOf("\n\n目标平台：", start);
  return userMessage.slice(start, end < 0 ? undefined : end);
}

// ─── 注入与预算 ──────────────────────────────────────────────────────────────

describe("简报注入 × research 槽预算（§6）", () => {
  it("有简报 → prompt 带定界块（≤2800），简报排在用户材料之前（P1 §4.3 优先级表）", async () => {
    const { topic } = await seedResearched();
    const seen: { opts?: LoopOptions } = {};

    await generateScript(
      { ...TEST_REQ, topicId: topic.id, research: "创始人自己给的一段材料" },
      testDir,
      { runLoopImpl: capturingLoop(seen) },
    );

    const msg = seen.opts!.userMessage;
    expect(msg).toContain(BRIEF_BLOCK_START);
    expect(msg).toContain(BRIEF_BLOCK_END);
    expect(msg).toContain("厂商宣称提效 55%");
    expect(msg).toContain("来源：example.com");
    expect(briefBlockOf(msg).length).toBeLessThanOrEqual(BRIEF_BUDGET);
    // P1 §4.3 换了排序：本稿专属的材料（核心证据 → 简报）在前，创始人贴的材料排第 4 档。
    // 改动前是「用户材料永远第一」，那条规则在四样新材料挤进同一个槽之后不再成立——
    // 谁被挤掉必须由预算表决定，不能由 join 的先后顺序碰运气。
    expect(msg.indexOf(BRIEF_BLOCK_START)).toBeLessThan(msg.indexOf("创始人自己给的一段材料"));
  });

  it("总槽 12000 之后简报不再挤掉知识库：简报占满 2800，知识库照拿自己的默认 2000", async () => {
    const { topic } = await seedResearched(hugeBrief());
    await seedKnowledge();
    const seen: { opts?: LoopOptions } = {};

    await generateScript({ ...TEST_REQ, topicId: topic.id }, testDir, {
      runLoopImpl: capturingLoop(seen),
    });

    const msg = seen.opts!.userMessage;
    // 简报块撞上硬顶（含块尾说明行，比提取出的定界段略长）
    expect(briefBlockOf(msg).length).toBeLessThanOrEqual(BRIEF_BUDGET);
    // 改动前是 4000-2800=1200：老槽只有 4000，简报吃掉 2800 之后知识库只剩零头。
    // §4.3 把总槽提到 12000，知识库回到「取自己的默认上限与剩余的较小者」。
    expect(knowledgeChunk(msg)).toBe(`【知识库参考】\n《${KNOWLEDGE_FILE}》：${"字".repeat(2000)}`);
  });

  it("无简报时知识库拿的是自己的默认预算（2000）——对照组", async () => {
    await seedKnowledge();
    const seen: { opts?: LoopOptions } = {};

    await generateScript(TEST_REQ, testDir, { runLoopImpl: capturingLoop(seen) });

    expect(knowledgeChunk(seen.opts!.userMessage)).toBe(
      `【知识库参考】\n《${KNOWLEDGE_FILE}》：${"字".repeat(2000)}`,
    );
  });

  it("用户材料撞上 2000 的档位上限被截断，简报与知识库照留（§4.3 第 4 档）", async () => {
    const { topic } = await seedResearched(hugeBrief());
    await seedKnowledge();
    const seen: { opts?: LoopOptions } = {};

    await generateScript(
      { ...TEST_REQ, topicId: topic.id, research: `用户材料${"料".repeat(3000)}` },
      testDir,
      { runLoopImpl: capturingLoop(seen) },
    );

    const msg = seen.opts!.userMessage;
    expect(msg).toContain(BRIEF_BLOCK_START);
    // 3004 字的用户材料只进得去 2000 字：档位上限是硬的，不许一段材料吃光整个槽
    expect(msg).toContain(`用户材料${"料".repeat(1996)}`);
    expect(msg).not.toContain(`用户材料${"料".repeat(1997)}`);
    // 「剩余不足 400 就整块省略知识库」这条规则改到装配层单测里锁（input-budget.test.ts）——
    // 总槽 12000 之后，靠一段用户材料已经撑不到那个边界了
    expect(msg).toContain("知识库参考");
  });

  it("简报过期（选题改过）→ 照注入但块首标注", async () => {
    const topic = await seedTopic();
    const stale = makeBrief({ topicHash: topicHashOf("旧标题", "旧描述") });
    await saveBrief(topic.id, stale, testDir);
    await seedJob(topic.id);
    const seen: { opts?: LoopOptions } = {};

    await generateScript({ ...TEST_REQ, topicId: topic.id }, testDir, {
      runLoopImpl: capturingLoop(seen),
    });

    const msg = seen.opts!.userMessage;
    expect(msg).toContain("本简报基于旧版选题，采信时注意");
    expect(msg).toContain("厂商宣称提效 55%"); // 材料照给，不因过期就扣下
  });

  it("tensions 为空数组 → 张力点小节省略，块其余部分照常", async () => {
    const { topic } = await seedResearched(makeBrief({ tensions: [] }));
    const seen: { opts?: LoopOptions } = {};

    await generateScript({ ...TEST_REQ, topicId: topic.id }, testDir, {
      runLoopImpl: capturingLoop(seen),
    });

    const block = briefBlockOf(seen.opts!.userMessage);
    expect(block).not.toContain("【跨视角张力点】");
    expect(block).toContain("【摘要】");
  });
});

// ─── 无简报：与现状逐字一致 ──────────────────────────────────────────────────

describe("无简报路径 — 与改动前逐字一致", () => {
  /** 基线：不带 topicId 的请求，走的就是改动前那条路 */
  async function promptOf(
    req: Parameters<typeof generateScript>[0],
    deps: { onWarn?: (m: string) => void } = {},
  ): Promise<{ system: string; user: string }> {
    const seen: { opts?: LoopOptions } = {};
    await generateScript(req, testDir, { runLoopImpl: capturingLoop(seen), ...deps });
    return { system: seen.opts!.systemPrompt, user: seen.opts!.userMessage };
  }

  it("无 topicId / 无 job / 无 briefRevision 指针 → prompt 与基线一字不差", async () => {
    const baseline = await promptOf(TEST_REQ);

    const topic = await seedTopic();
    await saveBrief(topic.id, makeBrief(), testDir); // 盘上有简报，但没有指针指向它
    expect(await promptOf({ ...TEST_REQ, topicId: topic.id })).toEqual(baseline);

    // job 在跑但还没出简报：briefRevision 缺省 = 没有当前有效简报
    await seedJob(topic.id, { status: "running", briefRevision: undefined, settledAt: undefined });
    expect(await promptOf({ ...TEST_REQ, topicId: topic.id })).toEqual(baseline);
  });

  it("指针指向的简报文件不存在 → 静默空态（不告警），prompt 与基线一致", async () => {
    const baseline = await promptOf(TEST_REQ);
    const topic = await seedTopic();
    await seedJob(topic.id, { briefRevision: 7 });

    const warns: string[] = [];
    expect(await promptOf({ ...TEST_REQ, topicId: topic.id }, { onWarn: (m) => warns.push(m) })).toEqual(
      baseline,
    );
    // 简报侧一条都不许告警（审稿替身不出手会自报「未经 AI 审稿」，那是另一条链路的留痕）
    expect(warns.filter((w) => w.includes("简报"))).toEqual([]);
  });

  it("简报文件损坏 → onWarn 可见 + 回退到无简报行为（prompt 与基线一致）", async () => {
    const baseline = await promptOf(TEST_REQ);
    const topic = await seedTopic();
    await seedJob(topic.id, { briefRevision: 1 });
    await fs.mkdir(path.dirname(briefPath(topic.id, 1, testDir)), { recursive: true });
    await fs.writeFile(briefPath(topic.id, 1, testDir), "{ 这不是 JSON", "utf-8");

    const warns: string[] = [];
    const got = await promptOf({ ...TEST_REQ, topicId: topic.id }, { onWarn: (m) => warns.push(m) });

    expect(got).toEqual(baseline);
    expect(warns.some((w) => w.includes("损坏"))).toBe(true);
  });

  it("台账读不动（jobs.jsonl 是目录）→ onWarn 可见 + 照常写稿，不带走整条链", async () => {
    const baseline = await promptOf(TEST_REQ);
    const topic = await seedTopic();
    await fs.mkdir(path.join(testDir, "research", "jobs.jsonl"), { recursive: true });

    const warns: string[] = [];
    const got = await promptOf({ ...TEST_REQ, topicId: topic.id }, { onWarn: (m) => warns.push(m) });

    expect(got).toEqual(baseline);
    expect(warns.some((w) => w.includes("简报读取失败"))).toBe(true);
  });

  it("选题已被删（简报还在）→ 按「基于旧版选题」标注注入并告警", async () => {
    const { topic } = await seedResearched();
    await fs.rm(path.join(testDir, "topics", `${topic.id}.json`), { force: true });

    const warns: string[] = [];
    const seen: { opts?: LoopOptions } = {};
    await generateScript({ ...TEST_REQ, topicId: topic.id }, testDir, {
      runLoopImpl: capturingLoop(seen),
      onWarn: (m) => warns.push(m),
    });

    expect(seen.opts!.userMessage).toContain("本简报基于旧版选题，采信时注意");
    expect(warns.some((w) => w.includes("已不在库中"))).toBe(true);
  });
});

// ─── 归因（两条落点，照 usedPatternIds 的纪律） ───────────────────────────────

describe("usedBriefRevision / usedBriefHash 归因", () => {
  it("有简报 → run-log 元数据与稿件元数据都带版本号与内容指纹", async () => {
    const { topic, brief } = await seedResearched(makeBrief({ revision: 1 }));
    const seen: { opts?: LoopOptions } = {};

    const result = await generateScript({ ...TEST_REQ, topicId: topic.id }, testDir, {
      runLoopImpl: capturingLoop(seen),
    });

    expect(seen.opts!.logMeta?.usedBriefRevision).toBe(brief.revision);
    const saved = await getContent(result.contentId, testDir);
    expect(saved!.usedBriefRevision).toBe(brief.revision);
    // 指纹是「盘上那份没被换过」的凭据：不断言字面值(那会变成一条脆的 golden),
    // 只断言它存在、是 16 位十六进制、且两条落点一致
    const hash = briefHash(brief);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(seen.opts!.logMeta?.usedBriefHash).toBe(hash);
    expect(saved!.usedBriefHash).toBe(hash);
  });

  it("无简报 → 两条落点都不写该字段（与改动前一字不差）", async () => {
    const seen: { opts?: LoopOptions } = {};
    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl: capturingLoop(seen) });

    expect(seen.opts!.logMeta).not.toHaveProperty("usedBriefRevision");
    expect(seen.opts!.logMeta).not.toHaveProperty("usedBriefHash");
    const saved = await getContent(result.contentId, testDir);
    expect(saved).not.toHaveProperty("usedBriefRevision");
    expect(saved).not.toHaveProperty("usedBriefHash");
  });
});

// ─── 三条写稿入口一致 ────────────────────────────────────────────────────────

describe("注入点唯一 — 桌面/聊天/MCP 三路一致", () => {
  it("同步入口（MCP 工具走的这条）与后台入口（桌面 IPC/chat-router 走的这条）产出同一个块", async () => {
    const { topic } = await seedResearched();
    const req = { ...TEST_REQ, topicId: topic.id, research: "同一份用户材料" };

    const sync: { opts?: LoopOptions } = {};
    await generateScript(req, testDir, { runLoopImpl: capturingLoop(sync) });

    const background: { opts?: LoopOptions } = {};
    const started = await startGenerateScript(req, testDir, { runLoopImpl: capturingLoop(background) });
    await started.completion;

    const syncBlock = briefBlockOf(sync.opts!.userMessage);
    expect(syncBlock).not.toBe("");
    expect(briefBlockOf(background.opts!.userMessage)).toBe(syncBlock);
    // 整个 user prompt 也一致：research 槽的装配顺序与预算判定都在同一处
    expect(background.opts!.userMessage).toBe(sync.opts!.userMessage);
    expect(background.opts!.logMeta?.usedBriefRevision).toBe(sync.opts!.logMeta?.usedBriefRevision);
  });

  it("MCP 工具入口带 topic_id → 简报块经 executeGenerate 注入 prompt", async () => {
    const { topic } = await seedResearched();
    const seen: { opts?: LoopOptions } = {};

    const res = await executeGenerate(
      { action: "script", topic: TOPIC_TITLE, platform: "douyin", topic_id: topic.id, _dataDir: testDir },
      { generateScriptImpl: (req, dd) => generateScript(req, dd, { runLoopImpl: capturingLoop(seen) }) },
    );

    expect(res.ok).toBe(true);
    const msg = seen.opts!.userMessage;
    expect(briefBlockOf(msg)).not.toBe("");
    expect(msg).toContain("厂商宣称提效 55%");
  });

  it("MCP 工具入口不带 topic_id → 盘上有简报也不注入（行为与改动前一致）", async () => {
    await seedResearched();
    const seen: { opts?: LoopOptions } = {};

    const res = await executeGenerate(
      { action: "script", topic: TOPIC_TITLE, platform: "douyin", _dataDir: testDir },
      { generateScriptImpl: (req, dd) => generateScript(req, dd, { runLoopImpl: capturingLoop(seen) }) },
    );

    expect(res.ok).toBe(true);
    expect(seen.opts!.userMessage).not.toContain(BRIEF_BLOCK_START);
  });

  it("三条入口的调用层都不自己拼 research 槽——装配只发生在生成执行器里", async () => {
    // 断言的是「调用层不做槽装配」，不是「不许碰调研模块」：
    // 读简报给 UI 看（research:brief_get）是另一回事，只有这两个装配原语算第二个注入点。
    const callers = [
      { file: "src/desktop/ipc.ts", entry: "startGenerateScript" },
      { file: "src/desktop/chat-router.ts", entry: "startGenerateScript" },
      { file: "src/tools/generate.ts", entry: "generateScript" },
    ];
    for (const { file, entry } of callers) {
      const src = await fs.readFile(path.join(process.cwd(), file), "utf-8");
      expect(src).toContain(entry);
      expect(src).not.toContain("buildBriefBlock");
      expect(src).not.toContain("retrieveKnowledge");
    }
  });
});
