/** 登录跨重启（1b §9）：首屏请求先等会话交换；失效 token + 有效 cookie 不报错 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { url: string; method: string };
let calls: Call[];
let sessionReply: { status: number; body: Record<string, unknown> };

function stubBrowser(href: string): void {
  const loc = new URL(href);
  vi.stubGlobal("window", {
    location: { get href() { return loc.href; } },
    history: { replaceState: (_s: unknown, _t: string, url: string) => { const next = new URL(url, loc.origin); loc.pathname = next.pathname; loc.search = next.search; loc.hash = next.hash; } },
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    // 会话交换要慢一拍：没等它的请求会先到
    if (url === "/api/session") { await new Promise((r) => setTimeout(r, 20)); return new Response(JSON.stringify(sessionReply.body), { status: sessionReply.status }); }
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
  });
}

beforeEach(() => { calls = []; sessionReply = { status: 200, body: { ok: true } }; vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("首屏请求先等 ensureSession（§9）", () => {
  it("两者都无效：看板读取报「登录过期」和拿新链接的办法，不说「连不上」", async () => {
    sessionReply = { status: 403, body: { ok: false } };
    stubBrowser("http://127.0.0.1:4317/?token=stale#/board");
    const { loadBoard } = await import("./views/board-api");
    const r = await loadBoard();
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/^登录过期/);
  });

  it("看板读取排在会话交换之后", async () => {
    stubBrowser("http://127.0.0.1:4317/?token=boot#/board");
    const { loadBoard } = await import("./views/board-api");
    await loadBoard();
    expect(calls.map((c) => c.url)).toEqual(["/api/session", "/api/board"]);
  });
});

describe("地址栏 token 失效（§9，B22）", () => {
  it("cookie 仍有效（服务端回 existing）→ 不报错，地址栏去掉 token", async () => {
    sessionReply = { status: 200, body: { ok: true, existing: true } };
    stubBrowser("http://127.0.0.1:4317/?token=stale#/board");
    const { invoke } = await import("./transport");
    const r = await invoke("x:y");
    expect(r.ok).toBe(true);
    expect((globalThis as unknown as { window: Window }).window.location.href).toBe("http://127.0.0.1:4317/#/board");
  });

  it("两者都无效 → 报「登录过期」，并写怎么拿新链接", async () => {
    sessionReply = { status: 403, body: { ok: false, error: "bad token" } };
    stubBrowser("http://127.0.0.1:4317/?token=stale");
    const { invoke } = await import("./transport");
    const r = await invoke("x:y");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("登录过期");
    expect(String(r.error)).toContain("autocrew logs");
  });
});
