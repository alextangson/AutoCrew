/**
 * cdp-session.test.ts — CDP 会话基座的加固点（codex #15 点名的五处缺陷）。
 * 全程注入假 WebSocket + 假 fetch，不碰真 Chrome：锁的是协议层行为，不是浏览器。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { CdpSession, withCdpTab } from "./cdp-session.js";

type Listener = (ev: unknown) => void;

/** 最小 CDP 桩：记录发出的命令，按需回帧；close/error 可手动触发 */
class FakeSocket {
  sent: string[] = [];
  closed = false;
  autoResult: ((method: string) => Record<string, unknown> | undefined) | null = null;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string): void {
    this.sent.push(data);
    const msg = JSON.parse(data) as { id: number; method: string };
    const result = this.autoResult?.(msg.method);
    if (result) queueMicrotask(() => this.reply({ id: msg.id, result }));
  }
  close(): void {
    this.closed = true;
    this.emit("close", {});
  }
  emit(type: string, ev: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  reply(msg: unknown): void {
    this.emit("message", { data: JSON.stringify(msg) });
  }
  get methods(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { method: string }).method);
  }
  get lastId(): number {
    return (JSON.parse(this.sent[this.sent.length - 1]) as { id: number }).id;
  }
}

async function connectFake(): Promise<{ session: CdpSession; socket: FakeSocket }> {
  const socket = new FakeSocket();
  const fetchImpl = (async () => ({ json: async () => ({ webSocketDebuggerUrl: "ws://fake/devtools" }) })) as unknown as typeof fetch;
  const session = await CdpSession.connect({
    httpBase: "http://fake",
    commandTimeoutMs: 5_000,
    fetchImpl,
    createSocket: () => {
      queueMicrotask(() => socket.emit("open", {}));
      return socket as unknown as WebSocket;
    },
  });
  return { session, socket };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("cmd 超时定时器", () => {
  it("命令成功后清理定时器（不再泄漏到进程退出）", async () => {
    const { session, socket } = await connectFake();
    vi.useFakeTimers(); // 连接完成后再假计时，避免把 connect 的内部计时器算进来
    const pending = session.cmd("Target.createTarget", { url: "about:blank" });
    expect(vi.getTimerCount()).toBe(1);
    socket.reply({ id: socket.lastId, result: { targetId: "t1" } });
    await expect(pending).resolves.toMatchObject({ targetId: "t1" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("命令报错后同样清理定时器", async () => {
    const { session, socket } = await connectFake();
    vi.useFakeTimers();
    const pending = session.cmd("Runtime.evaluate", {});
    socket.reply({ id: socket.lastId, error: { message: "no such session" } });
    await expect(pending).rejects.toThrow(/no such session/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超时未响应 → reject", async () => {
    const { session } = await connectFake();
    vi.useFakeTimers();
    const pending = session.cmd("Runtime.evaluate", {});
    const assertion = expect(pending).rejects.toThrow(/无响应/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});

describe("WebSocket 断开", () => {
  it("close 时 reject 全部 pending（不再挂到 30s 超时）", async () => {
    const { session, socket } = await connectFake();
    const a = session.cmd("Runtime.evaluate", {});
    const b = session.cmd("Target.closeTarget", {});
    socket.emit("close", {});
    await expect(a).rejects.toThrow(/断开/);
    await expect(b).rejects.toThrow(/断开/);
  });

  it("断开后新命令立刻 reject，不再往死连接上发", async () => {
    const { session, socket } = await connectFake();
    socket.emit("close", {});
    await expect(session.cmd("Runtime.evaluate", {})).rejects.toThrow(/断开/);
    expect(socket.sent).toHaveLength(0);
  });

  it("主动 close() 也 reject pending", async () => {
    const { session, socket } = await connectFake();
    const pending = session.cmd("Runtime.evaluate", {});
    session.close();
    expect(socket.closed).toBe(true);
    await expect(pending).rejects.toThrow(/关闭|断开/);
  });
});

describe("Runtime.evaluate exceptionDetails", () => {
  it("页面内抛错 → 转错误，而不是静默 undefined", async () => {
    const { session, socket } = await connectFake();
    const pending = session.eval("boom()", "s1");
    socket.reply({
      id: socket.lastId,
      result: {
        result: { type: "object" },
        exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom is not a function" } },
      },
    });
    await expect(pending).rejects.toThrow(/boom is not a function/);
  });

  it("正常求值返回值", async () => {
    const { session, socket } = await connectFake();
    const pending = session.eval("location.href", "s1");
    socket.reply({ id: socket.lastId, result: { result: { value: "https://mp.weixin.qq.com/cgi-bin/home?token=123" } } });
    await expect(pending).resolves.toContain("token=123");
  });
});

describe("fetchInPage", () => {
  const respond = (socket: FakeSocket, value: unknown) => socket.reply({ id: socket.lastId, result: { result: { value } } });

  it("返回 {httpStatus,finalUrl,contentType,bodyText}，判定权留给调用方", async () => {
    const { session, socket } = await connectFake();
    const pending = session.fetchInPage("https://mp.weixin.qq.com/api", "s1");
    respond(socket, {
      httpStatus: 200,
      finalUrl: "https://mp.weixin.qq.com/api",
      contentType: "application/json; charset=UTF-8",
      bodyText: '{"base_resp":{"ret":0}}',
    });
    await expect(pending).resolves.toEqual({
      httpStatus: 200,
      finalUrl: "https://mp.weixin.qq.com/api",
      contentType: "application/json; charset=UTF-8",
      bodyText: '{"base_resp":{"ret":0}}',
    });
  });

  it("HTML 伪装 200 → 原样交回（调用方判 schema_changed，不在这层变成空数组）", async () => {
    const { session, socket } = await connectFake();
    const pending = session.fetchInPage("https://mp.weixin.qq.com/api", "s1");
    respond(socket, { httpStatus: 200, finalUrl: "https://mp.weixin.qq.com/login", contentType: "text/html", bodyText: "<html>扫码登录</html>" });
    const res = await pending;
    expect(res.contentType).toBe("text/html");
    expect(res.bodyText).toContain("扫码登录");
  });

  it("返回形状不对 → 抛错，不假装拿到了响应", async () => {
    const { session, socket } = await connectFake();
    const pending = session.fetchInPage("https://mp.weixin.qq.com/api", "s1");
    respond(socket, { oops: true });
    await expect(pending).rejects.toThrow(/形状异常/);
  });
});

describe("withCdpTab", () => {
  const wire = (socket: FakeSocket) => {
    socket.autoResult = (method) => {
      if (method === "Target.createTarget") return { targetId: "t1" };
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      return {};
    };
  };

  it("正常路径关标签", async () => {
    const { session, socket } = await connectFake();
    wire(socket);
    const got = await withCdpTab(session, "https://mp.weixin.qq.com/", async (tab) => tab.sessionId);
    expect(got).toBe("s1");
    expect(socket.methods).toContain("Target.closeTarget");
  });

  it("异常路径也关标签（不留后台幽灵标签）", async () => {
    const { session, socket } = await connectFake();
    wire(socket);
    await expect(
      withCdpTab(session, "https://mp.weixin.qq.com/", async () => {
        throw new Error("页面内炸了");
      }),
    ).rejects.toThrow("页面内炸了");
    expect(socket.methods).toContain("Target.closeTarget");
  });
});
