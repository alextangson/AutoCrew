/**
 * workflow.test.ts — `autocrew_workflow` 的六个动作（dsh 插件 spec §4）。
 *
 * 这条链的要害全在**拒单**上：搜索没配好不许排一个注定失败的 job、没简报不许重跑立意、
 * 有候选卡却没选不许开写。少任何一道，宿主 agent 都会在创始人不知情的情况下往前走。
 *
 * 零网络、零真 LLM：runner 与后台写稿都从 deps 注入替身；断言全落在确定的形状与夹具文字上。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { executeWorkflow, resetWorkflowRunners, workflowSchema } from "./workflow.js";
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
  type ResearchJobStatus,
} from "../modules/research/research-job-store.js";
import type { ResearchRunner, TriggerResult } from "../modules/research/research-runner.js";
import { SEARCH_NOT_CONFIGURED } from "../modules/research/search-provider.js";
import { saveTopic, updateContent, saveContent, type Topic } from "../storage/local-store.js";

let testDir: string;

const TITLE = "AI 编程助手横评";
const DESC = "对比 5 个主流工具的真实提效";
const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "AUTOCREW_SEED_ENGINE"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-workflow-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  resetWorkflowRunners();
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
    hookDraft: "提效 55% 是真的，只是账没算完。",
    primaryPersona: "grow",
    misconception: "他以为提效数字就是净收益",
    mechanism: "AI 写得快，返工的活落回人身上，账在下游才结",
    payoff: "把返工工时也记进去，你当场知道这笔账划不划算",
    nextAction: "今晚把上周的返工工时记一次",
    counterResponse: "有人说熟练了就不返工——实测里熟练组也没降",
    personaGains: { grow: "听懂提效数字的水分", trust: "拿到一份可复用的核算口径", convert: "评估要不要全员铺开" },
    elements: ["新奇点", "痛点→理想状态"],
    evidenceNeeds: ["独立评测的返工工时数据"],
    structure: "myth-busting",
    score: 4,
    scoreReasons: ["元素 2", "有简报证据（grounded）"],
    ...over,
  };
}

function makeBrief(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "厂商口径与独立评测差了四倍。",
    perspectives: [],
    tensions: ["厂商宣称提效 55%，独立评测只测到 12%"],
    angleSuggestions: [],
    angleCards: [card()],
    evidence: [
      { claim: "提效幅度远低于厂商口径", quote: "平均完成时间缩短约 12%。", sourceUrl: "https://example.com/s" },
    ],
    assetPicks: [],
    missingPerspectives: [],
    gaps: ["缺一手返工工时"],
    generatedAt: "2026-09-04T10:00:00.000Z",
    revision: 1,
    topicHash: topicHashOf(TITLE, DESC),
    ...over,
  };
}

/** CAS 推进台账指针 = 这一版才是「当前生效简报」（P1 §3.0） */
async function adopt(topicId: string, briefRevision?: number, status: ResearchJobStatus = "succeeded"): Promise<void> {
  const job: ResearchJob = {
    topicId,
    status,
    startedAt: "2026-09-04T09:00:00.000Z",
    ...(status === "succeeded" ? { settledAt: "2026-09-04T10:00:00.000Z" } : {}),
    perspectives: pendingPerspectives(),
    ...(briefRevision !== undefined ? { briefRevision } : {}),
    topicHash: topicHashOf(TITLE, DESC),
  };
  await upsertJob(job, testDir);
}

async function seed(brief: ResearchBrief | null = makeBrief()): Promise<Topic> {
  const topic = await saveTopic({ title: TITLE, description: DESC, tags: [] }, testDir);
  if (brief) {
    await saveBrief(topic.id, brief, testDir);
    await adopt(topic.id, brief.revision);
  }
  return topic;
}

async function configureSearch(): Promise<void> {
  await fs.writeFile(path.join(testDir, "search.json"), JSON.stringify({ provider: "bocha", apiKey: "k-test" }));
}

function fakeRunner(trigger: TriggerResult): { runner: ResearchRunner; calls: string[][]; reclaims: number } {
  const calls: string[][] = [];
  const state = { reclaims: 0 };
  const runner: ResearchRunner = {
    trigger: async (topicId, kind = "full") => {
      calls.push([topicId, kind]);
      return trigger;
    },
    reclaimStaleJobs: async () => {
      state.reclaims += 1;
      return [];
    },
    idle: async () => {},
    stop: () => {},
  };
  return {
    runner,
    calls,
    get reclaims() {
      return state.reclaims;
    },
  };
}

const run = (params: Record<string, unknown>, deps = {}) =>
  executeWorkflow({ ...params, _dataDir: testDir }, { onWarn: () => {}, ...deps });

// ─── research ─────────────────────────────────────────────────────────────────

describe("workflow research", () => {
  it("搜索没配好就不排 full job——拒单文案与桌面投递口一字不差", async () => {
    const topic = await seed(null);
    const res = await run({ action: "research", topic_id: topic.id });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe(SEARCH_NOT_CONFIGURED);
  });

  it("没有生效简报时拒 angles——它的起点就是那份简报", async () => {
    const topic = await seed(null);
    const res = await run({ action: "research", topic_id: topic.id, kind: "angles" });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("先跑一轮深调研");
  });

  it("angles 不看搜索 key：有简报就放行（搜索未配置也一样）", async () => {
    const topic = await seed();
    const fake = fakeRunner({ accepted: true, deduped: false, job: { topicId: topic.id, status: "queued", kind: "angles", startedAt: "x", perspectives: [], topicHash: "h" } });
    const res = await run({ action: "research", topic_id: topic.id, kind: "angles" }, { createRunnerImpl: () => fake.runner });
    expect(res.ok).toBe(true);
    expect(fake.calls).toEqual([[topic.id, "angles"]]);
  });

  it("投递成功即返回 job，并且首次使用时跑过一次启动回收", async () => {
    await configureSearch();
    const topic = await seed(null);
    const fake = fakeRunner({
      accepted: true,
      deduped: false,
      job: { topicId: topic.id, status: "queued", startedAt: "2026-09-04T09:00:00.000Z", perspectives: pendingPerspectives(), topicHash: "h" },
    });
    const res = await run({ action: "research", topic_id: topic.id }, { createRunnerImpl: () => fake.runner });
    expect(res.ok).toBe(true);
    expect((res as { job: { status: string; kind: string; terminal: boolean } }).job).toMatchObject({
      status: "queued",
      kind: "full",
      terminal: false,
    });
    expect(fake.reclaims).toBe(1);
    // 同一个 dataDir 第二次不再重建 runner，也不再补扫
    await run({ action: "research", topic_id: topic.id }, { createRunnerImpl: () => fake.runner });
    expect(fake.reclaims).toBe(1);
    expect(fake.calls).toHaveLength(2);
  });

  it("在途任务的拒单带 inFlight，宿主要说「研究进行中」而不是「投递失败」", async () => {
    await configureSearch();
    const topic = await seed(null);
    const fake = fakeRunner({ accepted: false, reason: "研究进行中：这条选题的深调研正在跑", inFlight: true });
    const res = await run({ action: "research", topic_id: topic.id }, { createRunnerImpl: () => fake.runner });
    expect(res).toMatchObject({ ok: false, inFlight: true });
    expect((res as { error: string }).error).toContain("研究进行中");
  });

  it("未知 kind 当场拒，不猜", async () => {
    const topic = await seed(null);
    const res = await run({ action: "research", topic_id: topic.id, kind: "deep" });
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toContain("full | angles");
  });
});

// ─── status ───────────────────────────────────────────────────────────────────

describe("workflow status", () => {
  it("v3 卡按分数排序、字段完整，且不带任何推荐标", async () => {
    const brief = makeBrief({
      angleCards: [
        card({ id: "angle-1", score: 4 }),
        card({ id: "angle-2", score: 7, thesis: "翻车集中在重构类任务", antiScope: "不做成本测算" }),
        card({ id: "angle-3", score: 1, thesis: "省下的时间被评审吃掉", antiScope: "不谈工具选型" }),
      ],
    });
    const topic = await seed(brief);
    const res = (await run({ action: "status", topic_id: topic.id })) as Record<string, any>;

    expect(res.ok).toBe(true);
    expect(res.job).toMatchObject({ status: "succeeded", terminal: true, briefRevision: 1 });
    expect(res.brief.revision).toBe(1);
    expect(res.brief.cards.map((c: any) => c.id)).toEqual(["angle-2", "angle-1", "angle-3"]);
    expect(res.brief.cards[0]).toMatchObject({
      cardVersion: 3,
      primaryPersona: "grow",
      thesis: "翻车集中在重构类任务",
      misconception: "他以为提效数字就是净收益",
      payoff: "把返工工时也记进去，你当场知道这笔账划不划算",
      nextAction: "今晚把上周的返工工时记一次",
      evidenceLevel: "grounded",
      hasAnchor: false,
      score: 7,
    });
    // 挑哪张是创始人的活：卡上不许出现任何「这张更好」的标，回执自己也要把这句说出来
    for (const c of res.brief.cards) {
      expect(Object.keys(c)).not.toEqual(expect.arrayContaining(["recommended", "rank", "best", "suggested"]));
    }
    expect(res.brief.note).toContain("不是推荐");
    expect(res.selectedAngle).toBeUndefined();
  });

  it("从没研究过的选题：job 为 null，没有 brief 块（不是报错）", async () => {
    const topic = await seed(null);
    const res = (await run({ action: "status", topic_id: topic.id })) as Record<string, any>;
    expect(res.ok).toBe(true);
    expect(res.job).toBeNull();
    expect(res.brief).toBeUndefined();
  });

  it("指针没推进（重跑失败）时不回落磁盘最新版——按「无简报」报", async () => {
    const topic = await seed(null);
    await saveBrief(topic.id, makeBrief(), testDir);
    await adopt(topic.id, undefined, "failed");
    const res = (await run({ action: "status", topic_id: topic.id })) as Record<string, any>;
    expect(res.job.status).toBe("failed");
    expect(res.brief).toBeUndefined();
  });

  it("选题不存在照实拒", async () => {
    expect(await run({ action: "status", topic_id: "nope" })).toMatchObject({ ok: false });
  });
});

// ─── select_angle ─────────────────────────────────────────────────────────────

describe("workflow select_angle", () => {
  it("点选原卡落进 topic.selectedAngle", async () => {
    const topic = await seed();
    const res = (await run({ action: "select_angle", topic_id: topic.id, angle_id: "angle-1" })) as Record<string, any>;
    expect(res.ok).toBe(true);
    expect(res.topic.selectedAngle).toMatchObject({ angleId: "angle-1", briefRevision: 1 });
  });

  it("手上的 revision 跟当前简报对不上 = 看的是过期候选，拒", async () => {
    const topic = await seed();
    const res = await run({ action: "select_angle", topic_id: topic.id, angle_id: "angle-1", brief_revision: 0 });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("角度候选已更新");
  });

  it("卡不在简报里就拒", async () => {
    const topic = await seed();
    const res = await run({ action: "select_angle", topic_id: topic.id, angle_id: "angle-9" });
    expect(res).toMatchObject({ ok: false });
  });

  it("改写：文字照收，客户端塞的 score 一律丢弃重算", async () => {
    const topic = await seed();
    const rewritten = { ...card(), thesis: "真正的账在维护期，不在写代码那半小时", score: 999, scoreReasons: ["我说的"] };
    const res = (await run({
      action: "select_angle",
      topic_id: topic.id,
      angle_id: "angle-1",
      brief_revision: 1,
      card: rewritten,
    })) as Record<string, any>;

    expect(res.ok).toBe(true);
    const saved = res.topic.selectedAngle.card;
    expect(saved.thesis).toBe("真正的账在维护期，不在写代码那半小时");
    // 元素 2 + grounded 1 + 主画像涨粉 1 = 4；999 是客户端说了不算的那一份
    expect(saved.score).toBe(4);
  });

  it("改写不许换证据地基", async () => {
    const topic = await seed();
    const res = await run({
      action: "select_angle",
      topic_id: topic.id,
      angle_id: "angle-1",
      card: { ...card(), coreEvidenceIds: ["ev-2"] },
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("coreEvidenceIds");
  });

  it("没有生效简报时不给选", async () => {
    const topic = await seed(null);
    const res = await run({ action: "select_angle", topic_id: topic.id, angle_id: "angle-1" });
    expect((res as { error: string }).error).toContain("先跑一轮深调研");
  });
});

// ─── write ────────────────────────────────────────────────────────────────────

describe("workflow write", () => {
  const startStub = () => vi.fn(async () => ({ contentId: "c-new" }));

  it("有候选卡却没选：不接单，把候选原样交回去（error 文本里也带一份，桥只透传它）", async () => {
    const topic = await seed();
    const start = startStub();
    const res = (await run(
      { action: "write", topic_id: topic.id, platform: "douyin" },
      { startGenerateScriptImpl: start },
    )) as Record<string, any>;

    expect(res.ok).toBe(false);
    expect(res.needsAngle).toBe(true);
    expect(res.cards.map((c: any) => c.id)).toEqual(["angle-1"]);
    expect(res.error).toContain("不要替他选");
    expect(res.error).toContain("angle-1"); // 摘要必须活着穿过 dsh 桥的 error 字符串
    expect(start).not.toHaveBeenCalled();
  });

  it("手写 direction 放行（创始人自己的角度优先级最高）", async () => {
    const topic = await seed();
    const start = startStub();
    const res = await run(
      { action: "write", topic_id: topic.id, platform: "douyin", direction: "只讲返工工时这一件事" },
      { startGenerateScriptImpl: start },
    );
    expect(res).toMatchObject({ ok: true, contentId: "c-new", started: true });
    expect(start.mock.calls[0][0]).toMatchObject({
      topic: TITLE,
      platform: "douyin",
      topicId: topic.id,
      direction: "只讲返工工时这一件事",
    });
  });

  it("明说直接写（skip_reason）也放行，并且只进留痕字段", async () => {
    const topic = await seed();
    const start = startStub();
    const res = await run(
      { action: "write", topic_id: topic.id, platform: "douyin", skip_reason: "他说不用选，先出一版看看" },
      { startGenerateScriptImpl: start },
    );
    expect(res).toMatchObject({ ok: true });
    expect(start.mock.calls[0][0].angleSkipReason).toBe("他说不用选，先出一版看看");
  });

  it("选过卡之后放行", async () => {
    const topic = await seed();
    await run({ action: "select_angle", topic_id: topic.id, angle_id: "angle-1" });
    const start = startStub();
    const res = await run({ action: "write", topic_id: topic.id, platform: "douyin" }, { startGenerateScriptImpl: start });
    expect(res).toMatchObject({ ok: true, contentId: "c-new" });
  });

  it("压根没有候选卡就没有闸口（降级路径不硬出角度）", async () => {
    const topic = await seed(makeBrief({ angleCards: [] }));
    const start = startStub();
    const res = await run({ action: "write", topic_id: topic.id, platform: "douyin" }, { startGenerateScriptImpl: start });
    expect(res).toMatchObject({ ok: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("平台非法当场拒，不派活", async () => {
    const topic = await seed(null);
    const start = startStub();
    const res = await run({ action: "write", topic_id: topic.id, platform: "tiktok" }, { startGenerateScriptImpl: start });
    expect(res).toMatchObject({ ok: false });
    expect(start).not.toHaveBeenCalled();
  });
});

// ─── draft ────────────────────────────────────────────────────────────────────

describe("workflow draft", () => {
  async function makeContent(status: string, over: Record<string, unknown> = {}): Promise<string> {
    const saved = await saveContent({ title: "［生成中］横评", body: "", platform: "douyin", hashtags: [] }, testDir);
    await updateContent(saved.id, { status, ...over } as never, testDir);
    return saved.id;
  }

  it("还在写：只报 drafting，让宿主继续轮询", async () => {
    const id = await makeContent("drafting");
    const res = (await run({ action: "draft", content_id: id })) as Record<string, any>;
    expect(res).toMatchObject({ ok: true, status: "drafting" });
    expect(res.body).toBeUndefined(); // 占位正文不许当成稿交出去
  });

  it("写完了：正文、审稿结论、角度归因一起给", async () => {
    const id = await makeContent("draft_ready", {
      title: "维护账",
      body: "正文",
      hashtags: ["#AI编程"],
      review: { status: "passed", rounds: 1, fixed: 0, issues: [], reviewedAt: "2026-09-04T11:00:00.000Z" },
      usedAngle: { id: "angle-1", cardVersion: 3, hash: "abc123" },
    });
    const res = (await run({ action: "draft", content_id: id })) as Record<string, any>;
    expect(res).toMatchObject({
      ok: true,
      status: "draft_ready",
      title: "维护账",
      body: "正文",
      needsEvidence: false,
    });
    expect(res.review.status).toBe("passed");
    expect(res.usedAngle).toMatchObject({ id: "angle-1" });
  });

  it("数字硬门拦下的稿：needs_evidence 要连清单和原因一起说出来", async () => {
    const id = await makeContent("needs_evidence", {
      title: "维护账",
      body: "正文里有 55% 这个数",
      unverifiedNumbers: ["55%"],
      blockedReason: "有 1 个数字没有出处",
    });
    const res = (await run({ action: "draft", content_id: id })) as Record<string, any>;
    expect(res).toMatchObject({
      ok: true,
      status: "needs_evidence",
      needsEvidence: true,
      blockedReason: "有 1 个数字没有出处",
    });
    expect(res.unverifiedNumbers).toEqual(["55%"]);
  });

  it("稿件不存在照实拒", async () => {
    expect(await run({ action: "draft", content_id: "c-none" })).toMatchObject({ ok: false });
  });
});

// ─── doctor ───────────────────────────────────────────────────────────────────

describe("workflow doctor", () => {
  it("引擎与搜索都没配：两条都进 hints，engine.configured=false", async () => {
    const res = (await run({ action: "doctor" })) as Record<string, any>;
    expect(res.ok).toBe(true);
    expect(res.engine.configured).toBe(false);
    expect(res.search.configured).toBe(false);
    expect(res.dataDir).toBe(testDir);
    expect(res.hints.join("\n")).toContain(SEARCH_NOT_CONFIGURED);
  });

  it("engine.json 缺席但环境变量有 key：只给建议，不写盘、不回显 key", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-secret-value";
    const res = (await run({ action: "doctor" })) as Record<string, any>;
    expect(res.engine.configured).toBe(true); // 环境变量顶得住，但配置文件仍然缺
    expect(res.engineSeedHint).toBe(path.join(testDir, "engine.json"));
    const hints = res.hints.join("\n");
    expect(hints).toContain("<你的 DEEPSEEK_API_KEY>");
    expect(hints).not.toContain("sk-secret-value");
    await expect(fs.access(path.join(testDir, "engine.json"))).rejects.toBeTruthy();
  });

  it("AUTOCREW_SEED_ENGINE=1 才代写，写完照实说写到哪", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-secret-value";
    process.env.AUTOCREW_SEED_ENGINE = "1";
    const res = (await run({ action: "doctor" })) as Record<string, any>;
    const file = path.join(testDir, "engine.json");
    expect(res.engineSeeded).toBe(file);
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toMatchObject({ apiKey: "sk-secret-value" });
    expect(res.hints.join("\n")).not.toContain("sk-secret-value");
  });

  it("配好了就不再提示种子文件", async () => {
    await fs.writeFile(path.join(testDir, "engine.json"), JSON.stringify({ apiKey: "sk-in-file", strongModel: "m1" }));
    await configureSearch();
    const res = (await run({ action: "doctor" })) as Record<string, any>;
    expect(res.engine).toMatchObject({ configured: true, strongModel: "m1" });
    expect(res.search.configured).toBe(true);
    expect(res.hints).toEqual([]);
    expect(res.engineSeedHint).toBeUndefined();
  });
});

describe("workflow entry", () => {
  it("参数 schema 过得了 dsh 的 lossless JSON 投影（adapters/dsh/README.md 检查单）", async () => {
    const projected = JSON.parse(JSON.stringify(workflowSchema));
    expect(projected).toEqual(JSON.parse(JSON.stringify(projected)));
    expect(projected.properties.action.enum).toEqual([
      "research",
      "status",
      "select_angle",
      "write",
      "draft",
      "doctor",
    ]);
    expect(projected.required).toEqual(["action"]);
    expect(projected.properties.card.type).toBe("object");
  });

  it("未知 action 报可执行的错，不抛", async () => {
    const res = await run({ action: "publish" });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("research | status");
  });
});
