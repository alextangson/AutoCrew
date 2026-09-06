/**
 * 转发器（P3 §3）的验收：转发带 bearer、通知不写回、守护进程没起报得清楚，
 * 而且**任何情况下都不起第二个服务**——后者是这一片存在的全部理由。
 */
import { describe, expect, it, vi } from "vitest";
import {
  DAEMON_DOWN_MESSAGE,
  forwardMessage,
  resolveForwarderToken,
  runForwarder,
} from "../../bin/mcp-forwarder.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

function tempDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "autocrew-forwarder-"));
}

function fakeDaemon(handler: (body: unknown) => { status?: number; body?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body = "" } = handler(JSON.parse(String(init.body)));
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  });
  return { fetchImpl, calls };
}

function collect(): { stream: Writable; written: string[] } {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      written.push(String(chunk));
      cb();
    },
  });
  return { stream, written };
}

describe("mcp stdio forwarder", () => {
  it("forwards a request with the bearer token and writes the reply back", async () => {
    const { fetchImpl, calls } = fakeDaemon(() => ({ body: JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }) }));
    const reply = await forwardMessage({ jsonrpc: "2.0", id: 7, method: "tools/list" }, {
      url: "http://127.0.0.1:4317/mcp",
      token: "tok-abc",
      fetchImpl,
    });
    expect(reply).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    expect(calls[0].url).toBe("http://127.0.0.1:4317/mcp");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");
  });

  it("forwards notifications but writes nothing back", async () => {
    const { fetchImpl, calls } = fakeDaemon(() => ({ status: 202 }));
    const reply = await forwardMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, {
      url: "http://127.0.0.1:4317/mcp",
      token: "tok",
      fetchImpl,
    });
    expect(reply).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("answers a JSON-RPC error when the daemon is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const reply = await forwardMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, {
      url: "http://127.0.0.1:4317/mcp",
      token: "",
      fetchImpl,
    });
    expect(reply).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: DAEMON_DOWN_MESSAGE } });
  });

  it("says so when the token was revoked instead of degrading silently", async () => {
    const { fetchImpl } = fakeDaemon(() => ({ status: 401, body: "{}" }));
    const reply = (await forwardMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, {
      url: "http://127.0.0.1:4317/mcp",
      token: "stale",
      fetchImpl,
    })) as { error: { code: number; message: string } };
    expect(reply.error.code).toBe(-32000);
    expect(reply.error.message).toContain("autocrew host claude-code");
  });

  it("prefers the named host token over the legacy server-token", () => {
    const dir = tempDataDir();
    writeFileSync(path.join(dir, "server-token"), "legacy\n");
    expect(resolveForwarderToken(dir, {})).toBe("legacy");
    mkdirSync(path.join(dir, "tokens"), { recursive: true });
    writeFileSync(path.join(dir, "tokens", "claude-code.token"), "named\n");
    expect(resolveForwarderToken(dir, {})).toBe("named");
    expect(resolveForwarderToken(dir, { AUTOCREW_TOKEN: "from-env" })).toBe("from-env");
  });

  it("pipes stdin lines through and never spawns a server", async () => {
    const { fetchImpl } = fakeDaemon((body) => {
      const message = body as { id?: number };
      return message.id === undefined
        ? { status: 202 }
        : { body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) };
    });
    const { stream, written } = collect();
    const input = Readable.from([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      "not json\n",
    ]);
    await runForwarder({ input, output: stream, env: { AUTOCREW_DATA_DIR: tempDataDir() }, fetchImpl });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });
});
