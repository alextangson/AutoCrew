import { describe, it, expect } from "vitest";
import { buildScriptPrompts, type ScriptRequest } from "./script-prompt.js";
import { KOUBO_PACK } from "../packs/koubo.js";
import type { CreatorProfile } from "../profile/creator-profile.js";

describe("buildScriptPrompts", () => {
  it("system prompt contains 口播脚本编剧 role + pack name", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.system).toContain("口播脚本编剧");
    expect(result.system).toContain(KOUBO_PACK.name);
  });

  it("system prompt contains all hooks with type and whenToUse", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    for (const hook of KOUBO_PACK.hooks) {
      expect(result.system).toContain(hook.type);
      expect(result.system).toContain(hook.whenToUse);
    }
  });

  it("system prompt contains hook instruction: 只选一种最强", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.system).toContain("只选一种最强");
  });

  it("system prompt contains all rules from pack.structure (hook/body/cta)", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    for (const rule of KOUBO_PACK.structure.hook) {
      expect(result.system).toContain(rule);
    }
    for (const rule of KOUBO_PACK.structure.body) {
      expect(result.system).toContain(rule);
    }
    for (const rule of KOUBO_PACK.structure.cta) {
      expect(result.system).toContain(rule);
    }
  });

  it("system prompt contains platformAdjustments for requested platform", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    const douyin = KOUBO_PACK.platformAdjustments.douyin;
    if (douyin) {
      expect(result.system).toContain(douyin.chars);
      expect(result.system).toContain(douyin.style);
    }
  });

  it("system prompt skips platformAdjustments cleanly when platform not in pack", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "xiaohongshu" };
    // xiaohongshu is in KOUBO_PACK, so we test with a synthetic variant
    // Create a minimal pack without xiaohongshu adjustment
    const packNoXhs = {
      ...KOUBO_PACK,
      platformAdjustments: {
        douyin: KOUBO_PACK.platformAdjustments.douyin,
        wechat_mp: KOUBO_PACK.platformAdjustments.wechat_mp,
        wechat_video: KOUBO_PACK.platformAdjustments.wechat_video,
        bilibili: KOUBO_PACK.platformAdjustments.bilibili,
      },
    };

    const req2: ScriptRequest = { topic: "AI技能", platform: "xiaohongshu" };
    const result = buildScriptPrompts(packNoXhs, null, req2);
    expect(result.system).not.toContain("undefined");
    expect(result.system.length > 0).toBe(true);
  });

  it("system prompt contains profile writingRules when profile is not null", () => {
    const profile: CreatorProfile = {
      industry: "AI教育",
      platforms: ["douyin", "xiaohongshu"],
      audiencePersona: null,
      writingRules: [
        { rule: "使用第二人称直接对话", source: "user_explicit", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z" },
        { rule: "每段以问句结尾以引起思考", source: "auto_distilled", confidence: 0.8, createdAt: "2026-01-02T00:00:00Z" },
      ],
      styleBoundaries: { never: ["专业术语堆砌"], always: ["口语化表达"] },
      competitorAccounts: [],
      performanceHistory: [],
      styleCalibrated: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, profile, req);

    for (const rule of profile.writingRules) {
      expect(result.system).toContain(rule.rule);
    }
    for (const neverItem of profile.styleBoundaries.never) {
      expect(result.system).toContain(neverItem);
    }
    for (const alwaysItem of profile.styleBoundaries.always) {
      expect(result.system).toContain(alwaysItem);
    }
  });

  it("system prompt does not contain undefined when profile is null", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.system).not.toContain("undefined");
    expect(result.system.length > 0).toBe(true);
  });

  it("system prompt contains complianceNote from pack", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.system).toContain(KOUBO_PACK.complianceNote);
  });

  it("system prompt contains instruction: 必须调用 submit_script 工具提交成品", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.system).toContain("submit_script");
    expect(result.system).toContain("必须");
  });

  it("user prompt contains topic", () => {
    const req: ScriptRequest = { topic: "AI时代普通人最该练的一个技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.user).toContain(req.topic);
  });

  it("user prompt contains platform name (Chinese or English)", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.user).toContain("douyin");
  });

  it("user prompt contains research text when provided", () => {
    const research = "2023年数据显示AI技能需求增长300%";
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin", research };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.user).toContain(research);
  });

  it("user prompt contains fallback line when research is absent", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.user).toContain("无调研材料");
    expect(result.user).toContain("基于常识");
    expect(result.user).toContain("避免编造数据");
  });

  it("system prompt renders koubo structureModes (V5.7 活人感重写)", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.system).toContain("结构模式");
    expect(result.system).toContain("单点打穿");
    expect(result.system).toContain("亲历复盘");
  });

  it("system prompt renders selfReview checklist (此前只活在 MCP 路径)", () => {
    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, null, req);
    expect(result.system).toContain("提交前自检");
    for (const q of KOUBO_PACK.selfReview) {
      expect(result.system).toContain(q);
    }
  });

  it("system prompt skips disabled writing rules and includes enabled ones", () => {
    const profile: CreatorProfile = {
      industry: "AI教育",
      platforms: ["douyin"],
      audiencePersona: null,
      writingRules: [
        { rule: "启用的规则", source: "user_explicit", confidence: 1, createdAt: "2026-01-01T00:00:00Z" },
        { rule: "停用的规则", source: "user_explicit", confidence: 1, createdAt: "2026-01-01T00:00:00Z", disabled: true },
      ],
      styleBoundaries: { never: [], always: [] },
      competitorAccounts: [],
      performanceHistory: [],
      styleCalibrated: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };
    const result = buildScriptPrompts(KOUBO_PACK, profile, req);

    expect(result.system).toContain("启用的规则");
    expect(result.system).not.toContain("停用的规则");
  });
});

describe("voice sections (V5.7 活人感)", () => {
  const baseProfile: CreatorProfile = {
    industry: "AI教育",
    platforms: ["douyin"],
    audiencePersona: null,
    writingRules: [],
    styleBoundaries: { never: [], always: [] },
    competitorAccounts: [],
    performanceHistory: [],
    styleCalibrated: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const req: ScriptRequest = { topic: "AI技能", platform: "douyin" };

  it("renders voiceSamples with mimic-not-copy instruction", () => {
    const profile = { ...baseProfile, voiceSamples: ["创业者找我聊的时候,十有八九先问买哪个课。"] };
    const result = buildScriptPrompts(KOUBO_PACK, profile, req);

    expect(result.system).toContain("创作者声音样本");
    expect(result.system).toContain("创业者找我聊的时候");
    expect(result.system).toContain("禁止照抄");
  });

  it("renders contrast pairs with before/after and note", () => {
    const result = buildScriptPrompts(KOUBO_PACK, baseProfile, req, {
      contrastPairs: [{ before: "赋能你的成长", after: "帮你把这事做成", note: "太营销腔" }],
    });

    expect(result.system).toContain("改稿方向");
    expect(result.system).toContain("赋能你的成长");
    expect(result.system).toContain("帮你把这事做成");
    expect(result.system).toContain("太营销腔");
  });

  it("omits both sections when no samples or pairs exist", () => {
    const result = buildScriptPrompts(KOUBO_PACK, baseProfile, req, { contrastPairs: [] });
    expect(result.system).not.toContain("创作者声音样本");
    expect(result.system).not.toContain("改稿方向");
  });
});
