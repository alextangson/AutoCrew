/**
 * angle-stage.test.ts — 立意 pass（P1 spec §4.1）。
 *
 * 引擎全打桩零 LLM：假 runLoop 按脚本调 `submit_angles`，工具返回值原样收进 capture。
 * 断言只压确定性层——校验打回的理由、引用校验、代码打分、错误码；不对模型文案做精确断言。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { techniqueCatalog } from "../writing/technique-store.js";

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
import type { OwnMaterial } from "./own-material.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult, LoopTool, runLoop } from "../../engine/loop.js";
import type { CreatorProfile } from "../profile/creator-profile.js";

// ─── 固定装置 ────────────────────────────────────────────────────────────────

const CONFIG: EngineConfig = {
  apiKey: "sk-test",
  baseUrl: "https://main.test",
  strongModel: "m-strong",
  fastModel: "m-fast",
  // v2：端点表 + 岗位指针（迁移前的 routes 形状已下线）
  providers: [{ id: "scout", name: "scout", baseUrl: "https://scout.test", apiKey: "sk-test", protocol: "openai" as const, models: ["m-scout"] }],
  assignments: { scout: { provider: "scout", model: "m-scout" } },
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
    // 只计可追溯证据，不给目标标签或情绪元素加分
    expect(res.cards[0].score).toBe(1);
    expect(res.cards[0].scoreReasons).toContain("证据支撑分，不代表传播潜力或爆款概率");
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
    expect(res.cards[0].score).toBe(1);
    expect(res.cards[0].scoreReasons).not.toContain("我最好");
  });

  it("提示词：目标标签 + 判断依据 + 证据级别；简报证据带 ev-N 与逐字引文", async () => {
    const prompt = buildAngleSystemPrompt(PROFILE);
    expect(prompt).toContain("涨粉");
    expect(prompt).toContain("立信");
    expect(prompt).toContain("变现");
    expect(prompt).toContain("mechanism");
    expect(prompt).toContain("evidenceLevel=grounded");
    expect(prompt).toContain("myth-busting");
    // 未校准画像标明假设，不能冒充已确认画像或变现目标
    expect(prompt).toContain("待确认的账号画像提案");

    const user = buildAngleUserMessage({ brief: makeBrief(), topic: TOPIC, profile: PROFILE });
    expect(user).toContain("ev-1");
    expect(user).toContain(EV_QUOTE); // 锚点要逐字回引，引文不能被改写
    expect(user).toContain("tension-1");
  });

  it("立意阶段就看到系列快照和已审手法目录（spec 2026-09-28 §3 C）", async () => {
    const series = { id: "snap-1", platform: "douyin", builtAt: "2026-09-28T00:00:00Z", items: [{
      content_id: "content-9", draft_hash: "h", outline_version: 1, title: "上周那条", label: "已发" as const, enteredAt: "2026-09-27T00:00:00Z",
      entries: [{ id: "thesis", text: "AI 要听的是你图什么" }], insufficient: false, truncated: false,
    }] };
    const techniques = await techniqueCatalog(await fs.mkdtemp(path.join(os.tmpdir(), "angle-tech-")));
    const user = buildAngleUserMessage({ brief: makeBrief(), topic: TOPIC, profile: PROFILE, series, techniques });
    expect(user).toContain("AI 要听的是你图什么");
    expect(user).toContain("候选卡之间也要用不同打法");
    expect(user).toContain("minto-scq-intro@v1");
    expect(buildAngleUserMessage({ brief: makeBrief(), topic: TOPIC, profile: PROFILE })).not.toContain("系列记忆");
  });

  it("公众号非AI自然叙事完整保留任务书，明确方向高于账号默认", async () => {
    const creativeTask = { version: 1 as const, platform: "wechat", direction: "从外婆带我种菜的一天说邻里关系", requirements: "公众号；写给第一次参加社区菜园的居民；自然叙事，先写清晨场景再写争执和理解；不反问、不卖课、不讲AI。" };
    const cap: Capture = { results: [] };
    await run([submitArgs()], cap, { creativeTask });
    expect(cap.opts?.systemPrompt).toContain(creativeTask.requirements);
    expect(cap.opts?.systemPrompt).toContain(creativeTask.direction);
    expect(cap.opts?.systemPrompt).toContain("公众号按阅读逻辑和内容深度策划");
    expect(cap.opts?.systemPrompt).toContain("用户方向已明确时");
    expect(cap.opts?.systemPrompt).not.toContain("误区先行");
    expect(cap.opts?.systemPrompt).not.toContain("网感元素 ≥2");
    const user = buildAngleUserMessage({ brief: makeBrief(), topic: TOPIC, profile: null, creativeTask });
    expect(user).toContain(creativeTask.requirements);
    expect(user).toContain(creativeTask.direction);
    expect(user).not.toContain("三画像各自的误区");
  });

  // P1c §3.6：受众推断就是误区的原料，但它进来时必须自带「不可作证据」的标签
  it("受众推断进事实块：带无来源标签、带画像、最多 6 条", () => {
    const user = buildAngleUserMessage({
      brief: makeBrief({
        perspectives: [
          {
            name: "audience",
            insights: [{ text: "维护成本才是真账单", sourceIds: ["p1"] }],
            evidence: [],
            assetPicks: [],
            gaps: [],
            inferences: [
              { text: "他们以为换个模型就能解决", persona: "grow" },
              ...Array.from({ length: 6 }, (_, i) => ({ text: `推断 ${i + 1}` })),
            ],
          },
        ],
      }),
      topic: TOPIC,
      profile: PROFILE,
    });

    expect(user).toContain("受众推断（无来源，不可作证据）");
    expect(user).toContain("他们以为换个模型就能解决");
    expect(user).toContain("（画像 grow）");
    expect(user).toContain("推断 5"); // 首条 + 前 5 条，正好 6 条
    expect(user).not.toContain("推断 6");
  });

  it("没有推断的简报不多出这一段", () => {
    const user = buildAngleUserMessage({ brief: makeBrief(), topic: TOPIC, profile: PROFILE });
    expect(user).not.toContain("受众推断");
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
    // 综述级没有可追溯支撑，不因涨粉目标或表达元素加分
    expect(res.cards[0].score).toBe(0);
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
    expect(res.cards[0].score).toBe(3); // 证据 1 + 锚点 2
    expect(res.cards[0].scoreReasons).toContain("引文锚点校验通过");
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

  it("kind 不认识 → 打回并列出三种合法值", async () => {
    const msg = await reject({
      candidates: [cand({ firsthand_anchor: anchor({ kind: "wechat_post", chunk_id: "ev-1" }) }), CAND_2, CAND_3],
    });
    expect(msg).toContain("brief_evidence");
    expect(msg).toContain("transcript");
  });
});

// ─── 校验：内部语料锚点（P1b §3.2） ─────────────────────────────────────────

describe("firsthandAnchor 引内部语料", () => {
  const CHUNK_TEXT = "我自己做那个插件的时候，卡了整整两天才发现纠正被写进了会消失的内存里。";
  const OWN: OwnMaterial = {
    chunks: [
      {
        id: "om:content-a:transcript:10:0",
        kind: "transcript",
        contentId: "content-a",
        sourceRevision: 10,
        chunkIndex: 0,
        title: "我做插件那次",
        score: 0.4,
        sameTopic: false,
        excerptHash: excerptHashOf(CHUNK_TEXT),
        text: CHUNK_TEXT,
      },
      {
        id: "om:content-b:approved_draft:3:0",
        kind: "approved_draft",
        contentId: "content-b",
        sourceRevision: 3,
        chunkIndex: 0,
        title: "上一篇放行稿",
        score: 0.2,
        sameTopic: false,
        excerptHash: excerptHashOf("放行稿里那句：维护成本是用理解时间付的。"),
        text: "放行稿里那句：维护成本是用理解时间付的。",
      },
    ],
    rendered: "",
    refs: [],
    scanned: { transcripts: 1, approvedDrafts: 1, excludedSameTopic: 0, skippedForeignTranscripts: 0 },
  };

  const ownAnchor = (over: Record<string, unknown> = {}) => ({
    kind: "transcript",
    chunk_id: "om:content-a:transcript:10:0",
    quote: "卡了整整两天才发现纠正被写进了会消失的内存里",
    ...over,
  });

  const runOwn = (over: Record<string, unknown>, cap: Capture = { results: [] }) =>
    run([submitArgs(over)], cap, { ownMaterial: OWN });

  it("转写锚点逐字命中 → 收下 contentId/版本/指纹，打分 +2", async () => {
    const res = await runOwn({ candidates: [cand({ firsthand_anchor: ownAnchor() }), CAND_2, CAND_3] });
    expect(res.status).toBe("succeeded");
    if (res.status !== "succeeded") return;
    expect(res.cards[0].firsthandAnchor).toEqual({
      kind: "transcript",
      contentId: "content-a",
      sourceRevision: 10,
      chunkId: "om:content-a:transcript:10:0",
      excerptHash: excerptHashOf(CHUNK_TEXT),
      quote: "卡了整整两天才发现纠正被写进了会消失的内存里",
    });
    expect(res.cards[0].score).toBe(3); // 证据 1 + 锚点 2
    expect(res.cards[0].scoreReasons).toContain("引文锚点校验通过");
  });

  it("放行稿锚点同样收（kind 必须与片段对得上）", async () => {
    const ok = ownAnchor({
      kind: "approved_draft",
      chunk_id: "om:content-b:approved_draft:3:0",
      quote: "维护成本是用理解时间付的",
    });
    const res = await runOwn({ candidates: [cand({ firsthand_anchor: ok }), CAND_2, CAND_3] });
    expect(res.status).toBe("succeeded");
    if (res.status !== "succeeded") return;
    expect(res.cards[0].firsthandAnchor?.kind).toBe("approved_draft");
    expect(res.cards[0].firsthandAnchor?.sourceRevision).toBe(3);

    const cap: Capture = { results: [] };
    const wrongKind = await runOwn(
      { candidates: [cand({ firsthand_anchor: ownAnchor({ chunk_id: "om:content-b:approved_draft:3:0" }) }), CAND_2, CAND_3] },
      cap,
    );
    expect(wrongKind.status).toBe("failed");
    expect(cap.results[0]).toContain("kind 是 approved_draft");
  });

  it("转述（非逐字）→ 打回", async () => {
    const cap: Capture = { results: [] };
    const res = await runOwn(
      { candidates: [cand({ firsthand_anchor: ownAnchor({ quote: "我卡了两天才发现内存会丢" }) }), CAND_2, CAND_3] },
      cap,
    );
    expect(res.status).toBe("failed");
    expect(cap.results[0]).toContain("逐字");
  });

  it("引一个不存在的片段 id → 打回（编不出第一手材料）", async () => {
    const cap: Capture = { results: [] };
    const res = await runOwn(
      { candidates: [cand({ firsthand_anchor: ownAnchor({ chunk_id: "om:content-zz:transcript:1:0" }) }), CAND_2, CAND_3] },
      cap,
    );
    expect(res.status).toBe("failed");
    expect(cap.results[0]).toContain("om:content-zz:transcript:1:0");
  });

  it("没有内部语料时引 om: 片段 → 打回；简报证据锚点照常收", async () => {
    const cap: Capture = { results: [] };
    const res = await run([submitArgs({ candidates: [cand({ firsthand_anchor: ownAnchor() }), CAND_2, CAND_3] })], cap);
    expect(res.status).toBe("failed");
    expect(cap.results[0]).toContain("不存在");

    const withEv = await runOwn({
      candidates: [
        cand({ firsthand_anchor: { kind: "brief_evidence", chunk_id: "ev-1", quote: "维护成本上升了三成" } }),
        CAND_2,
        CAND_3,
      ],
    });
    expect(withEv.status).toBe("succeeded");
    if (withEv.status !== "succeeded") return;
    expect(withEv.cards[0].firsthandAnchor?.kind).toBe("brief_evidence");
    expect(withEv.cards[0].score).toBe(3);
  });

  it("语料块进用户消息：片段 id 可引、用法规则在场", async () => {
    const user = buildAngleUserMessage({
      brief: makeBrief(),
      topic: TOPIC,
      profile: PROFILE,
      ownMaterial: OWN,
    });
    expect(user).toContain("om:content-a:transcript:10:0");
    expect(user).toContain(CHUNK_TEXT);
    expect(user).toContain("转写可作『我亲身经历的转折』，不可作『讲解另一个主题』");
    // 没有语料就不要出现空块
    expect(buildAngleUserMessage({ brief: makeBrief(), topic: TOPIC, profile: PROFILE })).not.toContain("我自己的材料");
  });

  it("系统提示词：锚点优先引自己的材料，且说清转写不能拿来讲他题", () => {
    const prompt = buildAngleSystemPrompt(PROFILE);
    expect(prompt).toContain("kind=transcript / approved_draft");
    expect(prompt).toContain("转写可作『我亲身经历的转折』，不可作『讲解另一个主题』");
  });
});

// ─── 校验：形状与词表 ────────────────────────────────────────────────────────

describe("按需策划仍校验主目标、结构与引用", () => {
  it("自然叙事允许无误区、无网感元素，只服务一个目标", async () => {
    const cap: Capture = { results: [] };
    const result = await run([submitArgs({
      misconceptions: { grow: [], trust: [], convert: [] },
      candidates: [cand({
        structure: "story", misconception: "", elements: [],
        primary_persona: "trust", persona_gains: { grow: "", trust: "理解一次社区菜园的协作经历", convert: "" },
      }), CAND_2, CAND_3],
    })], cap);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.cards[0]).toMatchObject({ structure: "story", misconception: "", elements: [], personaGains: { grow: "", trust: "理解一次社区菜园的协作经历", convert: "" } });
    expect(result.misconceptions).toEqual({ grow: [], trust: [], convert: [] });
    const tool = cap.opts?.tools?.find(t => t.name === "submit_angles");
    const schema = tool?.parameters as { properties: { candidates: { items: { properties: Record<string, unknown> } } } };
    expect(schema.properties.candidates.items.properties.elements).not.toHaveProperty("minItems");
  });

  it("只有纠偏结构才要求真实误区", async () => {
    expect(await reject({ candidates: [cand({ misconception: "" }), CAND_2, CAND_3] })).toContain("misconception");
  });

  it("主目标收益 / 判断依据不可缺，判断依据不可超长", async () => {
    expect(await reject({ candidates: [cand({ persona_gains: { grow: "", trust: "", convert: "" } }), CAND_2, CAND_3] })).toContain("主目标 grow");
    expect(await reject({ candidates: [cand({ mechanism: "" }), CAND_2, CAND_3] })).toContain("mechanism");
    expect(await reject({ candidates: [cand({ mechanism: "因".repeat(401) }), CAND_2, CAND_3] })).toContain("400 字");
  });

  it("非AI领域可讨论学历等事实，不按关键词否定整张卡", async () => {
    const result = await run([submitArgs({ candidates: [cand({ hook_draft: "招聘时，学历是我们检查的资料之一。" }), CAND_2, CAND_3] })]);
    expect(result.status).toBe("succeeded");
  });

  it("两张卡主张和展开路径雷同仍打回", async () => {
    const msg = await reject({ candidates: [cand(), cand({ angle: "换个说法", primary_persona: "trust" }), CAND_3] });
    expect(msg).toContain("同一个角度换套说法");
  });

  it("用户已定同一主张时，可提供不同叙事路径而不被迫另换主张", async () => {
    const thesis = "社区菜园让邻居在共同照料中建立信任";
    const anti_scope = "不讲商业转化";
    const result = await run([submitArgs({ candidates: [
      cand({ thesis, anti_scope, structure: "story", angle: "从清晨浇水的具体场景进入", mechanism: "记录阿姨递来水壶到大家轮流值班的事件进展，呈现关系如何慢慢改变" }),
      cand({ thesis, anti_scope, structure: "single-point", angle: "解释分工规则为什么能缓解摩擦", mechanism: "分别说明公共土地分配、灌溉责任和收获共享的约定，保留仍有争议的边界" }),
      cand({ thesis, anti_scope, structure: "claim-case-claim", angle: "从一次分歧看参与者怎样形成共识", mechanism: "围绕菜苗损失后的协商过程比较不同参与者的判断，展示经验的适用范围" }),
    ] })], { results: [] }, { creativeTask: { version: 1, direction: thesis, requirements: "保持这个判断，只讨论不同展开方式" } });
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") expect(result.cards.every(card => card.thesis === thesis)).toBe(true);
  });

  it("候选不足 3 个仍打回", async () => {
    expect(await reject({ candidates: [cand(), CAND_2] })).toContain("候选需 3-4 个");
  });

  it("修复轮 ≤2：第三次仍不合法就叫停", async () => {
    const cap: Capture = { results: [] };
    const bad = submitArgs({ candidates: [cand({ core_evidence_ids: ["ev-99"] }), CAND_2, CAND_3] });
    const res = await run([bad, bad, bad], cap);
    expect(res.status).toBe("failed");
    if (res.status !== "failed") return;
    expect(res.errorCode).toBe("invalid_output");
    expect(cap.results[2]).toContain("修复轮已用尽");
  });

  it("先错后对：修好引用之后照常收下", async () => {
    const res = await run([submitArgs({ candidates: [cand({ core_evidence_ids: ["ev-99"] }), CAND_2, CAND_3] }), submitArgs()]);
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

  it("网感元素不增加证据分", () => {
    expect(scoreAngleCard({ ...base, elements: ["爽点", "泪点", "美点", "笑点"] }, brief).score).toBe(0);
    expect(scoreAngleCard({ ...base, elements: [] }, brief).score).toBe(0);
  });

  it("不按劝退等字眼替用户决定立场", () => {
    const got = scoreAngleCard({ ...base, thesis: "不建议在这个季节移栽，因为土壤条件还不合适" }, brief);
    expect(got.score).toBe(scoreAngleCard(base, brief).score);
    expect(scoreAngleCard({ ...base, thesis: "劝退：这个工具你先别碰" }, brief).score).toBe(got.score);
  });

  it("只计可追溯证据和有效锚点，不默认涨粉更重要", () => {
    const grounded = scoreAngleCard({ ...base, evidenceLevel: "grounded", coreEvidenceIds: ["ev-1"], primaryPersona: "grow" }, brief);
    expect(grounded.score).toBe(1);
    expect(scoreAngleCard({ ...base, evidenceLevel: "grounded", coreEvidenceIds: ["ev-1"], primaryPersona: "trust" }, brief).score).toBe(grounded.score);
    expect(scoreAngleCard({ ...base, evidenceLevel: "grounded", coreEvidenceIds: ["ev-404"] }, brief).score).toBe(0);
    const faked = scoreAngleCard({ ...base, firsthandAnchor: { kind: "brief_evidence", chunkId: "ev-1", excerptHash: "deadbeef", quote: "维护成本上升了三成" } }, brief);
    expect(faked.score).toBe(0);
    expect(faked.reasons).toContain("无可校验的引文锚点");
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

it("伪带URL的user_claim仍不能拿到grounded证据分或第一手锚点分", () => {
  const brief = makeBrief();
  brief.evidence[0].source = "user_claim";
  const card = { cardVersion: 3, id: "angle-1", evidenceLevel: "grounded", coreEvidenceIds: ["ev-1"], firsthandAnchor: { kind: "brief_evidence", chunkId: "ev-1", quote: EV_QUOTE, excerptHash: excerptHashOf(EV_QUOTE) } } as AngleCardV3;
  expect(scoreAngleCard(card, brief).score).toBe(0);
});
