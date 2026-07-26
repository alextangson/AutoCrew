/**
 * generate-script.test.ts — 全 mock，零网络
 *
 * 假 runLoopImpl 实际调用 submit_script 工具的 execute 处理器，
 * 这是捕获机制的关键：execute 闭包把 payload 写进外部变量。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateScript, startGenerateScript } from "./generate-script.js";
import type { GeneratedScript } from "./generate-script.js";
import { getContent, listContents } from "../../storage/local-store.js";
import type { LoopResult, LoopTool, LoopOptions } from "../../engine/loop.js";
import type { EngineConfig } from "../../engine/config.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-genscript-test-"));
  // Write a minimal engine.json so loadEngineConfig succeeds
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "sk-test", strongModel: "m-strong", fastModel: "m-fast" }),
  );
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/**
 * Build a fake runLoopImpl that calls submit_script with the given payloads in order.
 * Each execute return value is pushed into execResults (for asserting error guidance).
 */
function makeRunLoop(
  payloads: Array<Record<string, unknown>>,
  tokens = 150,
  execResults: string[] = [],
): (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult> {
  return async (_cfg, opts) => {
    const submitTool = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_script");
    if (!submitTool) throw new Error("submit_script tool not found in opts");

    for (const payload of payloads) {
      execResults.push(await submitTool.execute(payload));
    }

    return {
      finalMessage: "脚本已提交",
      turns: payloads.length + 1,
      totalTokens: tokens,
      toolCallCount: payloads.length,
      stopReason: "no_tool_calls",
    } satisfies LoopResult;
  };
}

const GOOD_PAYLOAD = {
  title: "普通人怎么用AI赚钱",
  hook: "你知道吗，身边有人靠AI每月多赚五千",
  body: "AI工具让普通人也能做到这些事情，关键是选对方向",
  cta: "关注我，每周分享AI变现实战",
  hashtags: ["#AI赚钱", "#普通人逆袭"],
};

const TEST_REQ = {
  topic: "AI时代普通人赚钱",
  platform: "douyin" as const,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("generateScript", () => {
  it("uses the dedicated writer route when configured", async () => {
    await fs.writeFile(
      path.join(testDir, "engine.json"),
      JSON.stringify({
        apiKey: "sk-shared",
        strongModel: "m-strong",
        fastModel: "m-fast",
        routes: {
          writer: {
            baseUrl: "https://code.newcli.com/claude/ultra",
            model: "claude-opus-4-8",
            protocol: "anthropic",
          },
        },
      }),
    );
    let seenConfig: EngineConfig | undefined;
    let seenModel = "";
    const runLoopImpl = async (cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      seenConfig = cfg;
      seenModel = opts.model;
      const submitTool = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
      await submitTool.execute(GOOD_PAYLOAD);
      return { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };
    await generateScript(TEST_REQ, testDir, { runLoopImpl });
    expect(seenModel).toBe("claude-opus-4-8");
    expect(seenConfig?.baseUrl).toBe("https://code.newcli.com/claude/ultra");
    expect(seenConfig?.protocol).toBe("anthropic");
    expect(seenConfig?.apiKey).toBe("sk-shared");
  });

  // 1. Happy path
  it("happy path: saves draft, returns correct fields, violations empty", async () => {
    const runLoopImpl = makeRunLoop([GOOD_PAYLOAD], 200);
    const result: GeneratedScript = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    // Return shape
    expect(result.contentId).toMatch(/^content-/);
    expect(result.title).toBe(GOOD_PAYLOAD.title);
    expect(result.hashtags).toEqual(GOOD_PAYLOAD.hashtags);
    expect(result.violations).toEqual([]);
    expect(result.tokensUsed).toBe(200);

    // body contains hook AND cta
    expect(result.body).toContain(GOOD_PAYLOAD.hook);
    expect(result.body).toContain(GOOD_PAYLOAD.cta);

    // Draft persisted in local-store
    const saved = await getContent(result.contentId, testDir);
    expect(saved).not.toBeNull();
    expect(saved!.title).toBe(GOOD_PAYLOAD.title);
    expect(saved!.hashtags).toEqual(GOOD_PAYLOAD.hashtags);
    expect(saved!.status).toBe("draft_ready");

    // Also verifiable via listContents
    const all = await listContents(testDir);
    expect(all.some((c) => c.id === result.contentId)).toBe(true);
  });

  // 2. Self-correction: first call is missing cta, second is full
  it("self-correction: missing cta → execute returns error message, second full call succeeds", async () => {
    const missingCta = { ...GOOD_PAYLOAD };
    // @ts-expect-error intentionally missing cta for test
    delete missingCta.cta;

    let firstCallResult: string | undefined;

    const runLoopImpl: (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult> = async (
      _cfg,
      opts,
    ) => {
      const submitTool = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_script");
      if (!submitTool) throw new Error("submit_script tool not found");

      // First call: missing cta
      firstCallResult = await submitTool.execute(missingCta as Record<string, unknown>);

      // Second call: full payload
      await submitTool.execute(GOOD_PAYLOAD);

      return {
        finalMessage: "done",
        turns: 3,
        totalTokens: 300,
        toolCallCount: 2,
        stopReason: "no_tool_calls",
      } satisfies LoopResult;
    };

    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    // First call must return the error guidance
    expect(firstCallResult).toContain("缺少字段 cta");
    expect(firstCallResult).toContain("submit_script");

    // Final result is from the second (complete) call
    expect(result.title).toBe(GOOD_PAYLOAD.title);
    expect(result.contentId).toMatch(/^content-/);
  });

  // 3. Never submits → rejects
  it("never submits → throws descriptive Chinese error", async () => {
    const runLoopImpl: (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult> = async () => {
      return {
        finalMessage: "我不想调工具",
        turns: 4,
        totalTokens: 100,
        toolCallCount: 0,
        stopReason: "max_turns",
      } satisfies LoopResult;
    };

    await expect(generateScript(TEST_REQ, testDir, { runLoopImpl })).rejects.toThrow(
      /submit_script|脚本|未提交/,
    );
  });

  // 3b. 防呆 P1:中途死不许蒸发——失败时占位稿留在盘上,带中断标题与 lastError
  it("failure leaves a placeholder draft with lastError (write-half-then-vanish is dead)", async () => {
    const runLoopImpl: (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult> = async () => {
      throw new Error("relay 断流：ECONNRESET");
    };

    await expect(generateScript(TEST_REQ, testDir, { runLoopImpl })).rejects.toThrow("ECONNRESET");

    const all = await listContents(testDir);
    expect(all).toHaveLength(1);
    const placeholder = all[0];
    expect(placeholder.status).toBe("drafting");
    expect(placeholder.title).toContain("［生成中断］");
    expect(placeholder.lastError).toContain("ECONNRESET");
  });

  // 3c. 防呆 P1:成功 = 占位稿原地转正（同一 id,不留孤儿占位）,lastError 清空
  it("success promotes the placeholder in place — one content, no orphan", async () => {
    const runLoopImpl = makeRunLoop([GOOD_PAYLOAD], 200);
    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    const all = await listContents(testDir);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(result.contentId);
    expect(all[0].status).toBe("draft_ready");
    expect(all[0].title).toBe(GOOD_PAYLOAD.title);
    expect(all[0].lastError ?? null).toBeNull();
  });

  // 3d. 生产计时:转正即盖「稿成」戳,起点用占位稿的 createdAt(开写),两戳成一段用时
  it("promotion stamps draftReadyAt — createdAt(开写) → draftReadyAt(稿成) is a real span", async () => {
    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl: makeRunLoop([GOOD_PAYLOAD]) });
    const saved = await getContent(result.contentId, testDir);

    expect(saved!.draftReadyAt).toBeTruthy();
    const started = Date.parse(saved!.createdAt);
    const ready = Date.parse(saved!.draftReadyAt!);
    expect(Number.isNaN(ready)).toBe(false);
    expect(ready).toBeGreaterThanOrEqual(started); // 稿成不早于开写
  });

  // 3e. 失败的占位稿没成稿 → 不许有稿成戳(否则复盘会把没写完的稿算进用时)
  it("interrupted placeholder carries no draftReadyAt", async () => {
    const runLoopImpl: (_cfg: EngineConfig, opts: LoopOptions) => Promise<LoopResult> = async () => {
      throw new Error("relay 断流");
    };
    await expect(generateScript(TEST_REQ, testDir, { runLoopImpl })).rejects.toThrow();

    const all = await listContents(testDir);
    expect(all[0].draftReadyAt).toBeUndefined();
  });

  // 4. Violations: payload body containing a real sensitive word — draft still saved
  it("violations: sensitive word in body → violations non-empty, draft still saved", async () => {
    // "翻墙" is a real word from the political category in sensitive-words-builtin.json
    const violatingPayload = {
      ...GOOD_PAYLOAD,
      body: "你可以通过翻墙来访问更多信息，AI工具帮你实现变现",
    };

    const runLoopImpl = makeRunLoop([violatingPayload], 180);
    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    // Violations must include the sensitive word
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.some((v) => v.includes("翻墙"))).toBe(true);

    // Draft still persisted
    const saved = await getContent(result.contentId, testDir);
    expect(saved).not.toBeNull();
  });

  // 4b. 标题里的违禁词不得漏报（终审修复：扫描口径与 review.ts 的 title\n\nbody 对齐）
  it("violations: sensitive word in TITLE only → still reported", async () => {
    const violatingPayload = {
      ...GOOD_PAYLOAD,
      title: "教你翻墙看世界",
      body: "这是一段完全干净的正文，讲 AI 学习方法。",
    };

    const runLoopImpl = makeRunLoop([violatingPayload], 180);
    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    expect(result.violations.some((v) => v.includes("翻墙"))).toBe(true);
  });

  // 5. Engine unconfigured → rejects with config error
  it("engine unconfigured: no engine.json, no env → rejects with actionable error", async () => {
    // Remove engine.json from testDir
    await fs.rm(path.join(testDir, "engine.json"), { force: true });
    // ENV already cleared in beforeEach

    const runLoopImpl = makeRunLoop([GOOD_PAYLOAD]);
    await expect(generateScript(TEST_REQ, testDir, { runLoopImpl })).rejects.toThrow(
      /DEEPSEEK_API_KEY|engine\.json/,
    );
  });

  // 6. Type validation: hashtags passed as string → array error, model retries with array
  it("type validation: hashtags as string → 字符串数组 error, retry with array succeeds", async () => {
    const execResults: string[] = [];
    const runLoopImpl = makeRunLoop(
      [{ ...GOOD_PAYLOAD, hashtags: "#AI赚钱" }, GOOD_PAYLOAD],
      150,
      execResults,
    );

    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    expect(execResults[0]).toContain("字段 hashtags 应为字符串数组");
    expect(execResults[0]).toContain("submit_script");
    expect(execResults[1]).toBe("已收到脚本");
    expect(result.hashtags).toEqual(GOOD_PAYLOAD.hashtags);

    const saved = await getContent(result.contentId, testDir);
    expect(saved!.hashtags).toEqual(GOOD_PAYLOAD.hashtags);
  });

  // 7. Type validation: title passed as number → string error
  it("type validation: title as number → 应为字符串 error, retry succeeds", async () => {
    const execResults: string[] = [];
    const runLoopImpl = makeRunLoop([{ ...GOOD_PAYLOAD, title: 42 }, GOOD_PAYLOAD], 150, execResults);

    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    expect(execResults[0]).toContain("字段 title 应为字符串");
    expect(execResults[0]).toContain("submit_script");
    expect(result.title).toBe(GOOD_PAYLOAD.title);
  });

  // 8. Whitespace-only field is rejected as missing (trim before emptiness check)
  it("whitespace-only title → 缺少字段 error, retry succeeds", async () => {
    const execResults: string[] = [];
    const runLoopImpl = makeRunLoop([{ ...GOOD_PAYLOAD, title: "   " }, GOOD_PAYLOAD], 150, execResults);

    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    expect(execResults[0]).toContain("缺少字段 title");
    expect(result.title).toBe(GOOD_PAYLOAD.title);
  });

  // 9. Double valid submit: last submission wins
  it("two valid submissions → second payload persisted (last-wins)", async () => {
    const secondPayload = { ...GOOD_PAYLOAD, title: "第二稿标题", hashtags: ["#第二稿"] };
    const execResults: string[] = [];
    const runLoopImpl = makeRunLoop([GOOD_PAYLOAD, secondPayload], 150, execResults);

    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    expect(execResults).toEqual(["已收到脚本", "已收到脚本"]);
    expect(result.title).toBe("第二稿标题");
    expect(result.hashtags).toEqual(["#第二稿"]);

    const saved = await getContent(result.contentId, testDir);
    expect(saved!.title).toBe("第二稿标题");
    expect(saved!.hashtags).toEqual(["#第二稿"]);
  });

  // 10. Whitespace/empty hashtags are filtered out (Step 0 rider)
  it("whitespace/empty hashtags are stripped before saving", async () => {
    const payloadWithBlanks = { ...GOOD_PAYLOAD, hashtags: ["#a", "  ", "#b", ""] };
    const runLoopImpl = makeRunLoop([payloadWithBlanks], 150);

    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });

    expect(result.hashtags).toEqual(["#a", "#b"]);

    const saved = await getContent(result.contentId, testDir);
    expect(saved!.hashtags).toEqual(["#a", "#b"]);
  });
});

// ─── Quality Gate（公众号图文包，PRD-v4 §4.3）─────────────────────────────────

function articlePayload(bodyOverride?: string): Record<string, unknown> {
  const data = "增长 40%，营收 3 亿元，用户 5000 万人，历时 6 个月，客单价 199 元。";
  const body =
    bodyOverride ??
    // 1700 字落在图文包 gate 的 [1500, 2000] 区间内（maxChars 上限自创始人字数裁定）
    [data, "[IMAGE: 增长曲线图]", "字".repeat(1700), "[IMAGE: 对比表格]", "[IMAGE: 流程示意]", "[IMAGE: 案例配图]"].join(
      "\n",
    );
  return {
    title: "一篇深度长文",
    hook: "你有没有算过一笔账",
    body,
    cta: "转发给需要的人",
    hashtags: ["AI", "创业"],
  };
}

const WECHAT_REQ = { topic: "AI 变现", platform: "wechat_mp" as const };

describe("generateScript × quality gate (wechat_mp)", () => {
  it("wechat_mp 路由到图文包：prompt 含写手角色与硬门禁，budget 提升", async () => {
    let seenOpts: LoopOptions | undefined;
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      seenOpts = opts;
      const tool = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
      await tool.execute(articlePayload());
      return { finalMessage: "ok", turns: 2, totalTokens: 9000, toolCallCount: 1, stopReason: "no_tool_calls" };
    };
    const res = await generateScript(WECHAT_REQ, testDir, { runLoopImpl });
    expect(seenOpts!.systemPrompt).toContain("公众号");
    expect(seenOpts!.systemPrompt).toContain("质量硬门禁");
    expect(seenOpts!.maxTurns).toBe(8);
    expect(seenOpts!.maxTotalTokens).toBe(80000);
    expect(res.gateFailures).toEqual([]);
  });

  it("Gate FAIL → 修复指令打回；修正稿通过后 gateFailures 为空", async () => {
    const execResults: string[] = [];
    const runLoopImpl = makeRunLoop([articlePayload("太短的正文"), articlePayload()], 300, execResults);
    const res = await generateScript(WECHAT_REQ, testDir, { runLoopImpl });
    expect(execResults[0]).toContain("QUALITY GATE 未通过");
    expect(execResults[1]).toBe("已收到脚本");
    expect(res.gateFailures).toEqual([]);
  });

  it("修复轮耗尽（默认 2）→ 第 3 稿照收，未过项透出且稿件仍落库", async () => {
    const execResults: string[] = [];
    const runLoopImpl = makeRunLoop(
      [articlePayload("还是太短"), articlePayload("还是太短"), articlePayload("还是太短")],
      300,
      execResults,
    );
    const res = await generateScript(WECHAT_REQ, testDir, { runLoopImpl });
    expect(execResults[0]).toContain("QUALITY GATE 未通过");
    expect(execResults[1]).toContain("QUALITY GATE 未通过");
    expect(execResults[2]).toBe("已收到脚本");
    expect(res.gateFailures.length).toBeGreaterThan(0);
    const saved = await getContent(res.contentId, testDir);
    expect(saved).not.toBeNull();
  });

  it("超长文章（>2000 字）→ max_chars 打回，压缩稿通过", async () => {
    const longBody = [
      "增长 40%，营收 3 亿元，用户 5000 万人，历时 6 个月，客单价 199 元。",
      "[IMAGE: 增长曲线图]",
      "字".repeat(2600),
      "[IMAGE: 对比表格]",
    ].join("\n");
    const execResults: string[] = [];
    const runLoopImpl = makeRunLoop([articlePayload(longBody), articlePayload()], 300, execResults);
    const res = await generateScript(WECHAT_REQ, testDir, { runLoopImpl });
    expect(execResults[0]).toContain("QUALITY GATE 未通过");
    expect(execResults[0]).toContain("2000");
    expect(execResults[1]).toBe("已收到脚本");
    expect(res.gateFailures).toEqual([]);
  });

  it("xiaohongshu 口播包：平台 maxChars=1000 生效——超长发布文案被打回压缩", async () => {
    const execResults: string[] = [];
    const runLoopImpl = makeRunLoop(
      [{ ...GOOD_PAYLOAD, body: "字".repeat(1200) }, { ...GOOD_PAYLOAD, body: "字".repeat(600) }],
      200,
      execResults,
    );
    const res = await generateScript({ topic: "AI 变现", platform: "xiaohongshu" as const }, testDir, {
      runLoopImpl,
    });
    expect(execResults[0]).toContain("QUALITY GATE 未通过");
    expect(execResults[0]).toContain("1000");
    expect(execResults[1]).toBe("已收到脚本");
    expect(res.gateFailures).toEqual([]);
  });

  it("douyin 不受影响：口播包、无 gate、预算不变", async () => {
    let seenOpts: LoopOptions | undefined;
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      seenOpts = opts;
      const tool = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
      await tool.execute(GOOD_PAYLOAD);
      return { finalMessage: "ok", turns: 2, totalTokens: 200, toolCallCount: 1, stopReason: "no_tool_calls" };
    };
    const res = await generateScript(TEST_REQ, testDir, { runLoopImpl });
    expect(seenOpts!.systemPrompt).toContain("口播");
    expect(seenOpts!.systemPrompt).not.toContain("质量硬门禁");
    expect(seenOpts!.maxTurns).toBe(4);
    expect(res.gateFailures).toEqual([]);
  });
});

describe("startGenerateScript — 后台化（契约 P1 完全体）", () => {
  it("returns the placeholder immediately, before the loop finishes", async () => {
    let releaseLoop;
    const gate = new Promise((r) => { releaseLoop = r; });
    const runLoopImpl = async (_cfg, opts) => {
      await gate; // loop 挂起——占位必须先返回
      const submitTool = (opts.tools ?? []).find((t) => t.name === "submit_script");
      await submitTool.execute(GOOD_PAYLOAD);
      return { finalMessage: "ok", turns: 2, totalTokens: 100, toolCallCount: 1, stopReason: "no_tool_calls" };
    };
    const events = [];
    const started = await startGenerateScript(TEST_REQ, testDir, { runLoopImpl, onEvent: (e) => events.push(e) });

    // 立即拿到占位:loop 还没跑完
    expect(started.contentId).toMatch(/^content-/);
    const placeholder = await getContent(started.contentId, testDir);
    expect(placeholder.status).toBe("drafting");
    expect(events.map((e) => e.kind)).toEqual(["work"]);

    releaseLoop();
    await started.completion;

    const promoted = await getContent(started.contentId, testDir);
    expect(promoted.status).toBe("draft_ready"); // 后台完成 → 占位原地转正
    expect(events.map((e) => e.kind)).toEqual(["work", "run_done"]);
    expect(events[1].runId).toBe(started.runId);
  });

  it("background failure marks lastError and emits run_failed — never throws to caller", async () => {
    const runLoopImpl = async () => { throw new Error("relay 断流"); };
    const events = [];
    const started = await startGenerateScript(TEST_REQ, testDir, { runLoopImpl, onEvent: (e) => events.push(e) });
    await started.completion; // 不 reject

    const placeholder = await getContent(started.contentId, testDir);
    expect(placeholder.lastError).toContain("relay 断流");
    expect(events.map((e) => e.kind)).toEqual(["work", "run_failed"]);
  });
});

// ─── 知识库注入（codex 评审修复:检索下沉统一执行体——桌面 IPC/chat-router 路径生效）──

/** 捕获 userMessage 的 runLoopImpl:知识块最终落在 user prompt 的调研材料槽 */
function makePromptCapturingLoop(sink: { userMessage: string }) {
  return async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    sink.userMessage = opts.userMessage;
    const tool = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
    await tool.execute(GOOD_PAYLOAD);
    return { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
  };
}

describe("knowledge injection — 生成管线统一检索", () => {
  it("desktop path (startGenerateScript): matching knowledge file lands in the prompt research slot", async () => {
    await fs.mkdir(path.join(testDir, "knowledge"), { recursive: true });
    await fs.writeFile(
      path.join(testDir, "knowledge", "普通人赚钱方法论.md"),
      "普通人赚钱的第一性原理是解决具体问题,而不是追风口。",
    );

    const sink = { userMessage: "" };
    const started = await startGenerateScript({ ...TEST_REQ, research: "用户给的资料" }, testDir, {
      runLoopImpl: makePromptCapturingLoop(sink),
    });
    await started.completion;

    expect(sink.userMessage).toContain("调研材料");
    expect(sink.userMessage).toContain("用户给的资料"); // 用户材料在前,不被知识块顶掉
    expect(sink.userMessage).toContain("知识库参考");
    expect(sink.userMessage).toContain("普通人赚钱方法论.md"); // 来源文件名可溯
    expect(sink.userMessage).toContain("第一性原理"); // 片段内容真进了 prompt
  });

  it("no knowledge dir → prompt unchanged (sync entry, same executor)", async () => {
    const sink = { userMessage: "" };
    await generateScript(TEST_REQ, testDir, { runLoopImpl: makePromptCapturingLoop(sink) });

    expect(sink.userMessage).not.toContain("知识库参考");
    expect(sink.userMessage).toContain("无调研材料"); // 空态文案与改动前一致
  });

  it("knowledge present but irrelevant to topic → no block injected", async () => {
    await fs.mkdir(path.join(testDir, "knowledge"), { recursive: true });
    await fs.writeFile(path.join(testDir, "knowledge", "烘焙入门.md"), "戚风蛋糕的打发要点是蛋白温度。");

    const sink = { userMessage: "" };
    await generateScript(TEST_REQ, testDir, { runLoopImpl: makePromptCapturingLoop(sink) });

    expect(sink.userMessage).not.toContain("知识库参考");
    expect(sink.userMessage).toContain("无调研材料");
  });
});
