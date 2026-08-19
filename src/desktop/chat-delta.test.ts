/**
 * chat:turn 的流式 delta 广播全链（对话控制面设计 §Phase 3「流式 delta 协议」）。
 *
 * 与 chat-turn-control 同一条真链路：真 handler → 真 runChatTurn → 真 runLoop → 真观察器，
 * 只把上游 relay 换成分块 SSE 夹具。断的是广播协议：turnId 归属、seq 单调、
 * reset/delta/done 的次序，以及「没有 turnId 就不广播」这条门。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildIpcHandlers } from "./ipc.js";
import { resetActiveTurns } from "./turn-registry.js";
import { shutdownObserver } from "../engine/observer.js";
import { openaiSseTextParts, sseResponse } from "../engine/sse-fixtures.js";

interface DeltaFrame {
  turnId: string;
  seq: number;
  ev: "delta" | "reset" | "done";
  text?: string;
}

let dir: string;
let frames: DeltaFrame[];
const handlers = buildIpcHandlers();
const chatTurn = (payload: Record<string, unknown>) =>
  handlers["chat:turn"]({ ...payload, _dataDir: dir }, { onChatDelta: (e) => frames.push(e as DeltaFrame) });
const chatAbort = (payload: Record<string, unknown>) => handlers["chat:abort"]({ ...payload, _dataDir: dir });

/** 环回腿必须走真 fetch，否则测的就不是真链路（同 chat-turn-control 的纪律） */
const realFetch = globalThis.fetch;
function upstreamFetch(handle: (init?: { signal?: AbortSignal }) => Response): typeof fetch {
  return (async (url: unknown, init?: { signal?: AbortSignal }) => {
    if (String(url).startsWith("http://127.0.0.1")) return realFetch(url as string, init as RequestInit);
    return handle(init);
  }) as unknown as typeof fetch;
}

/** 分块吐字的上游：每段一个 SSE chunk */
const partsFetch = (parts: string[]) => upstreamFetch(() => sseResponse(openaiSseTextParts(parts), 5));

/** 只发头不发体，等中止信号才断 —— 「模型还在吐字时用户点停」 */
const hangingFetch = () =>
  upstreamFetch((init) => {
    const stream = new ReadableStream({
      start(c) {
        init?.signal?.addEventListener("abort", () => c.error(new Error("aborted by user")));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });

beforeEach(async () => {
  resetActiveTurns();
  frames = [];
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-delta-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "test-key", baseUrl: "https://fake.local" }));
});

afterEach(async () => {
  resetActiveTurns();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterEach(() => shutdownObserver());

describe("chat_delta 广播", () => {
  it("带 turn_id 的一轮：reset → 逐段 delta → done，全部挂在本轮 turnId 上", async () => {
    vi.stubGlobal("fetch", partsFetch(["这个选题", "我给你拆", "成三条"]));
    const res = await chatTurn({ message: "找选题", turn_id: "turn-1", client_id: "客户端A" });

    expect(res.ok).toBe(true);
    expect(frames.map((f) => f.ev)).toEqual(["reset", "delta", "delta", "delta", "done"]);
    expect(new Set(frames.map((f) => f.turnId))).toEqual(new Set(["turn-1"]));

    // 流式看到的正文 = invoke 返回的事实源（前端到货后全量覆盖，两者不该打架）
    const streamed = frames.filter((f) => f.ev === "delta").map((f) => f.text).join("");
    expect(streamed).toBe((res.data as Record<string, unknown>).reply);
  });

  it("seq 服务端计数：从 0 开始逐帧递增，前端据此丢重复/迟到帧", async () => {
    vi.stubGlobal("fetch", partsFetch(["一", "二", "三", "四"]));
    await chatTurn({ message: "数数", turn_id: "turn-1", client_id: "客户端A" });

    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    expect(frames.length).toBeGreaterThan(2);
  });

  it("没有 turn_id（老前端）：一帧都不广播——不可寻址的 delta 前端无从判断该不该渲染", async () => {
    vi.stubGlobal("fetch", partsFetch(["照常", "回复"]));
    const res = await chatTurn({ message: "你好" });

    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).reply).toBe("照常回复");
    expect(frames).toEqual([]);
  });

  it("用户中止的一轮也发 done：气泡不许停在「还在吐字」的假象里", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const turn = chatTurn({ message: "写长文", turn_id: "turn-1", client_id: "客户端A" });
    await new Promise((r) => setTimeout(r, 50));
    await chatAbort({ turn_id: "turn-1", client_id: "客户端A" });

    const res = await turn;
    expect((res.data as Record<string, unknown>).stopReason).toBe("aborted");
    expect(frames.at(-1)).toMatchObject({ turnId: "turn-1", ev: "done" });
  });
});
