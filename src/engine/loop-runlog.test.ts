/**
 * loop-runlog.test.ts — runLoop 运行日志埋点端到端:
 * config.dataDir 有 → llm/tool 记录落盘且 runId/agent 正确;无 → 零落盘零行为变化。
 * fetchImpl 注入 JSON 响应(非 SSE 路径),零网络。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLoop, type LoopTool } from "./loop.js";
import { readRun, listRuns } from "../runtime/run-log.js";
import type { EngineConfig } from "./config.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-looplog-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function makeFetch(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => jsonResponse(responses[Math.min(i++, responses.length - 1)])) as unknown as typeof fetch;
}

const toolCallTurn = {
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "echo", arguments: '{"msg":"hi","api_key":"sk-secret"}' } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { total_tokens: 40 },
};

const finalTurn = {
  choices: [{ message: { role: "assistant", content: "全部搞定" }, finish_reason: "stop" }],
  usage: { total_tokens: 15 },
};

const echoTool: LoopTool = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: {} },
  execute: () => "echoed",
};

function config(withDataDir: boolean): EngineConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://example.invalid",
    strongModel: "m-strong",
    fastModel: "m-fast",
    ...(withDataDir ? { dataDir: dir } : {}),
  };
}

describe("runLoop × run-log", () => {
  it("两轮(工具→收尾)落 2 条 llm + 1 条 tool,runId/agent 来自 logMeta,密钥已脱敏", async () => {
    const result = await runLoop(config(true), {
      model: "m-strong",
      systemPrompt: "sys",
      userMessage: "写一篇",
      tools: [echoTool],
      fetchImpl: makeFetch([toolCallTurn, finalTurn]),
      logMeta: { runId: "run-loop-test", agent: "writer" },
    });
    expect(result.finalMessage).toBe("全部搞定");
    await new Promise((r) => setTimeout(r, 60));

    const records = await readRun(dir, "run-loop-test");
    expect(records.map((r) => r.kind)).toEqual(["llm", "tool", "llm"]);
    expect(records.every((r) => r.agent === "writer")).toBe(true);
    const [llm1, tool1, llm2] = records;
    expect(llm1.name).toBe("m-strong");
    expect(llm1.tokens).toBe(40);
    expect(llm1.input).toContain("写一篇");
    expect(llm1.output).toContain("tool_calls");
    expect(tool1.name).toBe("echo");
    expect(tool1.output).toBe("echoed");
    expect(tool1.input).not.toContain("sk-secret");
    expect(llm2.output).toContain("全部搞定");
  });

  it("logMeta 缺省 → 自动 run-eng-* 归属", async () => {
    await runLoop(config(true), {
      model: "m-fast",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl: makeFetch([finalTurn]),
    });
    await new Promise((r) => setTimeout(r, 60));
    const runs = await listRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toMatch(/^run-eng-/);
  });

  it("config 无 dataDir(手工构造/存量测试)→ 不落任何日志", async () => {
    await runLoop(config(false), {
      model: "m-fast",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl: makeFetch([finalTurn]),
      logMeta: { runId: "run-nolog" },
    });
    await new Promise((r) => setTimeout(r, 60));
    await expect(fs.access(path.join(dir, "logs"))).rejects.toThrow();
  });

  it("模型调用失败也留痕(ok:false + error)后原样抛出", async () => {
    const failingFetch = (async () => {
      throw new Error("relay 断流");
    }) as unknown as typeof fetch;
    await expect(
      runLoop(config(true), {
        model: "m-strong",
        systemPrompt: "s",
        userMessage: "u",
        fetchImpl: failingFetch,
        logMeta: { runId: "run-fail" },
      }),
    ).rejects.toThrow("relay 断流");
    await new Promise((r) => setTimeout(r, 60));
    const records = await readRun(dir, "run-fail");
    expect(records).toHaveLength(1);
    expect(records[0].ok).toBe(false);
    expect(records[0].error).toContain("relay 断流");
  });
});
