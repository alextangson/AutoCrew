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
  it("generate_script starts a background run and returns pending immediately (契约 P1 后台化)", async () => {
    const sink: ChatCard[] = [];
    const startGenerate = vi.fn(async () => ({
      contentId: "c1", runId: "run-bg-1", completion: Promise.resolve(),
    }));
    const tools = buildChatTools(sink, testDir, { startGenerate });

    const tool = tools.find((t) => t.name === "generate_script");
    expect(tool).toBeDefined();
    const out = await tool!.execute({ topic: "Excel 快捷键", platform: "douyin" });

    expect(startGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "Excel 快捷键", platform: "douyin" }),
      testDir,
    );
    const parsed = JSON.parse(out as string);
    expect(parsed).toMatchObject({ ok: true, pending: true, contentId: "c1" });
    expect(sink).toHaveLength(0); // 成稿没出来,不推 draft 卡——占位卡在看板,进度在任务带
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

  it("revise_draft updates the current content in place and returns the saved version", async () => {
    const sink: ChatCard[] = [];
    const reviseDraftImpl = vi.fn(async () => ({
      content: {
        id: "content-42",
        title: "更直接的新标题",
        body: "修改后的完整正文",
        platform: "wechat_mp",
        status: "draft_ready",
        versions: [{ version: 1 }, { version: 2 }],
      },
      tokensUsed: 100,
    })) as never;
    const tools = buildChatTools(sink, testDir, { reviseDraftImpl });

    const out = await tools.find((tool) => tool.name === "revise_draft")!.execute({
      content_id: "content-42",
      instruction: "开头更直接，删掉 AI 腔",
    });

    expect(reviseDraftImpl).toHaveBeenCalledWith("content-42", "开头更直接，删掉 AI 腔", testDir);
    expect(JSON.parse(out as string)).toMatchObject({ ok: true, contentId: "content-42", version: 2 });
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ type: "draft", data: { contentId: "content-42", version: 2 } });
  });

  it("get_draft returns the full body to the model (上下文承诺「可用 get_draft 读全文」)", async () => {
    const sink: ChatCard[] = [];
    const content = vi.fn(async () => ({
      ok: true,
      content: {
        id: "content-9",
        title: "AI 转型难在哪",
        body: "第一段：流程不在系统里。\n\n第二段：SOP 是假的。",
        status: "draft_ready",
        platform: "wechat_mp",
      },
    }));
    const tools = buildChatTools(sink, testDir, { content });

    const out = JSON.parse(
      (await tools.find((t) => t.name === "get_draft")!.execute({ id: "content-9" })) as string,
    );

    expect(out).toMatchObject({
      ok: true,
      id: "content-9",
      title: "AI 转型难在哪",
      body: "第一段：流程不在系统里。\n\n第二段：SOP 是假的。",
    });
    expect(sink[0]).toMatchObject({ type: "draft" }); // 全文卡片照旧推给 UI
  });

  it("strips model-injected underscore keys (e.g. _dataDir) from tool args", async () => {
    const sink: ChatCard[] = [];
    const rewrite = vi.fn(async () => ({ ok: false, error: "x" }));
    const tools = buildChatTools(sink, testDir, { rewrite });
    await tools.find((t) => t.name === "adapt_platform")!.execute({
      content_id: "c1", target_platform: "xiaohongshu", _dataDir: "/tmp/evil",
    });
    expect(rewrite).toHaveBeenCalledWith(expect.objectContaining({ _dataDir: testDir }));
    expect(rewrite).not.toHaveBeenCalledWith(expect.objectContaining({ _dataDir: "/tmp/evil" }));
  });

  it("strips _dataDir entirely when no dataDir is configured", async () => {
    const sink: ChatCard[] = [];
    const rewrite = vi.fn(async () => ({ ok: false, error: "x" }));
    const tools = buildChatTools(sink, undefined, { rewrite });
    await tools.find((t) => t.name === "adapt_platform")!.execute({
      content_id: "c1", target_platform: "xiaohongshu", _dataDir: "/tmp/evil",
    });
    const callArg = rewrite.mock.calls[0][0] as Record<string, unknown>;
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
    const startGenerate = vi.fn(async () => { throw new Error("占位稿创建失败：磁盘只读"); });
    const tools = buildChatTools(sink, testDir, { startGenerate });

    const out = await tools.find((t) => t.name === "generate_script")!.execute({ topic: "t", platform: "douyin" });
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

  it("find_topics pushes a topic card and returns compact candidates", async () => {
    const sink: ChatCard[] = [];
    const topics = vi.fn(async () => [
      { title: "OpenAI 新模型", link: "https://a.com/1", source: "36氪", publishedAt: "2026-06-11T01:00:00Z" },
      { title: "AI 编程趋势", link: "https://a.com/2", source: "爱范儿", publishedAt: "2026-06-11T02:00:00Z" },
    ]);
    const tools = buildChatTools(sink, testDir, { topics });

    const out = await tools.find((t) => t.name === "find_topics")!.execute({});

    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]).toMatchObject({ title: "OpenAI 新模型", source: "36氪" });
    expect(parsed.candidates[0].link).toBeUndefined(); // link 不进对话上下文（token 纪律）
    expect(sink).toHaveLength(1);
    expect(sink[0].type).toBe("topic");
    expect((sink[0].data.candidates as unknown[]).length).toBe(2);
  });

  it("find_topics with empty radar returns ok:false guidance", async () => {
    const sink: ChatCard[] = [];
    const topics = vi.fn(async () => []);
    const tools = buildChatTools(sink, testDir, { topics });
    const out = await tools.find((t) => t.name === "find_topics")!.execute({});
    expect(JSON.parse(out as string)).toMatchObject({ ok: false });
    expect(sink).toHaveLength(0);
  });

  it("find_overseas_topics calls research overseas (no auto-save) and pushes a topic card", async () => {
    const sink: ChatCard[] = [];
    const research = vi.fn(async () => ({
      ok: true,
      mode: "overseas",
      candidates: [
        { title: "openai/gpt", description: "GPT models", source: "web_search: https://github.com/openai/gpt", viralScore: 73 },
        { title: "Norway bans AI", description: "…", source: "web_search: https://news.ycombinator.com/item?id=1", viralScore: 68 },
      ],
    }));
    const tools = buildChatTools(sink, testDir, { research });

    const out = await tools.find((t) => t.name === "find_overseas_topics")!.execute({ keyword: "AI agent" });

    expect(research).toHaveBeenCalledTimes(1);
    expect(research.mock.calls[0][0]).toMatchObject({
      action: "discover",
      mode: "overseas",
      keyword: "AI agent",
      save_topics: false,
    });

    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0].source).toBe("github.com"); // cleaned from "web_search: https://…"

    expect(sink).toHaveLength(1);
    expect(sink[0].type).toBe("topic");
    expect((sink[0].data.candidates as unknown[]).length).toBe(2);
  });

  it("find_overseas_topics returns ok:false when no candidates", async () => {
    const sink: ChatCard[] = [];
    const research = vi.fn(async () => ({ ok: true, candidates: [] }));
    const tools = buildChatTools(sink, testDir, { research });
    const out = await tools.find((t) => t.name === "find_overseas_topics")!.execute({ keyword: "AI" });
    expect(JSON.parse(out as string)).toMatchObject({ ok: false });
    expect(sink).toHaveLength(0);
  });
});

describe("runChatTurn onEvent", () => {
  it("runChatTurn maps tool events to crew roles and forwards them", async () => {
    const calls: number[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      if (calls.length === 1) {
        return jsonResponse(assistantTurn(null, [
          { id: "t1", type: "function", function: { name: "generate_script", arguments: JSON.stringify({ topic: "x", platform: "douyin" }) } },
        ]));
      }
      return jsonResponse(assistantTurn("好了"));
    }) as typeof fetch;
    const generate = vi.fn(async () => ({
      ok: true,
      data: { contentId: "c1", title: "t", body: "b", hashtags: [], violations: [], tokensUsed: 1 },
    }));

    const events: Array<Record<string, unknown>> = [];
    const res = await runChatTurn({
      message: "写一条",
      dataDir: testDir,
      deps: { generate },
      fetchImpl,
      onEvent: (e) => events.push(e as unknown as Record<string, unknown>),
    });

    expect(res.ok).toBe(true);
    expect(events).toEqual([
      { phase: "start", tool: "generate_script", role: "writer", label: "编剧正在写稿" },
      { phase: "end", tool: "generate_script", role: "writer", label: "编剧正在写稿" },
    ]);
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

    const startGenerate = vi.fn(async () => ({
      contentId: "c9", runId: "run-bg-9", completion: Promise.resolve(),
    }));

    const res = await runChatTurn({
      message: "帮我写一条 Excel 的抖音口播",
      history: [{ role: "user", content: "之前的话" }, { role: "assistant", content: "之前的回复" }],
      dataDir: testDir,
      deps: { startGenerate },
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    const data = res.data as { reply: string; cards: ChatCard[] };
    expect(data.reply).toBe("已生成，看卡片。");
    expect(startGenerate).toHaveBeenCalledOnce(); // 后台启动,不再有 draft 卡
    expect(data.cards).toHaveLength(0);
    // history 注入（system + 2 history + user = 前 4 条）
    const firstMessages = calls[0].messages as Array<{ role: string }>;
    expect(firstMessages.slice(0, 4).map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("returns a visible fallback instead of a blank assistant reply", async () => {
    const fetchImpl = (async () => jsonResponse(assistantTurn("   "))) as typeof fetch;
    const res = await runChatTurn({ message: "你好", dataDir: testDir, fetchImpl });
    expect(res.ok).toBe(true);
    expect((res.data as { reply: string }).reply).toContain("没有返回可显示内容");
  });
});

describe("context awareness + intake tools (IA v4.2 C1/A2/C3)", () => {
  it("viewContext prefixes the model userMessage; positioning enters system prompt", async () => {
    await fs.writeFile(
      path.join(testDir, "creator-profile.json"),
      JSON.stringify({
        industry: "AI 效率工具",
        platforms: ["wechat_mp"],
        audiencePersona: { name: "效率控上班族", painPoints: ["会用但不精"] },
        writingRules: [], styleBoundaries: { never: [], always: [] },
        competitorAccounts: [], performanceHistory: [], styleCalibrated: true,
        createdAt: "2026-01-01", updatedAt: "2026-01-01",
      }),
    );
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse(assistantTurn("好的"));
    }) as typeof fetch;

    const res = await runChatTurn({
      message: "开头改口语一点",
      dataDir: testDir,
      viewContext: { contentId: "content-42", contentTitle: "AI 写作趋势", platform: "wechat_mp" },
      fetchImpl,
    });

    expect(res.ok).toBe(true);
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("创作者定位：AI 效率工具");
    expect(messages[0].content).toContain("效率控上班族");
    const lastUser = messages[messages.length - 1];
    expect(lastUser.content).toContain("content-42");
    expect(lastUser.content).toContain("AI 写作趋势");
    expect(lastUser.content).toContain("开头改口语一点");
  });

  it("save_topic persists via saveTopicImpl and pushes a topic_saved card", async () => {
    const sink: ChatCard[] = [];
    const saveTopicImpl = vi.fn(async (t: Record<string, unknown>) => ({
      ...t, id: "topic-1", createdAt: "2026-01-01",
    })) as never;
    const tools = buildChatTools(sink, testDir, { saveTopicImpl });

    const tool = tools.find((t) => t.name === "save_topic");
    const out = await tool!.execute({ title: "AI 眼镜实测", reason: "命中定位", link: "https://x.example/1" });

    expect(saveTopicImpl).toHaveBeenCalledWith(
      expect.objectContaining({ title: "AI 眼镜实测", reason: "命中定位", link: "https://x.example/1", source: "chat" }),
      testDir,
    );
    expect(JSON.parse(out as string)).toMatchObject({ ok: true, id: "topic-1" });
    expect(sink[0].type).toBe("topic_saved");
  });

  it("push_wechat_draft only emits a confirm card — publish is NOT called (§C3 confirm gate)", async () => {
    const sink: ChatCard[] = [];
    const publish = vi.fn();
    const tools = buildChatTools(sink, testDir, { publish: publish as never });

    const tool = tools.find((t) => t.name === "push_wechat_draft");
    const out = await tool!.execute({ content_id: "c7", title: "标题" });

    expect(publish).not.toHaveBeenCalled();
    expect(sink).toHaveLength(1);
    expect(sink[0].type).toBe("publish_confirm");
    expect(sink[0].data).toMatchObject({ contentId: "c7", target: "公众号草稿箱" });
    expect(JSON.parse(out as string)).toMatchObject({ ok: true, pending_user_confirmation: true });
  });
});

describe("search_assets tool", () => {
  it("returns compact results and pushes an assets card", async () => {
    const sink: ChatCard[] = [];
    const tools = buildChatTools(sink, undefined, {
      libSearch: async () => [
        { id: "asset-1-a", name: "Excel钩子.mp4", path: "/x/a.mp4", type: "video", ext: "mp4", size: 10, folderId: null, tags: ["钩子"], addedAt: "2026-06-11T00:00:00.000Z", missing: false },
      ],
    });
    const tool = tools.find((t) => t.name === "search_assets")!;
    const out = JSON.parse(await tool.execute({ query: "excel" }));
    expect(out.ok).toBe(true);
    expect(out.total).toBe(1);
    expect(out.assets[0]).toMatchObject({ name: "Excel钩子.mp4", type: "video", missing: false });
    expect(sink).toHaveLength(1);
    expect(sink[0].type).toBe("assets");
  });

  it("empty library returns note without a card", async () => {
    const sink: ChatCard[] = [];
    const tools = buildChatTools(sink, undefined, { libSearch: async () => [] });
    const tool = tools.find((t) => t.name === "search_assets")!;
    const out = JSON.parse(await tool.execute({ query: "啥都没有" }));
    expect(out.ok).toBe(true);
    expect(out.total).toBe(0);
    expect(sink).toHaveLength(0);
  });

  it("passes missing flag through", async () => {
    const sink: ChatCard[] = [];
    const tools = buildChatTools(sink, undefined, {
      libSearch: async () => [
        { id: "asset-1-b", name: "丢了.png", path: "/x/b.png", type: "image", ext: "png", size: 1, folderId: null, tags: [], addedAt: "2026-06-11T00:00:00.000Z", missing: true },
      ],
    });
    const tool = tools.find((t) => t.name === "search_assets")!;
    const out = JSON.parse(await tool.execute({}));
    expect(out.assets[0].missing).toBe(true);
  });
});
