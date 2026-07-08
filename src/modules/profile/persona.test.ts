/**
 * persona.test.ts — 受众画像生成与校准（IA v5 V5.1）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateAudiencePersonaProposal, savePersonaCalibrated } from "./persona.js";
import { saveProfile, loadProfile } from "./creator-profile.js";
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
  await fs.rm(dir, { recursive: true, force: true });
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
