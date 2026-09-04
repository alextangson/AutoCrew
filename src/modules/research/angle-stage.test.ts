/**
 * angle-stage.test.ts — 立意 pass（P1 spec §4.1）。
 *
 * 引擎全打桩零 LLM：假 runLoop 按脚本调 `submit_angles`，工具返回值原样收进 capture。
 * 断言只压确定性层——校验打回的理由、引用校验、代码打分、错误码；不对模型文案做精确断言。
 */
import { describe, it, expect } from "vitest";

import {
  DEFAULT_ANGLE_DEADLINE_MS,
  buildAngleSystemPrompt,
  buildAngleUserMessage,
  excerptHashOf,
  runAngleStage,
  scoreAngleCard,
  type RunAngleStageInput,
} from "./angle-stage.js";
import { BRIEF_SCHEMA_VERSION, type AngleCardV3, type ResearchBrief } from "./brief-store.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult, LoopTool, runLoop } from "../../engine/loop.js";
import type { CreatorProfile } from "../profile/creator-profile.js";

// ─── 固定装置 ────────────────────────────────────────────────────────────────

const CONFIG: EngineConfig = {
  apiKey: "sk-test",
  baseUrl: "https://main.test",
  strongModel: "m-strong",
  fastModel: "m-fast",
  routes: { scout: { baseUrl: "https://scout.test", model: "m-scout" } },
};

const PROFILE = {
  industry: "AI 一线实践（FDE 部署 + vibecoding）",
  audiencePersona: { core: { name: "独立开发者", coreAnxiety: "做出来没人用" } },
} as unknown as CreatorProfile;

const EV_QUOTE = "62% 的人每天使用 AI 编程助手，但维护成本上升了三成";

function makeBrief(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "四路指向一致：工具已普及，分歧在维护成本。",
    perspectives: [],
    tensions: ["普及率高与净收益低同时成立"],
    angleSuggestions: [],
    evidence: [
      { claim: "使用率过半", quote: EV_QUOTE, sourceUrl: "https://example.com/survey" },
      { claim: "重构类任务翻车多", quote: "重构类任务的一次通过率只有三成", sourceUrl: "https://example.com/bench" },
    ],
    assetPicks: [],
    missingPerspectives: [],
    gaps: ["没找到分语言细分数据"],
    generatedAt: "2026-09-04T00:00:00.000Z",
    revision: 1,
    topicHash: "hash-1",
    ...over,
  };
}

const TOPIC = { title: "AI 编程助手横评", description: "对比主流工具的真实收益与维护成本" };

/** 一张合法候选；`over` 覆盖任意字段（键是工具参数的 snake_case） */
function cand(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    primary_persona: "grow",
    angle: "算一笔维护账",
    thesis: "省下的编码时间被维护成本吃回去了，净收益接近于零",
    evidence_level: "grounded",
    core_evidence_ids: ["ev-1"],
    misconception: "以为提效数字等于净收益",
    mechanism: "补全省下的是打字时间，维护花的是理解时间；理解成本更贵，所以账会反过来",
    payoff: "看完你会知道该拿哪一段时间去比，而不是信那个百分比；今天就把上周的返工时间记一次",
    next_action: "把上周被 AI 改过的代码返工时间记下来",
    counter_response: "有人会说熟练了就好——熟练解决的是打字，不是理解成本",
    persona_gains: { grow: "听懂提效数字怎么骗人", trust: "有可复算的账", convert: "知道验收该验什么" },
    elements: ["新奇点", "爽点"],
    evidence_needs: ["返工时长的公开统计"],
    structure: "myth-busting",
    hook_draft: "提效 55% 是真的，只是账没算完。",
    anti_scope: "不写工具横评、不写怎么写 prompt",
    ...over,
  };
}

const CAND_2 = cand({
  angle: "从翻车案例倒推",
  thesis: "翻车集中在重构类任务，说明它擅长补全而不是设计",
  core_evidence_ids: ["ev-2"],
  primary_persona: "trust",
  anti_scope: "不做成本测算、不谈团队管理",
  hook_draft: "同一个工具，写新函数很神，一动老代码就废。",
  elements: ["痛点→理想状态", "泪点"],
});

const CAND_3 = cand({
  angle: "验收标准换一个",
  thesis: "该被考核的不是生成速度，而是改完之后谁能读懂",
  core_evidence_ids: ["ev-1"],
  primary_persona: "convert",
  anti_scope: "不谈选型、不谈价格",
  hook_draft: "你们团队验收 AI 代码的那一条标准，可能正好是错的。",
  elements: ["美点", "爽点", "新奇点"],
});

function submitArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    misconceptions: { grow: ["提效数字等于净收益"], trust: ["新工具都差不多"], convert: ["买工具就等于落地"] },
    candidates: [cand(), CAND_2, CAND_3],
    ...over,
  };
}

// ─── 假引擎 ──────────────────────────────────────────────────────────────────

interface Capture {
  opts?: LoopOptions;
  cfg?: EngineConfig;
  results: string[];
}

/** 按脚本逐次调 submit_angles，工具返回值收进 cap.results */
function scriptedLoop(submissions: Record<string, unknown>[], cap: Capture): typeof runLoop {
  return (async (cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    cap.cfg = cfg;
    cap.opts = opts;
    const tool = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_angles");
    if (!tool) throw new Error("submit_angles 没挂上");
    for (const args of submissions) cap.results.push(await tool.execute(args));
    return {
      finalMessage: "",
      turns: submissions.length + 1,
      totalTokens: 4321,
      toolCallCount: submissions.length,
      stopReason: "no_tool_calls",
    };
  }) as unknown as typeof runLoop;
}

function run(
  submissions: Record<string, unknown>[],
  cap: Capture = { results: [] },
  over: Partial<RunAngleStageInput> = {},
) {
  return runAngleStage({
    brief: makeBrief(),
    topic: TOPIC,
    profile: PROFILE,
    engineConfig: CONFIG,
    runLoopImpl: scriptedLoop(submissions, cap),
    ...over,
  });
}

/** 只跑一次提交、只关心工具回执（校验用例的主力） */
async function reject(over: Record<string, unknown>, briefOver: Partial<ResearchBrief> = {}): Promise<string> {
  const cap: Capture = { results: [] };
  const res = await run([submitArgs(over)], cap, { brief: makeBrief(briefOver) });
  expect(res.status).toBe("failed");
  return cap.results[0];
}

// ─── 成功路径 ────────────────────────────────────────────────────────────────

describe("立意 pass 成功路径", () => {
  it("三张合法候选 → 卡 v3，id 按位置编，score 由代码写", async () => {
    const cap: Capture = { results: [] };
    const res = await run([submitArgs()], cap);

    expect(res.status).toBe("succeeded");
    if (res.status !== "succeeded") return;
    expect(res.cards.map((c) => c.id)).toEqual(["angle-1", "angle-2", "angle-3"]);
    expect(res.cards.every((c) => c.cardVersion === 3)).toBe(true);
    expect(res.tokensUsed).toBe(4321);
    expect(res.misconceptions.grow).toEqual(["提效数字等于净收益"]);
    // 元素 2 + grounded 1 + 主画像 grow 1 = 4
    expect(res.cards[0].score).toBe(4);
    expect(res.cards[0].scoreReasons).toContain("主画像=涨粉（账号当前目标）");
    expect(cap.results[0]).not.toMatch(/^Error/);
  });

  it("走 scout 路由，maxTurns/token 与 logMeta 按 spec 挂上", async () => {
    const cap: Capture = { results: [] };
    await run([submitArgs()], cap);
    expect(cap.cfg?.baseUrl).toBe("https://scout.test");
    expect(cap.opts?.model).toBe("m-scout");
    expect(cap.opts?.maxTurns).toBe(5);
    expect(cap.opts?.maxTotalTokens).toBe(60_000);
    expect(cap.opts?.logMeta).toEqual({ agent: "angle" });
  });

  it("客户端提交的 score 一律丢弃，服务端重算", async () => {
    const res = await run([submitArgs({ candidates: [cand({ score: 99, score_reasons: ["我最好"] }), CAND_2, CAND_3] })]);
    expect(res.status).toBe("succeeded");
    if (res.status !== "succeeded") return;
    expect(res.cards[0].score).toBe(4);
    expect(res.cards[0].scoreReasons).not.toContain("我最好");
  });

  it("提示词：三画像 + 机制要求 + 证据级别；简报证据带 ev-N 与逐字引文", async () => {
    const prompt = buildAngleSystemPrompt(PROFILE);
    expect(prompt).toContain("涨粉");
    expect(prompt).toContain("立信");
    expect(prompt).toContain("变现");
    expect(prompt).toContain("mechanism");
    expect(prompt).toContain("evidenceLevel=grounded");
    expect(prompt).toContain("myth-busting");
    // 现有核心受众只作补充，绝不冒充变现画像
    expect(prompt).toContain("补充：现有核心受众画像");

    const user = buildAngleUserMessage({ brief: makeBrief(), topic: TOPIC, profile: PROFILE });
    expect(user).toContain("ev-1");
    expect(user).toContain(EV_QUOTE); // 锚点要逐字回引，引文不能被改写
    expect(user).toContain("tension-1");
  });
});

// ─── 校验：证据级别 ──────────────────────────────────────────────────────────

describe("evidenceLevel 与证据引用", () => {
  it("grounded 引不存在的证据 → 打回并点名", async () => {
    const msg = await reject({ candidates: [cand({ core_evidence_ids: ["ev-9"] }), CAND_2, CAND_3] });
    expect(msg).toContain("ev-9");
    expect(msg).toContain("不存在");
  });

  it("grounded 但一条证据都没引 → 打回并指路 overview", async () => {
    const msg = await reject({ candidates: [cand({ core_evidence_ids: [] }), CAND_2, CAND_3] });
    expect(msg).toContain("overview");
  });

  it("overview 允许空 coreEvidenceIds，但 evidenceNeeds 必须 ≥2", async () => {
    const thin = cand({ evidence_level: "overview", core_evidence_ids: [], evidence_needs: ["只有一条"] });
    expect(await reject({ candidates: [thin, CAND_2, CAND_3] })).toContain("evidenceNeeds");

    const ok = cand({
      evidence_level: "overview",
      core_evidence_ids: [],
      evidence_needs: ["返工时长统计", "同类工具的失败案例"],
    });
    const res = await run([submitArgs({ candidates: [ok, CAND_2, CAND_3] })]);
    expect(res.status).toBe("succeeded");
    if (res.status !== "succeeded") return;
    expect(res.cards[0].evidenceLevel).toBe("overview");
    expect(res.cards[0].coreEvidenceIds).toEqual([]);
    // overview 不加那 1 分：元素 2 + grow 1 = 3
    expect(res.cards[0].score).toBe(3);
  });

  it("简报没有任何证据 → 只能出 overview 卡", async () => {
    const msg = await reject({}, { evidence: [] });
    expect(msg).toContain("一条证据都没有");

    const overview = (over: Record<string, unknown>) =>
      cand({ evidence_level: "overview", core_evidence_ids: [], evidence_needs: ["数字", "案例"], ...over });
    const res = await run(
      [
        submitArgs({
          candidates: [
            overview({}),
            overview({ thesis: CAND_2.thesis, anti_scope: CAND_2.anti_scope }),
            overview({ thesis: CAND_3.thesis, anti_scope: CAND_3.anti_scope }),
          ],
        }),
      ],
      { results: [] },
      { brief: makeBrief({ evidence: [] }) },
    );
    expect(res.status).toBe("succeeded");
  });

  it("evidenceNeeds 超过 3 条 / tensionId 指不到 → 打回", async () => {
    expect(await reject({ candidates: [cand({ evidence_needs: ["a", "b", "c", "d"] }), CAND_2, CAND_3] })).toContain(
      "evidenceNeeds 最多 3 条",
    );
    expect(await reject({ candidates: [cand({ tension_id: "tension-7" }), CAND_2, CAND_3] })).toContain("tension-7");
  });
});

// ─── 校验：第一手锚点 ────────────────────────────────────────────────────────

describe("firsthandAnchor 结构化引用", () => {
  const anchor = (over: Record<string, unknown> = {}) => ({
    kind: "brief_evidence",
    chunk_id: "ev-1",
    quote: "维护成本上升了三成",
    ...over,
  });

  it("逐字命中 → 收下，excerptHash 由代码算，打分 +2", async () => {
    const res = await run([submitArgs({ candidates: [cand({ firsthand_anchor: anchor() }), CAND_2, CAND_3] })]);
    expect(res.status).toBe("succeeded");
    if (res.status !== "succeeded") return;
    const got = res.cards[0].firsthandAnchor;
    expect(got).toEqual({
      kind: "brief_evidence",
      chunkId: "ev-1",
      excerptHash: excerptHashOf(EV_QUOTE),
      quote: "维护成本上升了三成",
    });
    expect(res.cards[0].score).toBe(6); // 4 + 锚点 2
    expect(res.cards[0].scoreReasons).toContain("第一手锚点校验通过");
  });

  it("转述（非逐字）→ 打回", async () => {
    const msg = await reject({
      candidates: [cand({ firsthand_anchor: anchor({ quote: "维护成本大概涨了三成左右" }) }), CAND_2, CAND_3],
    });
    expect(msg).toContain("逐字");
  });

  it("引用不存在的片段 → 打回", async () => {
    const msg = await reject({ candidates: [cand({ firsthand_anchor: anchor({ chunk_id: "ev-8" }) }), CAND_2, CAND_3] });
    expect(msg).toContain("ev-8");
  });

  it("本刀不认转写/审定稿锚点（内部语料还没接进来）", async () => {
    const msg = await reject({
      candidates: [cand({ firsthand_anchor: anchor({ kind: "transcript", chunk_id: "om:c1:video:3:0" }) }), CAND_2, CAND_3],
    });
    expect(msg).toContain("brief_evidence");
  });
});

// ─── 校验：形状与词表 ────────────────────────────────────────────────────────

describe("形状、元素、差异性、词表", () => {
  it("元素 <2 或全是新奇点 → 打回", async () => {
    expect(await reject({ candidates: [cand({ elements: ["爽点"] }), CAND_2, CAND_3] })).toContain("网感元素需 ≥2");
    expect(await reject({ candidates: [cand({ elements: ["新奇点", "新奇点"] }), CAND_2, CAND_3] })).toContain(
      "不能全靠新奇点",
    );
  });

  it("缺三画像收益 / 缺机制 / 机制超 400 字 → 打回", async () => {
    expect(
      await reject({ candidates: [cand({ persona_gains: { grow: "a", trust: "", convert: "c" } }), CAND_2, CAND_3] }),
    ).toContain("trust 画像的收益");
    expect(await reject({ candidates: [cand({ mechanism: "" }), CAND_2, CAND_3] })).toContain("mechanism");
    expect(await reject({ candidates: [cand({ mechanism: "因".repeat(401) }), CAND_2, CAND_3] })).toContain("400 字");
  });

  it("身份自嘲 → 打回（嘲行为可以，嘲身份不行）", async () => {
    const msg = await reject({ candidates: [cand({ hook_draft: "我不是科班出身，所以踩了这个坑。" }), CAND_2, CAND_3] });
    expect(msg).toContain("身份");
  });

  it("两张卡主张雷同 → 打回（沿用 checkDistinct 那把尺）", async () => {
    const msg = await reject({
      candidates: [cand(), cand({ angle: "换个说法", primary_persona: "trust" }), CAND_3],
    });
    expect(msg).toContain("同一个角度换套说法");
  });

  it("候选不足 3 个 / 误区缺席 → 打回", async () => {
    expect(await reject({ candidates: [cand(), CAND_2] })).toContain("候选需 3-4 个");
    expect(await reject({ misconceptions: { grow: [], trust: ["a"], convert: ["b"] } })).toContain("misconceptions.grow");
  });

  it("修复轮 ≤2：第三次仍不合法就叫停", async () => {
    const cap: Capture = { results: [] };
    const bad = submitArgs({ candidates: [cand({ elements: [] }), CAND_2, CAND_3] });
    const res = await run([bad, bad, bad], cap);
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.errorCode).toBe("invalid_output");
    expect(cap.results[2]).toContain("修复轮已用尽");
  });

  it("先错后对：修好之后照常收下", async () => {
    const res = await run([submitArgs({ candidates: [cand({ elements: [] }), CAND_2, CAND_3] }), submitArgs()]);
    expect(res.status).toBe("succeeded");
  });
});

// ─── 打分 ────────────────────────────────────────────────────────────────────

describe("代码打分（只用于展示排序）", () => {
  const brief = makeBrief();
  const base: AngleCardV3 = {
    cardVersion: 3,
    id: "angle-1",
    angle: "a",
    thesis: "主张",
    evidenceLevel: "overview",
    coreEvidenceIds: [],
    antiScope: "b",
    hookDraft: "c",
    primaryPersona: "trust",
    misconception: "d",
    mechanism: "e",
    payoff: "f",
    nextAction: "g",
    counterResponse: "h",
    personaGains: { grow: "1", trust: "2", convert: "3" },
    elements: ["爽点", "泪点"],
    evidenceNeeds: ["x", "y"],
    structure: "story",
  };

  it("元素封顶 3 分", () => {
    expect(scoreAngleCard({ ...base, elements: ["爽点", "泪点", "美点", "笑点"] }, brief).score).toBe(3);
  });

  it("劝退型主张扣 3 分", () => {
    const got = scoreAngleCard({ ...base, thesis: "劝退：这个工具你先别碰" }, brief);
    expect(got.score).toBe(-1); // 元素 2 − 劝退 3
    expect(got.reasons.some((r) => r.includes("劝退"))).toBe(true);
    // 2026-09-05 e2e 漏网的变体：带判断框架的「别现在上生产」同样是创始人否掉的那一族
    const variant = scoreAngleCard({ ...base, thesis: "Star 衡量的是围观，DeepSeek Harness 现在的状态是明确的别现在上生产" }, brief);
    expect(variant.reasons.some((r) => r.includes("劝退"))).toBe(true);
  });

  it("grounded +1、主画像 grow +1、锚点对不上不给 2 分", () => {
    const grounded = scoreAngleCard(
      { ...base, evidenceLevel: "grounded", coreEvidenceIds: ["ev-1"], primaryPersona: "grow" },
      brief,
    );
    expect(grounded.score).toBe(4);
    const faked = scoreAngleCard(
      { ...base, firsthandAnchor: { kind: "brief_evidence", chunkId: "ev-1", excerptHash: "deadbeef", quote: "维护成本上升了三成" } },
      brief,
    );
    expect(faked.score).toBe(2);
    expect(faked.reasons).toContain("无可校验的第一手锚点");
  });
});

// ─── 失败路径 ────────────────────────────────────────────────────────────────

describe("失败路径", () => {
  it("压根没提交 → no_submit", async () => {
    const res = await run([]);
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.errorCode).toBe("no_submit");
  });

  it("引擎抛错 → engine_failed，不往外抛", async () => {
    const boom = (async () => {
      throw new Error("上游 502");
    }) as unknown as typeof runLoop;
    const res = await runAngleStage({
      brief: makeBrief(),
      topic: TOPIC,
      profile: null,
      engineConfig: CONFIG,
      runLoopImpl: boom,
    });
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.errorCode).toBe("engine_failed");
    expect(res.reason).toContain("502");
  });

  it("墙钟到点 → deadline，且晚到的提交被丢弃", async () => {
    let late: string | undefined;
    const slow = ((_cfg: EngineConfig, opts: LoopOptions) =>
      new Promise<LoopResult>((resolve) => {
        setTimeout(async () => {
          const tool = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_angles")!;
          late = await tool.execute(submitArgs());
          resolve({ finalMessage: "", turns: 2, totalTokens: 1, toolCallCount: 1, stopReason: "no_tool_calls" });
        }, 40);
      })) as unknown as typeof runLoop;

    const res = await runAngleStage({
      brief: makeBrief(),
      topic: TOPIC,
      profile: null,
      engineConfig: CONFIG,
      runLoopImpl: slow,
      deadlineMs: 5,
    });
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.errorCode).toBe("deadline");
    await new Promise((r) => setTimeout(r, 60));
    expect(late).toContain("超时作废");
  });

  it("缺省墙钟是 4 分钟（spec §4.1）", () => {
    expect(DEFAULT_ANGLE_DEADLINE_MS).toBe(480_000);
  });
});
