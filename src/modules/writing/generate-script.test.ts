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

import { generateScript } from "./generate-script.js";
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
});
