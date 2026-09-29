/** 发布前把关的创始人专属路由（spec §3、§6、E6）：只认浏览器会话 + 同源；两条复制路径都存编辑后的文本 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createPublishPrefsHandler } from "./publish-prefs-route.js";
import { makeEnv, videoContent, type Env } from "../modules/production/testkit.js";
import { proposePreference, readPublishPrefs } from "../modules/publish/review-gate/preferences.js";
import { readInstruction } from "../modules/publish/review-gate/instructions.js";

let env: Env;
let server: http.Server;
let base: string;

beforeEach(async () => {
  env = await makeEnv();
  const handler = createPublishPrefsHandler({
    authorize: (req) => (req.headers["x-test-auth"] === "session" ? "session" : req.headers["x-test-auth"] === "bearer" ? "bearer" : null),
    originAllowed: (req) => req.headers.origin === "http://127.0.0.1:4317",
    readBody: (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); }),
    resolveDataDir: async () => env.dir,
  });
  server = http.createServer((req, res) => { void handler(req, res, new URL(req.url ?? "/", "http://x")).then((hit) => { if (!hit) res.writeHead(404).end(); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise((r) => server.close(r)); await env.cleanup(); });

const post = (p: string, body: unknown, auth = "session") => fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-auth": auth, Origin: "http://127.0.0.1:4317" }, body: JSON.stringify(body) });

describe("只有创始人（浏览器会话）能确认偏好、改规则、存指令", () => {
  it("MCP bearer / 未登录 / 跨源 → 403，偏好不变", async () => {
    const p = await proposePreference({ kind: "cover_ratio", platform: "xiaohongshu", value: ["4:3"], founder_quote: "小红书用横的" }, "codex", env.dir);
    const id = (p as { proposal: { id: string } }).proposal.id;
    for (const auth of ["bearer", "none"]) expect((await post("/api/publish-prefs", { op: "decide_proposal", id, decision: "confirm" }, auth)).status).toBe(403);
    const crossOrigin = await fetch(`${base}/api/publish-prefs`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-auth": "session", Origin: "https://evil.example" }, body: JSON.stringify({ op: "decide_proposal", id, decision: "confirm" }) });
    expect(crossOrigin.status).toBe(403);
    expect((await readPublishPrefs(env.dir)).coverRatios).toEqual({});
    const ok = await post("/api/publish-prefs", { op: "decide_proposal", id, decision: "confirm" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, coverRatios: { xiaohongshu: ["4:3"] }, proposals: [] });
  });

  it("GET 回默认表（B站 4:3 + 裁切核对）与待确认提议", async () => {
    await proposePreference({ kind: "rule", value: "标题别加表情", founder_quote: "别加表情" }, "codex", env.dir);
    const r = await fetch(`${base}/api/publish-prefs`, { headers: { "x-test-auth": "session" } });
    const body = await r.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, defaults: { bilibili: ["4:3"], xiaohongshu: ["3:4"] }, proposals: [{ kind: "rule" }] });
    expect(JSON.stringify(body.crop_checks)).toContain("16:9");
    expect((await fetch(`${base}/api/publish-prefs`, { headers: { "x-test-auth": "bearer" } })).status).toBe(403);
  });

  it("「复制」与「复制并打开」两条路径都存编辑后的文本，回带编号的复制文本", async () => {
    const c = await videoContent(env, "一条稿");
    for (const via of ["copy", "copy_open"]) {
      const r = await post("/api/publish-instruction", { content_id: c.id, text: `我改过的指令（${via}）`, via });
      const body = await r.json() as { ok: boolean; instruction_id: string; copy_text: string };
      expect(body.ok).toBe(true);
      expect(body.copy_text.endsWith(`指令编号：${body.instruction_id}`)).toBe(true);
      expect(await readInstruction(c.id, body.instruction_id, env.dir)).toMatchObject({ ok: true, instruction: { text: `我改过的指令（${via}）`, via } });
    }
    expect((await post("/api/publish-instruction", { content_id: c.id, text: "x", via: "copy" }, "bearer")).status).toBe(403);
    expect((await post("/api/publish-instruction", { content_id: c.id, text: "", via: "copy" })).status).toBe(400);
  });
});
