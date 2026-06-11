import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rewriteSelection } from "./selection-rewrite.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-selrewrite-test-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "test-key", baseUrl: "https://fake.local" }),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { total_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("rewriteSelection", () => {
  it("sends selection + instruction + context to the model and returns rewritten text", async () => {
    let captured: Record<string, unknown> = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
    await fs.rm(emptyDir, { recursive: true, force: true });
  });
});
