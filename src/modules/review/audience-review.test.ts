/**
 * audience-review.test.ts — 受众停留审（IA v5 V5.1）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewAudienceStay } from "./audience-review.js";
import { saveProfile } from "../profile/creator-profile.js";
import type { AudiencePersona } from "../profile/creator-profile.js";
import type { runLoop } from "../../engine/loop.js";

let dir: string;

async function seedProfile(persona: AudiencePersona | null): Promise<void> {
  const now = new Date().toISOString();
  await saveProfile({
    industry: "AI 技术", platforms: ["wechat_mp"], audiencePersona: persona,
    writingRules: [], styleBoundaries: { never: [], always: [] }, competitorAccounts: [],
    performanceHistory: [], styleCalibrated: true, createdAt: now, updatedAt: now,
  }, dir);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-stay-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "sk-test" }), "utf-8");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function mockLoop(args: Record<string, unknown>): typeof runLoop {
  return (async (_c: unknown, opts: { tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> }) => {
    const tool = opts.tools.find((t) => t.name === "submit_audience_review");
    if (tool) await tool.execute(args);
    return { stopReason: "tool", turns: 1, totalTokens: 50, finalText: "" };
  }) as unknown as typeof runLoop;
}

const CALIBRATED: AudiencePersona = {
  core: { name: "小林", coreAnxiety: "被降维打击", painPoints: ["不会切入"], scrollStopTriggers: ["具体做法"] },
  adjacent: { name: "晓雯", coreAnxiety: "怕淘汰" },
  calibratedAt: "2026-07-08T00:00:00.000Z",
};

describe("reviewAudienceStay", () => {
  it("无画像/未校准画像 → 拒绝执行(未经确认的标准不能审稿)", async () => {
    await seedProfile(null);
    await expect(reviewAudienceStay({ title: "t", body: "b" }, dir)).rejects.toThrow(/画像/);

    await seedProfile({ core: CALIBRATED.core }); // 无 calibratedAt = 提案态
    await expect(reviewAudienceStay({ title: "t", body: "b" }, dir)).rejects.toThrow(/提案态|校准/);
  });

  it("happy path:逐层判定 + coreStops 总判定 + 审稿标准透明", async () => {
    await seedProfile(CALIBRATED);
    const r = await reviewAudienceStay({ title: "标题", body: "正文", platform: "wechat_mp" }, dir, {
      runLoopImpl: mockLoop({
        verdicts: [
          { tier: "core", name: "小林", wouldStop: false, why: "开头没打中切入焦虑", losesAt: ["随着 AI 发展"] },
          { tier: "adjacent", name: "晓雯", wouldStop: true, why: "淘汰焦虑被点名" },
        ],
        suggestions: ["开头改成小林的具体处境"],
      }),
    });
    expect(r.coreStops).toBe(false);
    expect(r.verdicts).toHaveLength(2);
    expect(r.verdicts[0].losesAt).toEqual(["随着 AI 发展"]);
    expect(r.suggestions[0]).toContain("小林");
    expect(r.personaUsed).toContain("核心受众=小林");
  });

  it("缺 core 判定 → 工具打回;模型不提交 → 报错", async () => {
    await seedProfile(CALIBRATED);
    await expect(reviewAudienceStay({ title: "t", body: "b" }, dir, {
      runLoopImpl: mockLoop({ verdicts: [{ tier: "adjacent", name: "x", wouldStop: true, why: "y" }] }),
    })).rejects.toThrow(/未调用 submit_audience_review/);
  });
});
