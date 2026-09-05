/**
 * 聊天那条链路的报病（P2 spec §4.2 四条链路之一）。
 * 创始人真机看到的那句 `出错了：502 {"error":{"message":"fetch failed"}}` 是这个测试的由来。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { runChatTurn } from "./chat-router.js";
import { shutdownObserver } from "../engine/observer.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-chat-fail-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({
      version: 2,
      providers: [
        { id: "newcli", name: "newcli 中转", baseUrl: "https://code.newcli.com", apiKey: "sk-relay", models: ["relay-strong", "relay-fast"] },
      ],
      main: { provider: "newcli", strong: "relay-strong", fast: "relay-fast" },
    }),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterAll(() => shutdownObserver());

describe("runChatTurn 的失败文案", () => {
  it("上游连不上：说是哪条线、哪个端点、这次没有备用，不再端 fetch failed 原文", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    const res = await runChatTurn({ message: "你好", dataDir: testDir, fetchImpl });
    expect(res.ok).toBe(false);
    const error = res.error as string;
    expect(error).toContain("主端点");
    expect(error).toContain("newcli");
    expect(error).toContain("code.newcli.com");
    expect(error).toMatch(/连不上|网络不通/);
    expect(error).toContain("没有备用端点");
    expect(error).not.toContain("fetch failed");
  });

  it("上游拒 Key：说 401 与「换端点没用」，不是一串 JSON", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const res = await runChatTurn({ message: "你好", dataDir: testDir, fetchImpl });
    expect(res.ok).toBe(false);
    const error = res.error as string;
    expect(error).toContain("401");
    expect(error).toContain("换端点没用");
    expect(error).not.toContain('{"error"');
  });
});
