/**
 * cdp-network-tap.test.ts — 事件旁听。
 * 这里锁的是「不改基座也能拿到事件帧」这个手法本身:两个 message 监听共存于同一条 WebSocket,
 * 命令通道仍归 CdpSession 独占。基座哪天不再认 createSocket,这组用例第一个红。
 */
import { describe, it, expect } from "vitest";
import { connectWithEventTap, createEventTap, waitForEvent, type CdpEvent } from "./cdp-network-tap.js";

type Listener = (ev: unknown) => void;

class FakeSocket {
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  emit(type: string, ev: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  frame(msg: unknown): void {
    this.emit("message", { data: JSON.stringify(msg) });
  }
  get lastId(): number {
    return (JSON.parse(this.sent[this.sent.length - 1]) as { id: number }).id;
  }
  get listenerCount(): number {
    return this.listeners.get("message")?.length ?? 0;
  }
}

async function connectFake(): Promise<{ session: Awaited<ReturnType<typeof connectWithEventTap>>["session"]; tap: ReturnType<typeof createEventTap>; socket: FakeSocket }> {
  const socket = new FakeSocket();
  const fetchImpl = (async () => ({ json: async () => ({ webSocketDebuggerUrl: "ws://fake/devtools" }) })) as unknown as typeof fetch;
  const { session, tap } = await connectWithEventTap({
    httpBase: "http://fake",
    commandTimeoutMs: 5_000,
    fetchImpl,
    createSocket: () => {
      queueMicrotask(() => socket.emit("open", {}));
      return socket as unknown as WebSocket;
    },
  });
  return { session, tap, socket };
}

describe("createEventTap", () => {
  it("只认事件帧:带 id 的命令响应、坏 JSON、无 method 的帧一律不派发", () => {
    const tap = createEventTap();
    const seen: CdpEvent[] = [];
    tap.on((ev) => seen.push(ev));
    tap.feed(JSON.stringify({ id: 7, result: { targetId: "t1" } }));
    tap.feed("{坏帧");
    tap.feed(JSON.stringify({ params: { a: 1 } }));
    tap.feed(JSON.stringify({ method: "Network.responseReceived", sessionId: "s1", params: { requestId: "r1" } }));
    expect(seen).toEqual([{ method: "Network.responseReceived", sessionId: "s1", params: { requestId: "r1" } }]);
  });

  it("退订后不再收;一个订阅者抛错不带走整条事件流", () => {
    const tap = createEventTap();
    const seen: string[] = [];
    tap.on(() => {
      throw new Error("这个订阅者炸了");
    });
    const off = tap.on(() => seen.push("b"));
    tap.feed(JSON.stringify({ method: "X" }));
    off();
    tap.feed(JSON.stringify({ method: "X" }));
    expect(seen).toEqual(["b"]);
  });
});

describe("connectWithEventTap(不改基座拿事件)", () => {
  it("事件流与命令通道共存:事件到 tap,命令响应仍由 CdpSession 消化", async () => {
    const { session, tap, socket } = await connectFake();
    expect(socket.listenerCount).toBe(2); // 基座一个 + 我们一个
    const seen: CdpEvent[] = [];
    tap.on((ev) => seen.push(ev));

    socket.frame({ method: "Network.responseReceived", sessionId: "s1", params: { response: { url: "https://x/list" } } });
    expect(seen).toHaveLength(1);

    const pending = session.cmd("Target.createTarget", { url: "about:blank" });
    socket.frame({ id: socket.lastId, result: { targetId: "t1" } });
    await expect(pending).resolves.toMatchObject({ targetId: "t1" });
    expect(seen).toHaveLength(1); // 命令响应没被误当成事件
    session.close();
  });
});

describe("waitForEvent", () => {
  it("命中即返回,并且退订(后续事件不再唤醒它)", async () => {
    const tap = createEventTap();
    const pending = waitForEvent(tap, (ev) => ev.method === "Network.loadingFinished", 1_000);
    tap.feed(JSON.stringify({ method: "Network.responseReceived" }));
    tap.feed(JSON.stringify({ method: "Network.loadingFinished", params: { requestId: "r1" } }));
    await expect(pending).resolves.toMatchObject({ method: "Network.loadingFinished" });
  });

  it("超时返回 null —— 「没等到」是抓取器要区分的输入,不是异常", async () => {
    const tap = createEventTap();
    await expect(waitForEvent(tap, () => true, 20)).resolves.toBeNull();
  });
});
