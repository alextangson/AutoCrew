/**
 * chat:turn / chat:abort / chat:turn_status 全链（对话控制面设计 §Phase 3）。
 *
 * 走真 handler + 真 runLoop，只把上游 fetch 换成夹具：中止是跨 IPC/编排/传输/持久化
 * 四层的契约，任何一层单测过了都不代表用户点「停止」真的停得下来。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildIpcHandlers } from "./ipc.js";
import { resetActiveTurns, readRecentTurns } from "./turn-registry.js";
import { shutdownObserver } from "../engine/observer.js";
import { getConversation, listConversations } from "../storage/conversation-store.js";
import { openaiSse, sseResponse } from "../engine/sse-fixtures.js";

let dir: string;
const handlers = buildIpcHandlers();
const chatTurn = (payload: Record<string, unknown>) => handlers["chat:turn"]({ ...payload, _dataDir: dir });
const chatAbort = (payload: Record<string, unknown>) => handlers["chat:abort"]({ ...payload, _dataDir: dir });
const turnStatus = (payload: Record<string, unknown>) => handlers["chat:turn_status"]({ ...payload, _dataDir: dir });

/**
 * 上游夹具。chatTurnHandler 不吃 fetchImpl（生产路径不留测试缝），所以只能 stub 全局 fetch——
 * 但 SDK 打的是观察器的 127.0.0.1 环回地址，那一腿必须放行走真 fetch，
 * 否则中止根本走不到观察器，测的就不是真链路了。
 */
const realFetch = globalThis.fetch;

function upstreamFetch(handle: (init?: { signal?: AbortSignal }) => Response): typeof fetch {
  return (async (url: unknown, init?: { signal?: AbortSignal }) => {
    if (String(url).startsWith("http://127.0.0.1")) return realFetch(url as string, init as RequestInit);
    return handle(init);
  }) as unknown as typeof fetch;
}

/** 一句话回复的正常上游 */
function replyFetch(text: string): typeof fetch {
  return upstreamFetch(() => sseResponse(openaiSse({ choices: [{ message: { content: text } }], usage: { total_tokens: 7 } })));
}

/** 只发头不发体的上游：等外部中止信号到达才断——模拟「模型还在吐字时用户点停」 */
function hangingFetch(onCall?: () => void): typeof fetch {
  return upstreamFetch((init) => {
    onCall?.();
    const stream = new ReadableStream({
      start(c) {
        init?.signal?.addEventListener("abort", () => c.error(new Error("aborted by user")));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
}

beforeEach(async () => {
  resetActiveTurns();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-turnctl-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "test-key", baseUrl: "https://fake.local" }));
});

afterEach(async () => {
  resetActiveTurns();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterEach(() => shutdownObserver());

describe("chat:turn 注册与 settle", () => {
  it("带 turn_id/client_id 的一轮：正常返回，settle 后进 recent-turns 环（可凭 turnId 查 done）", async () => {
    vi.stubGlobal("fetch", replyFetch("好的"));
    const res = await chatTurn({ message: "你好", turn_id: "turn-1", client_id: "客户端A" });

    expect(res.ok).toBe(true);
    const convId = (res.data as Record<string, unknown>).conversationId as string;
    const ring = await readRecentTurns(dir);
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatchObject({ turnId: "turn-1", conversationId: convId });

    const status = await turnStatus({ turn_id: "turn-1" });
    expect(status).toMatchObject({ ok: true, data: { status: "done", conversationId: convId } });
  });

  it("assistant 消息落盘带 turnId（断线后能认领本轮结果）", async () => {
    vi.stubGlobal("fetch", replyFetch("落盘看看"));
    const res = await chatTurn({ message: "你好", turn_id: "turn-1", client_id: "客户端A" });
    const convId = (res.data as Record<string, unknown>).conversationId as string;
    const conv = await getConversation(convId, dir);
    expect(conv!.messages[1]).toMatchObject({ role: "assistant", turnId: "turn-1" });
    expect(conv!.messages[0].turnId).toBeUndefined(); // user 消息不带
  });

  it("同 client 未 settle 时再发一轮被拒（错误形态沿用 invoke 惯例）", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", (async () => {
      await gate;
      return sseResponse(openaiSse({ choices: [{ message: { content: "慢慢来" } }], usage: { total_tokens: 3 } }));
    }) as typeof fetch);

    const first = chatTurn({ message: "第一轮", turn_id: "turn-1", client_id: "客户端A" });
    await new Promise((r) => setTimeout(r, 30));

    const second = await chatTurn({ message: "第二轮", turn_id: "turn-2", client_id: "客户端A" });
    expect(second.ok).toBe(false);
    expect(String(second.error)).toContain("上一轮还在进行");

    // 重复 turnId 也拒
    const dup = await chatTurn({ message: "重复", turn_id: "turn-1", client_id: "客户端B" });
    expect(dup.ok).toBe(false);
    expect(String(dup.error)).toContain("重复");

    release!();
    expect((await first).ok).toBe(true);
    // settle 之后放行
    const after = await chatTurn({ message: "第三轮", turn_id: "turn-3", client_id: "客户端A" });
    expect(after.ok).toBe(true);
  });

  it("老前端不传 turn_id/client_id：照常对话，不登记也不可中止（兼容路径）", async () => {
    vi.stubGlobal("fetch", replyFetch("老前端也能用"));
    const res = await chatTurn({ message: "你好" });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).reply).toBe("老前端也能用");
    expect(await readRecentTurns(dir)).toEqual([]);
    // 连发两轮也不会被 busy 拦
    expect((await chatTurn({ message: "再来一句" })).ok).toBe(true);
  });
});

describe("chat:abort", () => {
  it("命中回 settling，中止后整轮走 ok:true + stopReason=aborted，并按正常轮落盘", async () => {
    let modelCalls = 0;
    vi.stubGlobal("fetch", hangingFetch(() => { modelCalls++; }));

    const turn = chatTurn({ message: "写一篇长文", turn_id: "turn-1", client_id: "客户端A" });
    await new Promise((r) => setTimeout(r, 50));

    const abortRes = await chatAbort({ turn_id: "turn-1", client_id: "客户端A" });
    expect(abortRes).toEqual({ ok: true, settling: true });

    const res = await turn;
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.stopReason).toBe("aborted");
    expect(data.reply).toBe("已停。"); // 不再误报「任务已完成」
    expect(modelCalls).toBe(1); // 用户中止不重试

    // 中止不是失败轮：成对落盘，没有「本轮执行失败」留痕
    const convs = await listConversations(dir);
    expect(convs).toHaveLength(1);
    const conv = await getConversation(convs[0].id, dir);
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.messages[1].content).toBe("已停。");
    expect(conv!.messages[1].turnId).toBe("turn-1");
    expect(String(conv!.messages[1].content)).not.toContain("失败");
  });

  it("中止后立刻再发言：上一轮 settle 前拒（正在停止），settle 后正常起新轮", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const turn = chatTurn({ message: "长文", turn_id: "turn-1", client_id: "客户端A" });
    await new Promise((r) => setTimeout(r, 50));
    await chatAbort({ turn_id: "turn-1", client_id: "客户端A" });

    const tooEarly = await chatTurn({ message: "换个话题", turn_id: "turn-2", client_id: "客户端A" });
    expect(tooEarly.ok).toBe(false);
    expect(String(tooEarly.error)).toContain("正在停止");

    await turn;
    vi.stubGlobal("fetch", replyFetch("新的一轮"));
    const next = await chatTurn({ message: "换个话题", turn_id: "turn-2", client_id: "客户端A" });
    expect(next.ok).toBe(true);
  });

  it("幂等两态：未知/已完成的 turn 回 already:done；归属不符明确拒绝", async () => {
    expect(await chatAbort({ turn_id: "从没有过", client_id: "客户端A" })).toEqual({ ok: true, already: "done" });

    vi.stubGlobal("fetch", hangingFetch());
    const turn = chatTurn({ message: "长文", turn_id: "turn-1", client_id: "客户端A" });
    await new Promise((r) => setTimeout(r, 50));

    const otherTab = await chatAbort({ turn_id: "turn-1", client_id: "客户端B" });
    expect(otherTab.ok).toBe(false);
    expect(String(otherTab.error)).toContain("不是本页面发起的");

    await chatAbort({ turn_id: "turn-1", client_id: "客户端A" });
    await turn;
    // 停止连点：轮已收尾，再点仍是幂等成功
    expect(await chatAbort({ turn_id: "turn-1", client_id: "客户端A" })).toEqual({ ok: true, already: "done" });
  });

  it("缺 turn_id/client_id 的 abort 直接拒（契约字段在 handler 也有纵深校验）", async () => {
    expect((await chatAbort({ turn_id: "turn-1" })).ok).toBe(false);
    expect((await chatAbort({ client_id: "客户端A" })).ok).toBe(false);
  });
});

describe("chat:turn_status 三态", () => {
  it("running（进行中）→ done（settle 后带 conversationId）→ unknown（没见过）", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const turn = chatTurn({ message: "长文", turn_id: "turn-1", client_id: "客户端A" });
    await new Promise((r) => setTimeout(r, 50));

    expect((await turnStatus({ turn_id: "turn-1" })).data).toMatchObject({ status: "running" });
    expect((await turnStatus({ turn_id: "别的轮" })).data).toEqual({ status: "unknown" });

    await chatAbort({ turn_id: "turn-1", client_id: "客户端A" });
    const res = await turn;
    const convId = (res.data as Record<string, unknown>).conversationId as string;
    expect((await turnStatus({ turn_id: "turn-1" })).data).toEqual({ status: "done", conversationId: convId });
  });

  it("缺 turn_id 拒绝", async () => {
    expect((await turnStatus({})).ok).toBe(false);
  });
});
