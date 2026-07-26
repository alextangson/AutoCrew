import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rewriteSelection } from "./selection-rewrite.js";
import { openaiSseResponse, bodyText } from "../../engine/sse-fixtures.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-selrewrite-test-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "test-key", baseUrl: "https://fake.local" }),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  vi.unstubAllEnvs();
});

function completion(content: string): Response {
  // pi-ai 迁移:fetchImpl 现喂观察器上游腿,必须说 SSE 方言
  return openaiSseResponse({
    choices: [{ message: { content } }],
    usage: { total_tokens: 20 },
  });
}

describe("rewriteSelection", () => {
  it("sends selection + instruction + context to the model and returns rewritten text", async () => {
    let captured: Record<string, unknown> = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(bodyText(init as { body?: unknown })) as Record<string, unknown>;
      return completion("改写后的句子。");
    }) as typeof fetch;

    const res = await rewriteSelection(
      {
        body: "第一段。需要改的句子。第三段。",
        selection: "需要改的句子。",
        instruction: "口语一点",
      },
      testDir,
      fetchImpl,
    );

    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).rewritten).toBe("改写后的句子。");
    const messages = captured.messages as Array<{ role: string; content: string }>;
    const user = messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("需要改的句子。");
    expect(user).toContain("口语一点");
    expect(user).toContain("第一段。"); // 上下文带入
  });

  it("rejects empty selection or instruction", async () => {
    const r1 = await rewriteSelection({ body: "x", selection: "", instruction: "改" }, testDir);
    expect(r1.ok).toBe(false);
    const r2 = await rewriteSelection({ body: "x", selection: "x", instruction: " " }, testDir);
    expect(r2.ok).toBe(false);
  });

  it("degrades to needsSetup without engine config", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-selrewrite-empty-"));
    const res = await rewriteSelection({ body: "x", selection: "x", instruction: "改" }, emptyDir);
    expect(res.ok).toBe(false);
    expect(res.needsSetup).toBe(true);
    await fs.rm(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

describe("上下文开窗（V5.2:选区为中心,不再头部截断）", () => {
  it("长稿后部的选区:上下文包含选区周边而非只有开头", async () => {
    let captured: Record<string, unknown> = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(bodyText(init as { body?: unknown })) as Record<string, unknown>;
      return completion("改好了。");
    }) as typeof fetch;

    const head = "开头段落。".repeat(400); // 2000 字开头
    const before = "选区之前的邻居句。";
    const target = "深处待改的句子。";
    const after = "选区之后的邻居句。";
    const body = head + before + target + after + "结尾。".repeat(500);

    const res = await rewriteSelection(
      { body, selection: target, instruction: "更狠一点" },
      testDir,
      fetchImpl,
    );
    expect(res.ok).toBe(true);
    const messages = captured.messages as Array<{ role: string; content: string }>;
    const user = messages.find((m) => m.role === "user")!.content;
    expect(user).toContain(before); // 选区前邻居在窗口内
    expect(user).toContain(after);  // 选区后邻居在窗口内
    expect(user).toContain("…");    // 截断有标注
  });

  it("选区不在 body 里(编辑竞态) → 回退头部截断,不炸", async () => {
    const fetchImpl = (async () => completion("兜底改写。")) as typeof fetch;
    const res = await rewriteSelection(
      { body: "很长的正文。".repeat(1000), selection: "凭空的选区", instruction: "改" },
      testDir,
      fetchImpl,
    );
    expect(res.ok).toBe(true);
  });
});
