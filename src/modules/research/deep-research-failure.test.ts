/**
 * 深调研那条链路的报病与留痕（P2 spec §4.2 / §4.3）。
 *
 * 创始人真机看到的是 `调研失败 · too_few_perspectives`——四路都因为引擎连不上而缺席，
 * 聚合却只数了个数。这里断：全折在引擎上时 `failReason` 换成线路描述，
 * `errorCode` **仍是** `too_few_perspectives`（机器判断的口径不变）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeepResearchRunJob } from "./deep-research.js";
import { pendingPerspectives, topicHashOf, type ResearchJob } from "./research-job-store.js";
import { saveTopic, type Topic } from "../../storage/local-store.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult } from "../../engine/loop.js";

let dataDir: string;

const CONFIG: EngineConfig = {
  apiKey: "sk-relay",
  baseUrl: "https://code.newcli.com/claude/ultra",
  strongModel: "claude-opus-4-8",
  fastModel: "claude-sonnet-5",
  protocol: "anthropic",
  activeProvider: { id: "newcli", role: "main" },
  providers: [
    { id: "newcli", name: "newcli 中转", baseUrl: "https://code.newcli.com/claude/ultra", apiKey: "sk-relay", protocol: "anthropic", models: ["claude-opus-4-8"] },
  ],
};

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-dr-fail-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const newTopic = (): Promise<Topic> =>
  saveTopic({ title: "AI 编程助手横评", description: "真实收益与维护成本", tags: [] }, dataDir);

function jobFor(topic: Topic): ResearchJob {
  return {
    topicId: topic.id,
    status: "running",
    startedAt: "2026-09-05T08:00:00.000Z",
    claimedAt: "2026-09-05T08:00:00.000Z",
    perspectives: pendingPerspectives(),
    topicHash: topicHashOf(topic.title, topic.description),
  };
}

function runJobWith(loop: (cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult>) {
  return createDeepResearchRunJob({
    dataDir,
    engineConfig: CONFIG,
    brokerDeps: { searchImpl: async () => [], fetchImpl: async (url: string) => ({ finalUrl: url, text: "", title: "", imageCandidates: [] }) },
    runLoopImpl: loop,
    onWarn: () => {},
  });
}

describe("四路都折在引擎上（§4.2）", () => {
  it("failReason 换成线路描述，errorCode 仍是 too_few_perspectives", async () => {
    const topic = await newTopic();
    const outcome = await runJobWith(async () => {
      throw new Error("fetch failed");
    })(jobFor(topic));

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("too_few_perspectives"); // 机器口径不变
    expect(outcome.failReason).toContain("调研专线");
    expect(outcome.failReason).toContain("code.newcli.com");
    expect(outcome.failReason).toMatch(/连不上|网络不通/);
    expect(outcome.failReason).not.toContain("fetch failed");
    expect(outcome.failReason).not.toContain("只有 0 路视角成功");
  });

  it("有一路是别的病（没提交）就照旧数数——那时「几路成功」才是准确的说法", async () => {
    const topic = await newTopic();
    let call = 0;
    const outcome = await runJobWith(async () => {
      call += 1;
      if (call === 1) {
        return { finalMessage: "我不提交", turns: 1, totalTokens: 3, toolCallCount: 0, stopReason: "no_tool_calls" };
      }
      throw new Error("fetch failed");
    })(jobFor(topic));

    expect(outcome.errorCode).toBe("too_few_perspectives");
    expect(outcome.failReason).toContain("路视角成功");
  });
});
