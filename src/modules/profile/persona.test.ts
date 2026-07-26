/**
 * persona.test.ts — 受众画像生成与校准（IA v5 V5.1）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateAudiencePersonaProposal, savePersonaCalibrated, gatherPersonaSignals } from "./persona.js";
import { saveProfile, loadProfile } from "./creator-profile.js";
import { saveContent, recordAdoption } from "../../storage/local-store.js";
import type { runLoop } from "../../engine/loop.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-persona-"));
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "sk-test" }), "utf-8");
  await saveProfile({
    industry: "AI 技术,FDE 部署工程师", platforms: ["wechat_mp"],
    audiencePersona: null,
    writingRules: [{ rule: "短句为主", source: "user_explicit", confidence: 1, createdAt: now }],
    styleBoundaries: { never: ["爹味说教"], always: [] }, competitorAccounts: [],
    performanceHistory: [], styleCalibrated: false, createdAt: now, updatedAt: now,
  }, dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** mock loop:调用 submit_persona 工具,模拟模型行为 */
function mockLoop(personaArgs: Record<string, unknown>): typeof runLoop {
  return (async (_config: unknown, opts: { tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> }) => {
    const tool = opts.tools.find((t) => t.name === "submit_persona");
    if (tool) await tool.execute(personaArgs);
    return { stopReason: "tool", turns: 1, totalTokens: 100, finalText: "" };
  }) as unknown as typeof runLoop;
}

describe("generateAudiencePersonaProposal", () => {
  it("生成三层提案:core 必须有 coreAnxiety+painPoints;basis 透出", async () => {
    const { proposal, basis } = await generateAudiencePersonaProposal(dir, {
      runLoopImpl: mockLoop({
        core: { name: "小林", age: "28", job: "创业者", coreAnxiety: "被 AI 降维打击", painPoints: ["不会切入"] },
        adjacent: { name: "晓雯", coreAnxiety: "怕被淘汰", painPoints: ["没技术"] },
        basis: "从定位与写作规则推出",
      }),
    });
    expect(proposal.core.name).toBe("小林");
    expect(proposal.adjacent!.name).toBe("晓雯");
    expect(proposal.calibratedAt).toBeUndefined(); // 提案态无校准章
    expect(basis).toContain("推出");
    // 提案不落库
    const profile = await loadProfile(dir);
    expect(profile!.audiencePersona).toBeNull();
  });

  it("无定位 → 明确报错(画像必须以定位为锚)", async () => {
    const now = new Date().toISOString();
    await saveProfile({
      industry: "", platforms: [], audiencePersona: null, writingRules: [],
      styleBoundaries: { never: [], always: [] }, competitorAccounts: [],
      performanceHistory: [], styleCalibrated: false, createdAt: now, updatedAt: now,
    }, dir);
    await expect(generateAudiencePersonaProposal(dir, { runLoopImpl: mockLoop({}) }))
      .rejects.toThrow(/定位/);
  });

  it("core 缺 coreAnxiety/painPoints → 工具打回自纠;模型不提交 → 报错", async () => {
    await expect(generateAudiencePersonaProposal(dir, {
      runLoopImpl: mockLoop({ core: { name: "空心画像" }, basis: "x" }),
    })).rejects.toThrow(/未调用 submit_persona/);
  });
});

describe("数据回流信号（V5.6）", () => {
  const outcomeLine = (title: string, views: number) =>
    JSON.stringify({
      contentId: null, platform: "xiaohongshu", platformTitle: title, publishedAt: null,
      metricDate: "2026-07-01", metrics: { views, likes: Math.round(views / 10) },
      source: "csv", recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [],
    });

  async function seedSignals() {
    await fs.writeFile(
      path.join(dir, "outcomes.jsonl"),
      [
        outcomeLine("爆款A", 12000),
        outcomeLine("次好B", 5000),
        outcomeLine("中游C", 800),
        outcomeLine("垫底D", 200),
        outcomeLine("扑街E", 60),
      ].join("\n") + "\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "MEMORY.md"),
      "# Memory\n\n## Performance Insights\n\n- 深夜发布互动更高\n- 带具体数字的标题停留更久\n\n## Brand Context\n\n- 不该出现在洞察里\n",
      "utf-8",
    );
    for (const [title, verdict] of [["稿1", "adopted"], ["稿2", "light_edit"], ["稿3", "rewritten"]] as const) {
      const c = await saveContent({ title, body: "正文", platform: "xiaohongshu", status: "draft_ready", tags: [], hashtags: [] }, dir);
      await recordAdoption(c.id, verdict, dir);
    }
  }

  it("gatherPersonaSignals:表现 top/bottom、采纳率、记忆洞察各自成块", async () => {
    await seedSignals();
    const s = await gatherPersonaSignals(dir);
    expect(s.outcomes).toContain("爆款A");
    expect(s.outcomes).toContain("表现最差");
    expect(s.outcomes).toContain("扑街E");
    expect(s.adoption).toContain("已裁决 3 篇");
    expect(s.adoption).toContain("67%");
    expect(s.insights).toContain("深夜发布");
    expect(s.insights).not.toContain("不该出现");
  });

  it("空目录 → 三块全空(不注入噪声,不抛错)", async () => {
    const s = await gatherPersonaSignals(dir);
    expect(s).toEqual({ outcomes: "", adoption: "", insights: "" });
  });

  it("信号注入画像 prompt:userMessage 携带表现/采纳/洞察", async () => {
    await seedSignals();
    let seenUser = "";
    const capture: typeof runLoop = (async (_config: unknown, opts: { userMessage: string; tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> }) => {
      seenUser = opts.userMessage;
      const tool = opts.tools.find((t) => t.name === "submit_persona");
      if (tool) await tool.execute({ core: { name: "小林", coreAnxiety: "x", painPoints: ["p"] }, basis: "b" });
      return { stopReason: "tool", turns: 1, totalTokens: 100, finalText: "" };
    }) as unknown as typeof runLoop;
    await generateAudiencePersonaProposal(dir, { runLoopImpl: capture });
    expect(seenUser).toContain("爆款A");
    expect(seenUser).toContain("采纳率");
    expect(seenUser).toContain("深夜发布");
  });
});

describe("savePersonaCalibrated", () => {
  it("确认落库:打 calibratedAt 章,写入 profile 唯一事实源", async () => {
    const profile = await savePersonaCalibrated({
      core: { name: "小林", coreAnxiety: "焦虑", painPoints: ["p"] },
      surprise: { name: "老张" },
    }, dir);
    expect(profile.audiencePersona!.calibratedAt).toBeTruthy();
    expect(profile.audiencePersona!.core.name).toBe("小林");
    const reloaded = await loadProfile(dir);
    expect(reloaded!.audiencePersona!.surprise!.name).toBe("老张");
  });

  it("坏形状/空心 core → 拒绝(审核标准不能带病上岗)", async () => {
    await expect(savePersonaCalibrated({ nothing: true }, dir)).rejects.toThrow(/core\.name/);
    await expect(savePersonaCalibrated({ core: { name: "只有名字" } }, dir)).rejects.toThrow(/coreAnxiety/);
  });
});
