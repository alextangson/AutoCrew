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
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function mockLoop(args: Record<string, unknown>): typeof runLoop {
  return (async (_c: unknown, opts: { tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> }) => {
    const tool = opts.tools.find((t) => t.name === "submit_audience_review");
    if (tool) await tool.execute({ audienceBasis: { source: "profile", quote: "" }, ...args });
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
    const r = await reviewAudienceStay({ title: "标题", body: "随着 AI 发展，正文", platform: "wechat_mp" }, dir, {
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


it("不把字符串false当true，也不接受编造的原文引用", async () => {
  await seedProfile({ core: CALIBRATED.core, calibratedAt: CALIBRATED.calibratedAt });
  for (const verdict of [
    { tier: "core", name: "小林", wouldStop: "false", why: "原因" },
    { tier: "core", name: "小林", wouldStop: false, why: "原因", losesAt: ["正文里没有这句话"] },
  ]) {
    await expect(reviewAudienceStay({ title: "标题", body: "真实正文" }, dir, { runLoopImpl: mockLoop({ verdicts: [verdict] }) })).rejects.toThrow(/未调用/);
  }
});

it("全文尾段和本次规划交给受众审稿，不静默裁成6000字", async () => {
  await seedProfile({ core: CALIBRATED.core, calibratedAt: CALIBRATED.calibratedAt });
  let message = "";
  const impl = (async (config, opts) => {
    message = opts.userMessage;
    return mockLoop({ verdicts: [{ tier: "core", name: "小林", wouldStop: false, why: "结尾脱离本次受众", losesAt: ["最后一个具体场景"] }] })(config, opts);
  }) as typeof runLoop;
  await reviewAudienceStay({ title: "标题", body: "文".repeat(6500) + "最后一个具体场景", writingContract: "这篇写给仓库主管" }, dir, { runLoopImpl: impl });
  expect(message).toContain("最后一个具体场景");
  expect(message).toContain("这篇写给仓库主管");
});


it("本次任务受众覆盖长期画像时回执标明实际依据，不冒用旧画像", async () => {
  await seedProfile(CALIBRATED);
  const result = await reviewAudienceStay({ title: "仓库", body: "今天跟着仓管走了一遍。", writingContract: "这篇只写给仓库主管" }, dir, {
    runLoopImpl: mockLoop({ audienceBasis: { source: "current_task", quote: "只写给仓库主管" }, verdicts: [{ tier: "core", name: "仓库主管", wouldStop: true, why: "工作处境具体" }] }),
  });
  expect(result.personaUsed).toContain("仓库主管");
  expect(result.personaUsed).not.toContain("小林");
  expect(result.verdicts).toHaveLength(1);
});

it("受众点评使用与语义审稿相同的reviewer岗位线路", async () => {
  await seedProfile({ core: CALIBRATED.core, calibratedAt: CALIBRATED.calibratedAt });
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "fixture", strongModel: "default-model", routes: { reviewer: { model: "review-only-model", baseUrl: "https://review.example.test/v1" } } }));
  let seenModel = "";
  let seenBase = "";
  await reviewAudienceStay({ title: "标题", body: "正文" }, dir, { runLoopImpl: (async (config, opts) => {
    seenModel = opts.model;
    seenBase = config.baseUrl;
    return mockLoop({ verdicts: [{ tier: "core", name: "小林", wouldStop: true, why: "有具体场景" }] })(config, opts);
  }) as typeof runLoop });
  expect(seenModel).toBe("review-only-model");
  expect(seenBase).toContain("review.example.test");
});
