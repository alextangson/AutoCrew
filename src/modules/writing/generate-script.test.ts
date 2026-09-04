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

import { generateScript, startGenerateScript, retryGenerateScript } from "./generate-script.js";
import type { EnsureBriefOutcome, GeneratedScript, ScriptRequest } from "./generate-script.js";
import { getContent, listContents, saveContent } from "../../storage/local-store.js";
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
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/**
 * 写稿测试的 loop 替身只扮演**写稿那一轮**。写稿收束后还有一轮 AI 审稿（script-review），
 * 用的是同一个注入口但工具带是 submit_review——替身不出手，审稿按「未经 AI 审稿」降级，
 * 写稿路径的断言（prompt/归因/标题/版本）因此与改动前逐字一致。审稿本身另有专测。
 */
const REVIEW_ABSTAIN: LoopResult = {
  finalMessage: "审稿替身不出手",
  turns: 1,
  totalTokens: 0,
  toolCallCount: 0,
  stopReason: "no_tool_calls",
};

const isWriterLoop = (opts: LoopOptions): boolean =>
  (opts.tools ?? []).some((t: LoopTool) => t.name === "submit_script");

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
    if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
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
  hook: "你知道吗，身边有人靠AI接私活，已经辞掉了工作",
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
      if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
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

  it("tokensUsed 汇总写稿与 AI 审稿调用", async () => {
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      const tool = (opts.tools ?? [])[0];
      if (isWriterLoop(opts)) {
        await tool.execute(GOOD_PAYLOAD);
        return { finalMessage: "ok", turns: 1, totalTokens: 200, toolCallCount: 1, stopReason: "no_tool_calls" };
      }
      await tool.execute({ verdict: "pass", issues: [] });
      return { finalMessage: "ok", turns: 1, totalTokens: 25, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    const result = await generateScript(TEST_REQ, testDir, { runLoopImpl });
    expect(result.tokensUsed).toBe(225);
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

/** 图文稿里的数据点：既喂 gate 的 minDataPoints，也当作创始人给的材料喂账本 */
const ARTICLE_DATA = "增长 40%，营收 3 亿元，用户 5000 万人，历时 6 个月，客单价 199 元。";

function articlePayload(bodyOverride?: string): Record<string, unknown> {
  const data = ARTICLE_DATA;
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

/**
 * 图文包的 gate 要求「数据引用 ≥N」，而 P1 §4.4 的数字硬门要求每个数字有出处——
 * 两道门只有在**材料里真有这些数**的时候才同时过得去。所以这条请求自带材料，
 * 里面就是 `articlePayload` 用的那串数（账本按 user_claim 收，正是生产里创始人贴材料的形态）。
 */
const WECHAT_REQ = { topic: "AI 变现", platform: "wechat_mp" as const, research: ARTICLE_DATA };

describe("generateScript × quality gate (wechat_mp)", () => {
  it("wechat_mp 路由到图文包：prompt 含写手角色与硬门禁，budget 提升", async () => {
    let seenOpts: LoopOptions | undefined;
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
      seenOpts = opts;
      const tool = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
      await tool.execute(articlePayload());
      return { finalMessage: "ok", turns: 2, totalTokens: 9000, toolCallCount: 1, stopReason: "no_tool_calls" };
    };
    const res = await generateScript(WECHAT_REQ, testDir, { runLoopImpl });
    expect(seenOpts!.systemPrompt).toContain("公众号");
    expect(seenOpts!.systemPrompt).toContain("质量硬门禁");
    // 回合预算 = 4 + find_evidence 额度(3) + gate 修复轮(2)×2（P1 §4.4 / codex #12）
    expect(seenOpts!.maxTurns).toBe(11);
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

  it("douyin 无包级 gate，但硬门照样要打回预算：回合按同一个公式给（codex #12）", async () => {
    let seenOpts: LoopOptions | undefined;
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
      seenOpts = opts;
      const tool = (opts.tools ?? []).find((t) => t.name === "submit_script")!;
      await tool.execute(GOOD_PAYLOAD);
      return { finalMessage: "ok", turns: 2, totalTokens: 200, toolCallCount: 1, stopReason: "no_tool_calls" };
    };
    const res = await generateScript(TEST_REQ, testDir, { runLoopImpl });
    expect(seenOpts!.systemPrompt).toContain("口播");
    expect(seenOpts!.systemPrompt).not.toContain("质量硬门禁");
    // 老行为是 4——包没有 gate 就不给修复回合，于是第一次被硬门打回之后它交不出第二稿
    expect(seenOpts!.maxTurns).toBe(11);
    expect(res.gateFailures).toEqual([]);
  });
});

describe("startGenerateScript — 后台化（契约 P1 完全体）", () => {
  it("returns the placeholder immediately, before the loop finishes", async () => {
    let releaseLoop;
    const gate = new Promise((r) => { releaseLoop = r; });
    const runLoopImpl = async (_cfg, opts) => {
      if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
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

// ─── 中断稿原地重写（retryGenerateScript）────────────────────────────────────
//
// 这条链的要点只有一个:重试**不新建稿件**。老路每重试一次看板多一张重复卡,
// 中断稿则永远躺在那儿没人管。

/** 跑一次必崩的生成,留下一张带 lastError 的中断稿 */
async function makeInterrupted(req: ScriptRequest = TEST_REQ): Promise<string> {
  const started = await startGenerateScript(req, testDir, {
    runLoopImpl: async () => { throw new Error("relay 断流:ECONNRESET"); },
  });
  await started.completion;
  return started.contentId;
}

describe("retryGenerateScript — 中断稿原地重写", () => {
  it("复用原 id 转正,不新建稿件", async () => {
    const contentId = await makeInterrupted();

    const retried = await retryGenerateScript(contentId, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
    });
    await retried.completion;

    expect(retried.contentId).toBe(contentId);
    const all = await listContents(testDir);
    expect(all).toHaveLength(1); // 看板上仍然只有那一张卡
    expect(all[0].id).toBe(contentId);
    expect(all[0].status).toBe("draft_ready");
    expect(all[0].title).toBe(GOOD_PAYLOAD.title);
  });

  it("投递即清中断痕:标题回［生成中］、lastError 清空——不必等写完", async () => {
    const contentId = await makeInterrupted();
    let releaseLoop: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseLoop = r; });

    const retried = await retryGenerateScript(contentId, testDir, {
      runLoopImpl: async (_cfg, opts) => {
        if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
        await gate;
        await (opts.tools ?? []).find((t) => t.name === "submit_script")!.execute(GOOD_PAYLOAD);
        return { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
      },
    });

    const running = await getContent(contentId, testDir);
    expect(running!.lastError ?? null).toBeNull();
    expect(running!.title.startsWith("［生成中］")).toBe(true);

    releaseLoop();
    await retried.completion;
  });

  it("原始请求从 genRequest 还原:调研材料与选题原文都不丢", async () => {
    const contentId = await makeInterrupted({ ...TEST_REQ, research: "我自己扒的一手资料" });
    const sink = { userMessage: "" };

    const retried = await retryGenerateScript(contentId, testDir, {
      runLoopImpl: makePromptCapturingLoop(sink),
    });
    await retried.completion;

    expect(sink.userMessage).toContain(TEST_REQ.topic); // 不是带哨兵前缀的标题
    expect(sink.userMessage).toContain("我自己扒的一手资料");
  });

  it("override 盖在原请求之上:换了角度按新角度写,没重提的材料照旧带上", async () => {
    const contentId = await makeInterrupted({ ...TEST_REQ, research: "上回贴的一手资料" });
    const sink = { userMessage: "" };

    const retried = await retryGenerateScript(
      contentId,
      testDir,
      { runLoopImpl: makePromptCapturingLoop(sink) },
      { topic: "换个角度:AI 时代的求职者" }, // 只给了选题,没重提材料
    );
    await retried.completion;

    expect(sink.userMessage).toContain("换个角度:AI 时代的求职者");
    expect(sink.userMessage).not.toContain(TEST_REQ.topic); // 旧角度没被照抄
    expect(sink.userMessage).toContain("上回贴的一手资料"); // 没重提的那格没被擦掉
  });

  it("老数据没有 genRequest → 降级:选题从标题剥哨兵,平台/血缘取稿件字段", async () => {
    const legacy = await saveContent(
      {
        title: "［生成中断］AI时代普通人赚钱",
        body: "",
        platform: "douyin",
        topicId: "topic-legacy",
        status: "drafting",
        tags: [],
        hashtags: [],
        lastError: "server 重启",
      },
      testDir,
    );
    const sink = { userMessage: "" };

    const retried = await retryGenerateScript(legacy.id, testDir, {
      runLoopImpl: makePromptCapturingLoop(sink),
    });
    await retried.completion;

    expect(retried.contentId).toBe(legacy.id);
    expect(sink.userMessage).toContain("选题：AI时代普通人赚钱"); // 哨兵没被当成选题带进去
    expect(sink.userMessage).not.toContain("［生成中断］");
    expect((await getContent(legacy.id, testDir))!.status).toBe("draft_ready");
  });

  it("没有中断记录的稿件拒绝重写——好稿不许被推倒重来", async () => {
    const ok = await generateScript(TEST_REQ, testDir, { runLoopImpl: makeRunLoop([GOOD_PAYLOAD]) });

    await expect(retryGenerateScript(ok.contentId, testDir)).rejects.toThrow(/中断记录/);
    // 拒绝 = 什么都没动:稿子还是成稿,标题没被改回哨兵
    const saved = await getContent(ok.contentId, testDir);
    expect(saved!.status).toBe("draft_ready");
    expect(saved!.title).toBe(GOOD_PAYLOAD.title);
  });

  it("稿件不存在 → 报「稿件不存在」,不静默新建", async () => {
    await expect(retryGenerateScript("content-not-there", testDir)).rejects.toThrow(/不存在/);
    expect(await listContents(testDir)).toHaveLength(0);
  });

  it("转正清掉 genRequest:成稿没有「中断」可重试,不留过期请求", async () => {
    const res = await generateScript(TEST_REQ, testDir, { runLoopImpl: makeRunLoop([GOOD_PAYLOAD]) });
    expect((await getContent(res.contentId, testDir))!.genRequest).toBeUndefined();
  });

  it("重写又崩 → 沿用现有失败留痕（〔生成中断〕+ lastError）,仍然只有一张卡", async () => {
    const contentId = await makeInterrupted();

    const retried = await retryGenerateScript(contentId, testDir, {
      runLoopImpl: async () => { throw new Error("第二次也崩:502"); },
    });
    await retried.completion; // 后台失败不向调用方 reject

    const all = await listContents(testDir);
    expect(all).toHaveLength(1);
    expect(all[0].title).toContain("［生成中断］");
    expect(all[0].lastError).toContain("502");
  });

  it("任务带上「重写」和「开写」分得开", async () => {
    const contentId = await makeInterrupted();
    const events: Array<{ kind: string; label: string }> = [];
    const retried = await retryGenerateScript(contentId, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      onEvent: (e) => events.push(e),
    });
    await retried.completion;

    expect(events[0].kind).toBe("work");
    expect(events[0].label).toContain("重写");
  });
});

// ─── 知识库注入（codex 评审修复:检索下沉统一执行体——桌面 IPC/chat-router 路径生效）──

/** 捕获 userMessage 的 runLoopImpl:知识块最终落在 user prompt 的调研材料槽 */
function makePromptCapturingLoop(sink: { userMessage: string }) {
  return async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
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

// ─── 写作入口自动补深调研（调研闸口）──────────────────────────────────────────
//
// 两条底线:闸口只在「从选题开写且没自带材料」时拦一下;它自己出什么事都不许弄死写作,
// 但降级必须三处留痕（warn + 版本注记 + 返回值/事件标签）。

const TOPIC_REQ = { ...TEST_REQ, topicId: "topic-1" };

/** 记账版闸口替身：既做结果注入，也验「到底调没调用」 */
function gateSpy(outcome: EnsureBriefOutcome) {
  const calls: string[] = [];
  return {
    calls,
    impl: async (topicId: string): Promise<EnsureBriefOutcome> => {
      calls.push(topicId);
      return outcome;
    },
  };
}

/** 稿件版本历史里最后一条的人话注记——降级留痕落在这儿 */
async function latestNote(contentId: string): Promise<string | undefined> {
  const saved = await getContent(contentId, testDir);
  return saved?.versions?.at(-1)?.note;
}

describe("写作入口自动补深调研", () => {
  it("带 topicId 且用户没自带材料 → 开写前先补一轮调研", async () => {
    const spy = gateSpy({ state: "ready" });
    const res = await generateScript(TOPIC_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: spy.impl,
    });

    expect(spy.calls).toEqual(["topic-1"]);
    expect(res.wroteWithoutBrief).toBe(false);
    expect(await latestNote(res.contentId)).toBe("AI 完成初稿");
  });

  it("已有简报（already）→ 不改口径，注记与改动前一字不差", async () => {
    const res = await generateScript(TOPIC_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: gateSpy({ state: "already" }).impl,
    });

    expect(res.wroteWithoutBrief).toBe(false);
    expect(await latestNote(res.contentId)).toBe("AI 完成初稿");
  });

  it("用户自带调研材料 → 不拦：他手里有料，不该为一轮分钟级调研排队", async () => {
    const spy = gateSpy({ state: "ready" });
    await generateScript({ ...TOPIC_REQ, research: "我自己扒的一手资料" }, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: spy.impl,
    });

    expect(spy.calls).toEqual([]);
  });

  it("没有 topicId（随手写）→ 不触发调研", async () => {
    const spy = gateSpy({ state: "ready" });
    const res = await generateScript(TEST_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: spy.impl,
    });

    expect(spy.calls).toEqual([]);
    expect(res.wroteWithoutBrief).toBe(false);
  });

  it("未注入闸口（MCP 同步入口）→ 行为与改动前完全一致", async () => {
    const res = await generateScript(TOPIC_REQ, testDir, { runLoopImpl: makeRunLoop([GOOD_PAYLOAD]) });

    expect(res.wroteWithoutBrief).toBe(false);
    expect(await latestNote(res.contentId)).toBe("AI 完成初稿");
  });

  it("调研失败 → 照写，但 warn + 版本注记 + 返回值三处都留痕", async () => {
    const warns: string[] = [];
    const res = await generateScript(TOPIC_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: async () => ({ state: "failed", note: "四个视角挂了三个" }),
      onWarn: (m) => warns.push(m),
    });

    expect(res.wroteWithoutBrief).toBe(true);
    expect(res.title).toBe(GOOD_PAYLOAD.title); // 稿子照出，闸口不阻断
    expect(warns.some((w) => w.includes("未带调研简报开写") && w.includes("四个视角挂了三个"))).toBe(true);
    expect(await latestNote(res.contentId)).toBe("AI 完成初稿（未带调研简报）");
    const saved = await getContent(res.contentId, testDir);
    expect(saved!.status).toBe("draft_ready");
  });

  it("触发被拒（搜索 key 没配）→ 照写，理由进 warn", async () => {
    const warns: string[] = [];
    const res = await generateScript(TOPIC_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: async () => ({ state: "unavailable", note: "搜索来源还没配 key" }),
      onWarn: (m) => warns.push(m),
    });

    expect(res.wroteWithoutBrief).toBe(true);
    expect(warns.some((w) => w.includes("搜索来源还没配 key"))).toBe(true);
  });

  it("等超时 → 照写，注记标明未带简报", async () => {
    const warns: string[] = [];
    const res = await generateScript(TOPIC_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: async () => ({ state: "timeout" }),
      onWarn: (m) => warns.push(m),
    });

    expect(res.wroteWithoutBrief).toBe(true);
    expect(warns.some((w) => w.includes("未带调研简报开写"))).toBe(true);
    expect(await latestNote(res.contentId)).toBe("AI 完成初稿（未带调研简报）");
  });

  it("闸口自己抛错 → 写作照常完成，并按未带简报留痕", async () => {
    const warns: string[] = [];
    const res = await generateScript(TOPIC_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: async () => {
        throw new Error("闸口炸了");
      },
      onWarn: (m) => warns.push(m),
    });

    expect(res.contentId).toMatch(/^content-/);
    expect(res.wroteWithoutBrief).toBe(true);
    expect(warns.some((w) => w.includes("闸口炸了"))).toBe(true);
  });

  /** 当前唯一那篇稿的标题（占位稿先行，测试目录里只会有这一篇） */
  async function onlyTitle(): Promise<string> {
    const all = await listContents(testDir);
    expect(all).toHaveLength(1);
    return all[0].title;
  }

  it("等简报期间占位稿标题走一个来回：［调研中］→ 开写时改回［生成中］", async () => {
    const seen: string[] = [];
    const res = await generateScript(TOPIC_REQ, testDir, {
      // 闸口里真去读盘：断言的是用户当下会看到的那个标题
      ensureBriefImpl: async (_topicId, onWaiting) => {
        seen.push(await onlyTitle()); // 等待前
        await onWaiting?.();
        seen.push(await onlyTitle()); // 等待中
        return { state: "timeout" };
      },
      // 写稿这一刻标题必须已经改回来了（接下来是写,不是调研）
      runLoopImpl: async (_cfg, opts) => {
        if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
        seen.push(await onlyTitle());
        await (opts.tools ?? []).find((t) => t.name === "submit_script")!.execute(GOOD_PAYLOAD);
        return { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
      },
      onWarn: () => {},
    });

    expect(seen).toEqual([
      `［生成中］${TOPIC_REQ.topic}`,
      `［调研中］${TOPIC_REQ.topic}`,
      `［生成中］${TOPIC_REQ.topic}`,
    ]);
    expect(res.title).toBe(GOOD_PAYLOAD.title); // 转正后哨兵全消失
    // updateContent 逢标题变化必记一版:那两版得是人话,不能在历史里留两条「第 N 版」谜语
    expect((await listContents(testDir))[0].versions?.map((v) => v.note)).toEqual([
      "初稿",
      "开写前先补一轮深调研",
      "调研落定,开始写稿",
      "AI 完成初稿（未带调研简报）",
    ]);
  });

  it("没等待（already/ready 秒回）→ 标题一次都不动", async () => {
    const seen: string[] = [];
    await generateScript(TOPIC_REQ, testDir, {
      ensureBriefImpl: async () => ({ state: "already" }), // 不叫 onWaiting
      runLoopImpl: async (_cfg, opts) => {
        if (!isWriterLoop(opts)) return REVIEW_ABSTAIN;
        seen.push(await onlyTitle());
        await (opts.tools ?? []).find((t) => t.name === "submit_script")!.execute(GOOD_PAYLOAD);
        return { finalMessage: "ok", turns: 1, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
      },
    });

    expect(seen).toEqual([`［生成中］${TOPIC_REQ.topic}`]);
    // 没等待就没有标题来回 → 版本历史只有「初稿 + 转正」两条，不给正常路径加噪音
    expect((await listContents(testDir))[0].versions).toHaveLength(2);
  });

  it("占位稿标题写不动 → 只 warn，写作照常出稿（标题是观感,不是正确性）", async () => {
    const warns: string[] = [];
    const res = await generateScript(TOPIC_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: async (_topicId, onWaiting) => {
        // 把 meta.json 换成目录：改标题这一刻必炸(EISDIR),改完再恢复,后面的写作不受影响
        const meta = path.join(testDir, "contents", (await listContents(testDir))[0].id, "meta.json");
        const raw = await fs.readFile(meta, "utf-8");
        await fs.rm(meta);
        await fs.mkdir(meta);
        await onWaiting?.();
        await fs.rm(meta, { recursive: true });
        await fs.writeFile(meta, raw);
        return { state: "timeout" };
      },
      onWarn: (m) => warns.push(m),
    });

    expect(warns.some((w) => w.includes("占位稿标题更新失败"))).toBe(true);
    expect(res.title).toBe(GOOD_PAYLOAD.title); // 稿子照出
    expect(res.wroteWithoutBrief).toBe(true);
  });

  it("后台入口：没带简报时 run_done 标签自己说出来", async () => {
    const events: Array<{ kind: string; label: string }> = [];
    const started = await startGenerateScript(TOPIC_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: async () => ({ state: "timeout" }),
      onWarn: () => {},
      onEvent: (e) => events.push(e),
    });
    await started.completion;

    const done = events.find((e) => e.kind === "run_done");
    expect(done?.label).toContain("（未带简报）");
  });

  it("后台入口：带上简报时标签不变（不给正常路径加噪音）", async () => {
    const events: Array<{ kind: string; label: string }> = [];
    const started = await startGenerateScript(TOPIC_REQ, testDir, {
      runLoopImpl: makeRunLoop([GOOD_PAYLOAD]),
      ensureBriefImpl: async () => ({ state: "ready" }),
      onEvent: (e) => events.push(e),
    });
    await started.completion;

    const done = events.find((e) => e.kind === "run_done");
    expect(done?.label).not.toContain("未带简报");
  });
});

// ─── AI 审稿接线（审稿 spec §2.1 顺序：组装 → humanize → 审稿 → 违禁词扫描 → 转正）──

const LOOP_OK: LoopResult = {
  finalMessage: "ok",
  turns: 1,
  totalTokens: 120,
  toolCallCount: 1,
  stopReason: "no_tool_calls",
};

/** 写稿轮 + 审稿轮 + 修订轮的替身：按工具带认自己是谁 */
function reviewingLoop(script: {
  draft: Record<string, unknown>;
  reviews: Array<Record<string, unknown> | "throw">;
  revisions?: Array<Record<string, unknown>>;
  seen?: { reviewUser: string[] };
}) {
  const reviews = [...script.reviews];
  const revisions = [...(script.revisions ?? [])];
  let wroteFirstDraft = false;
  return async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    const tool = (opts.tools ?? [])[0];
    if (tool.name === "submit_review") {
      script.seen?.reviewUser.push(opts.userMessage);
      const next = reviews.shift();
      if (next === "throw") throw new Error("审稿 relay 断流");
      if (next) await tool.execute(next);
      return LOOP_OK;
    }
    const payload = wroteFirstDraft ? revisions.shift() : script.draft;
    wroteFirstDraft = true;
    if (payload) await tool.execute(payload);
    return LOOP_OK;
  };
}

/** 带 AI 味的初稿：humanizeZh 会删掉「值得一提的是」，审稿必须看的是删完之后的样子 */
const AI_FLAVORED = {
  ...GOOD_PAYLOAD,
  body: "值得一提的是，正文讲了三件事，每件都有具体数字。",
};

const BLOCKER = {
  severity: "blocker",
  quote: "正文讲了三件事",
  rule: "信息罗列无论点",
  instruction: "把三件事收敛成一个判断",
};

describe("generateScript × AI 审稿", () => {
  it("审稿读的是 humanize 之后的终稿形态（正则在前，§2.1）", async () => {
    const seen = { reviewUser: [] as string[] };
    await generateScript(TEST_REQ, testDir, {
      runLoopImpl: reviewingLoop({ draft: AI_FLAVORED, reviews: [{ verdict: "pass", issues: [] }], seen }),
    });

    expect(seen.reviewUser).toHaveLength(1);
    expect(seen.reviewUser[0]).not.toContain("值得一提的是"); // 正则已经动过手了
    expect(seen.reviewUser[0]).toContain("正文讲了三件事");
    expect(seen.reviewUser[0]).toContain(GOOD_PAYLOAD.hook);
  });

  it("一轮过：review 落 Content 与返回值，正文不变", async () => {
    const res = await generateScript(TEST_REQ, testDir, {
      runLoopImpl: reviewingLoop({ draft: GOOD_PAYLOAD, reviews: [{ verdict: "pass", issues: [] }] }),
    });

    expect(res.review.status).toBe("passed");
    expect(res.review.rounds).toBe(0);
    const saved = await getContent(res.contentId, testDir);
    expect(saved!.review?.status).toBe("passed");
    expect(saved!.body).toBe(res.body);
    expect(await latestNote(res.contentId)).toBe("AI 完成初稿");
  });

  it("修订发生 → 落盘的是修订稿，违禁词扫描扫的也是修订稿（审稿在扫描之前）", async () => {
    const revised = { ...GOOD_PAYLOAD, body: "你可以通过翻墙来看更多资料，这是一个判断。" };
    const res = await generateScript(TEST_REQ, testDir, {
      runLoopImpl: reviewingLoop({
        draft: AI_FLAVORED,
        reviews: [{ verdict: "revise", issues: [BLOCKER] }, { verdict: "pass", issues: [] }],
        revisions: [revised],
      }),
    });

    expect(res.review.status).toBe("revised");
    expect(res.review.rounds).toBe(1);
    expect(res.review.fixed).toBe(1);
    expect(res.body).toContain("这是一个判断");
    // 初稿里没有违禁词，修订稿里有 → 扫描扫的是审稿之后那一版
    expect(res.violations.some((v) => v.includes("翻墙"))).toBe(true);

    const saved = await getContent(res.contentId, testDir);
    expect(saved!.body).toBe(res.body);
    expect(await latestNote(res.contentId)).toBe("AI 审稿修订（1 项）");
  });

  it("版本注记组合：修订 × 未带简报，一句人话说清两件事", async () => {
    const res = await generateScript(TOPIC_REQ, testDir, {
      runLoopImpl: reviewingLoop({
        draft: AI_FLAVORED,
        reviews: [{ verdict: "revise", issues: [BLOCKER] }, { verdict: "pass", issues: [] }],
        revisions: [{ ...GOOD_PAYLOAD, body: "换成一个判断，不再罗列。" }],
      }),
      ensureBriefImpl: async () => ({ state: "timeout" }),
      onWarn: () => {},
    });

    expect(res.wroteWithoutBrief).toBe(true);
    expect(await latestNote(res.contentId)).toBe("AI 审稿修订（1 项，未带调研简报）");
  });

  it("审稿挂了 → 稿子照样转正，status skipped（审稿是增益，不许弄死写作）", async () => {
    const warns: string[] = [];
    const res = await generateScript(TEST_REQ, testDir, {
      runLoopImpl: reviewingLoop({ draft: GOOD_PAYLOAD, reviews: ["throw"] }),
      onWarn: (m) => warns.push(m),
    });

    expect(res.review.status).toBe("skipped");
    expect(res.title).toBe(GOOD_PAYLOAD.title);
    const saved = await getContent(res.contentId, testDir);
    expect(saved!.status).toBe("draft_ready");
    expect(saved!.review?.status).toBe("skipped");
    expect(warns.some((w) => w.includes("未经 AI 审稿"))).toBe(true);
  });

  it("残留 blocker → status failed，用最后一版过 gate 的稿转正", async () => {
    const res = await generateScript(TEST_REQ, testDir, {
      runLoopImpl: reviewingLoop({
        draft: AI_FLAVORED,
        reviews: [
          { verdict: "revise", issues: [BLOCKER] },
          { verdict: "revise", issues: [BLOCKER] },
          { verdict: "revise", issues: [BLOCKER] },
        ],
        revisions: [
          { ...GOOD_PAYLOAD, body: "正文讲了三件事，第一次修订。" },
          { ...GOOD_PAYLOAD, body: "正文讲了三件事，第二次修订。" },
        ],
      }),
      onWarn: () => {},
    });

    expect(res.review.status).toBe("failed");
    expect(res.review.issues.filter((i) => i.severity === "blocker")).toHaveLength(1);
    expect(res.body).toContain("第二次修订");
  });

  it("后台入口 run_done 标签：三态各说各的（与「未带简报」并列）", async () => {
    const labelOf = async (
      script: Parameters<typeof reviewingLoop>[0],
      extra?: { ensureBriefImpl?: () => Promise<EnsureBriefOutcome> },
    ): Promise<string> => {
      const events: Array<{ kind: string; label: string }> = [];
      const started = await startGenerateScript(TEST_REQ, testDir, {
        runLoopImpl: reviewingLoop(script),
        onWarn: () => {},
        onEvent: (e) => events.push(e),
        ...(extra ?? {}),
      });
      await started.completion;
      return events.find((e) => e.kind === "run_done")!.label;
    };

    expect(await labelOf({ draft: GOOD_PAYLOAD, reviews: [{ verdict: "pass", issues: [] }] })).toContain("（已审稿）");
    expect(await labelOf({ draft: GOOD_PAYLOAD, reviews: ["throw"] })).toContain("（未经AI审稿）");
    expect(
      await labelOf({
        draft: AI_FLAVORED,
        reviews: [
          { verdict: "revise", issues: [BLOCKER] },
          { verdict: "revise", issues: [BLOCKER] },
          { verdict: "revise", issues: [BLOCKER] },
        ],
        revisions: [
          { ...GOOD_PAYLOAD, body: "正文讲了三件事，第一次修订。" },
          { ...GOOD_PAYLOAD, body: "正文讲了三件事，第二次修订。" },
        ],
      }),
    ).toContain("（审稿未过,残留1项）");
  });
});
