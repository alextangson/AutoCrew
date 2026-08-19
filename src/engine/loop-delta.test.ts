/**
 * runLoop 流式正文透出（对话控制面设计 §Phase 3「流式 delta 协议」）。
 *
 * 走真 pi-ai 流解析 + 真观察器，只把上游换成夹具——断的是协议不变量：
 * 增量逐段到达、每次 attempt 先 reset（重试不许把废稿留在屏幕上）、
 * 多 assistant 轮（工具往返）每轮都透出、回调炸了不影响这一轮。
 */
import { describe, it, expect, afterAll } from "vitest";
import { runLoop, type LoopTool, type LoopStreamEvent } from "./loop.js";
import { shutdownObserver } from "./observer.js";
import { openaiSse, openaiSseTextParts, sseResponse } from "./sse-fixtures.js";
import type { EngineConfig } from "./config.js";

const CFG: EngineConfig = { apiKey: "sk-test", baseUrl: "https://fake.local", strongModel: "m", fastModel: "f" };

afterAll(() => shutdownObserver());

/** 事件序列压成可断言的形状："reset" / "delta:文字" */
const shape = (events: LoopStreamEvent[]) => events.map((e) => (e.ev === "reset" ? "reset" : `delta:${e.text}`));
const textOf = (events: LoopStreamEvent[]) => events.filter((e) => e.ev === "delta").map((e) => (e as { text: string }).text).join("");

describe("正文增量透出", () => {
  it("分块上游：每段各透一次，拼起来等于最终回复", async () => {
    const events: LoopStreamEvent[] = [];
    const fetchImpl = (async () => sseResponse(openaiSseTextParts(["这个选题", "我给你拆", "成三条"]), 4)) as typeof fetch;

    const res = await runLoop(CFG, {
      model: "f",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl,
      onTextDelta: (e) => events.push(e),
    });

    expect(shape(events)).toEqual(["reset", "delta:这个选题", "delta:我给你拆", "delta:成三条"]);
    expect(textOf(events)).toBe(res.finalMessage); // 流式看到的与事实源一致
  });

  it("不传 onTextDelta：行为与今天一致（additive 扩展不改既有调用方）", async () => {
    const fetchImpl = (async () => sseResponse(openaiSseTextParts(["安静地", "写完"]))) as typeof fetch;
    const res = await runLoop(CFG, { model: "f", systemPrompt: "s", userMessage: "u", fetchImpl });
    expect(res.finalMessage).toBe("安静地写完");
  });

  it("回调抛异常被吞：观测层不得把一轮好好的生成打成失败", async () => {
    const fetchImpl = (async () => sseResponse(openaiSseTextParts(["照常", "收尾"]))) as typeof fetch;
    let calls = 0;
    const res = await runLoop(CFG, {
      model: "f",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl,
      onTextDelta: () => {
        calls++;
        throw new Error("推送炸了");
      },
    });
    expect(res.finalMessage).toBe("照常收尾");
    expect(calls).toBeGreaterThan(1); // 一次异常也不影响后续帧继续推
  });
});

describe("reset = 一次新 attempt", () => {
  it("重试场景：第一次断流已吐的字先作废，新 attempt 从 reset 重来", async () => {
    const events: LoopStreamEvent[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        // 上游先吐半句再断（relay 掐长流的真实形态）：字节已经到过前端，重试必须先清掉
        const half = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "半句话就" } }] })}\n\n`;
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(half));
            setTimeout(() => c.error(new Error("terminated")), 30);
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return sseResponse(openaiSseTextParts(["重来一遍", "的完整回答"]));
    }) as typeof fetch;

    const res = await runLoop(CFG, {
      model: "f",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl,
      onTextDelta: (e) => events.push(e),
    });

    expect(calls).toBe(2);
    expect(shape(events)).toEqual([
      "reset",
      "delta:半句话就",
      "reset", // 新 attempt：前一次的半句作废
      "delta:重来一遍",
      "delta:的完整回答",
    ]);
    expect(res.finalMessage).toBe("重来一遍的完整回答");
  });

  it("多 assistant 轮（工具往返）：每轮文本都透出，轮与轮之间有 reset", async () => {
    const events: LoopStreamEvent[] = [];
    const tool: LoopTool = {
      name: "find_topics",
      description: "找选题",
      parameters: { type: "object", properties: {} },
      execute: () => "三条选题",
    };
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return sseResponse(
          openaiSse({
            choices: [
              {
                message: {
                  content: "我先去扫一眼热榜",
                  tool_calls: [{ id: "c1", function: { name: "find_topics", arguments: "{}" } }],
                },
              },
            ],
            usage: { total_tokens: 5 },
          }),
        );
      }
      return sseResponse(openaiSseTextParts(["找到了", "三条"]));
    }) as typeof fetch;

    const res = await runLoop(CFG, {
      model: "f",
      systemPrompt: "s",
      userMessage: "u",
      tools: [tool],
      fetchImpl,
      onTextDelta: (e) => events.push(e),
    });

    expect(calls).toBe(2);
    expect(shape(events)).toEqual(["reset", "delta:我先去扫一眼热榜", "reset", "delta:找到了", "delta:三条"]);
    // 事实源是最后一轮的文本，流式气泡按 reset 清空后正好对上
    expect(res.finalMessage).toBe("找到了三条");
  });
});
