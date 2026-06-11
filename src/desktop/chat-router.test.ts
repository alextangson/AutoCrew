/**
 * chat-router 测试 — 工具→卡片 sink、紧凑 JSON 返回、needsSetup 降级、
 * 端到端 runChatTurn（fetchImpl mock 两轮：tool_call → final）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runChatTurn, buildChatTools, type ChatCard } from "./chat-router.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-chat-test-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "test-key", baseUrl: "https://fake.local" }),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function assistantTurn(content: string | null, toolCalls?: unknown[]) {
  return {
    choices: [
      { message: { role: "assistant", content, tool_calls: toolCalls }, finish_reason: "stop" },
    ],
    usage: { total_tokens: 10 },
  };
}

describe("buildChatTools", () => {
  it("generate_script pushes a draft card and returns compact JSON to the model", async () => {
    const sink: ChatCard[] = [];
    const generate = vi.fn(async () => ({
      ok: true,
      data: { contentId: "c1", title: "T", body: "B", hashtags: ["#a"], violations: [], tokensUsed: 5 },
    }));
    const tools = buildChatTools(sink, testDir, { generate });

    const tool = tools.find((t) => t.name === "generate_script");
    expect(tool).toBeDefined();
    const out = await tool!.execute({ topic: "Excel 快捷键", platform: "douyin" });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "script", topic: "Excel 快捷键", platform: "douyin", _dataDir: testDir }),
    );
    expect(JSON.parse(out as string)).toMatchObject({ ok: true, contentId: "c1", title: "T" });
    expect((out as string).includes("B")).toBe(false); // 正文不进对话上下文
    expect(sink).toHaveLength(1);
    expect(sink[0].type).toBe("draft");
    expect(sink[0].data.contentId).toBe("c1");
  });

  it("add_style_rule records a user_explicit rule and pushes a style card", async () => {
    const sink: ChatCard[] = [];
    const addRule = vi.fn(async () => ({}) as never);
    const tools = buildChatTools(sink, testDir, { addRule });

    const tool = tools.find((t) => t.name === "add_style_rule");
    await tool!.execute({ rule: "口语化，不用书面腔" });

    expect(addRule).toHaveBeenCalledWith(
      { rule: "口语化，不用书面腔", source: "user_explicit", confidence: 1 },
      testDir,
    );
    expect(sink[0].type).toBe("style");
  });

  it("strips model-injected underscore keys (e.g. _dataDir) from tool args", async () => {
    const sink: ChatCard[] = [];
    const generate = vi.fn(async () => ({
      ok: true,
      data: { contentId: "c1", title: "T", body: "B", hashtags: [], violations: [], tokensUsed: 1 },
    }));
    const tools = buildChatTools(sink, testDir, { generate });
    await tools.find((t) => t.name === "generate_script")!.execute({
      topic: "t", platform: "douyin", _dataDir: "/tmp/evil",
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ _dataDir: testDir }));
    expect(generate).not.toHaveBeenCalledWith(expect.objectContaining({ _dataDir: "/tmp/evil" }));
  });

  it("strips _dataDir entirely when no dataDir is configured", async () => {
    const sink: ChatCard[] = [];
    const generate = vi.fn(async () => ({ ok: false, error: "x" }));
    const tools = buildChatTools(sink, undefined, { generate });
    await tools.find((t) => t.name === "generate_script")!.execute({
      topic: "t", platform: "douyin", _dataDir: "/tmp/evil",
    });
    const callArg = generate.mock.calls[0][0] as Record<string, unknown>;
    expect("_dataDir" in callArg).toBe(false);
  });

  it("adapt_platform normalizes the flat rewrite result into a generate-shaped draft card", async () => {
    const sink: ChatCard[] = [];
    const rewrite = vi.fn(async () => ({
      ok: true, platform: "xiaohongshu", title: "新标题", body: "新正文",
      notes: [], titleVariants: [], hashtags: ["#tag"],
      content: { id: "c2", title: "新标题" },
    }));
    const tools = buildChatTools(sink, testDir, { rewrite });
    const out = await tools.find((t) => t.name === "adapt_platform")!.execute({
      content_id: "c1", target_platform: "xiaohongshu",
    });
    expect(sink[0].type).toBe("draft");
    expect(sink[0].data).toMatchObject({ contentId: "c2", title: "新标题", platform: "xiaohongshu" });
    expect(JSON.parse(out as string)).toMatchObject({ ok: true, contentId: "c2" });
  });

  it("tool failure returns ok:false JSON to the model without pushing a card", async () => {
    const sink: ChatCard[] = [];
    const generate = vi.fn(async () => ({ ok: false, error: "缺少必填参数 topic：请提供脚本选题" }));
    const tools = buildChatTools(sink, testDir, { generate });

    const out = await tools.find((t) => t.name === "generate_script")!.execute({ platform: "douyin" });
    expect(JSON.parse(out as string)).toMatchObject({ ok: false });
    expect(sink).toHaveLength(0);
  });

  it("read_url returns page text to the model and pushes no card", async () => {
    const sink: ChatCard[] = [];
    const fetchPage = vi.fn(async () => ({ title: "对标文章", text: "正文内容……", truncated: false }));
    const tools = buildChatTools(sink, testDir, { fetchPage });

    const out = await tools.find((t) => t.name === "read_url")!.execute({ url: "https://example.com/x" });

    expect(fetchPage).toHaveBeenCalledWith("https://example.com/x");
    const parsed = JSON.parse(out as string);
    expect(parsed).toMatchObject({ ok: true, title: "对标文章" });
    expect(parsed.text).toContain("正文内容");
    expect(sink).toHaveLength(0);
  });

  it("read_url marks truncated when router-level 4000 cap applies", async () => {
    const sink: ChatCard[] = [];
    const fetchPage = vi.fn(async () => ({ title: "长文", text: "字".repeat(5000), truncated: false }));
    const tools = buildChatTools(sink, testDir, { fetchPage });
    const out = await tools.find((t) => t.name === "read_url")!.execute({ url: "https://example.com/long" });
    const parsed = JSON.parse(out as string);
    expect(parsed.truncated).toBe(true);
    expect((parsed.text as string).length).toBe(4000);
  });

  it("read_url failure returns ok:false", async () => {
    const sink: ChatCard[] = [];
    const fetchPage = vi.fn(async () => { throw new Error("仅支持 http/https 链接"); });
    const tools = buildChatTools(sink, testDir, { fetchPage });
    const out = await tools.find((t) => t.name === "read_url")!.execute({ url: "file:///x" });
    expect(JSON.parse(out as string)).toMatchObject({ ok: false });
  });
});

describe("runChatTurn", () => {
  it("returns needsSetup when no engine config exists", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-chat-empty-"));
    const res = await runChatTurn({ message: "你好", dataDir: emptyDir });
    expect(res.ok).toBe(false);
    expect(res.needsSetup).toBe(true);
    await fs.rm(emptyDir, { recursive: true, force: true });
  });

  it("runs tool calls and returns reply + cards", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (calls.length === 1) {
        return jsonResponse(
          assistantTurn(null, [
            {
              id: "tc1",
              type: "function",
              function: {
                name: "generate_script",
                arguments: JSON.stringify({ topic: "Excel", platform: "douyin" }),
              },
            },
          ]),
        );
      }
      return jsonResponse(assistantTurn("已生成，看卡片。"));
    }) as typeof fetch;

    const generate = vi.fn(async () => ({
      ok: true,
      data: { contentId: "c9", title: "标题", body: "正文", hashtags: [], violations: [], tokensUsed: 3 },
    }));

    const res = await runChatTurn({
      message: "帮我写一条 Excel 的抖音口播",
      history: [{ role: "user", content: "之前的话" }, { role: "assistant", content: "之前的回复" }],
      dataDir: testDir,
      deps: { generate },
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    const data = res.data as { reply: string; cards: ChatCard[] };
    expect(data.reply).toBe("已生成，看卡片。");
    expect(data.cards).toHaveLength(1);
    expect(data.cards[0].type).toBe("draft");
    // history 注入（system + 2 history + user = 前 4 条）
    const firstMessages = calls[0].messages as Array<{ role: string }>;
    expect(firstMessages.slice(0, 4).map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});
