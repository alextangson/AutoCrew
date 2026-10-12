/**
 * 进度栏补做 A / B（发布台 spec 2026-10-12）：「在访达打开这一条」按视图清单找「我的内容」文件夹，
 * 找不到写原因、路径逃逸拒、打开失败写原因、只给浏览器会话；读模型带交接详情与认领租约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { missingReason, revealMyContent } from "./my-content-reveal.js";
import { createProjectReviewHandler } from "./project-review-route.js";
import { publishDesk } from "../modules/production/publish-desk.js";
import { founderApprove, makeEnv, setContent, videoContent, type Env } from "../modules/production/testkit.js";
import type { Content } from "../storage/local-store.js";

/** 假 spawn：fail=报错；exit=退出码（默认 0）；hang=永不退出 */
const fakeSpawn = (fail?: string, exit: number | "hang" = 0) => vi.fn(() => {
  const child = new EventEmitter();
  setImmediate(() => { if (fail) child.emit("error", new Error(fail)); else { child.emit("spawn"); if (exit !== "hang") child.emit("exit", exit, null); } });
  return child;
}) as unknown as typeof spawn;

let env: Env, view: string, c: Content;
const mac = (spawnImpl = fakeSpawn()) => ({ platform: "darwin" as const, spawnImpl, viewRoot: view });
async function manifest(dirs: Record<string, string>) {
  await fs.writeFile(path.join(view, ".autocrew-view.json"), JSON.stringify({ version: 1, entries: {}, dirs }));
}

beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  view = path.join(path.dirname(env.dir), "我的内容");
  await fs.mkdir(view, { recursive: true });
  c = await videoContent(env, "访达样例");
});
afterEach(async () => { await env.cleanup(); });

describe("revealMyContent", () => {
  it("1/2：按清单找到这条在「我的内容」的文件夹，用 open 打开；换栏后点开的是新位置", async () => {
    await fs.mkdir(path.join(view, "2 待录制/1012 访达样例"), { recursive: true });
    await fs.mkdir(path.join(view, "3 剪辑中/1012 访达样例"), { recursive: true });
    await manifest({ "2 待录制": "_column", "2 待录制/1012 访达样例": c.id });
    const s = fakeSpawn();
    const r = await revealMyContent(c.id, env.dir, mac(s));
    expect(r).toEqual({ ok: true, opened: true, path: await fs.realpath(path.join(view, "2 待录制/1012 访达样例")) });
    expect(vi.mocked(s).mock.calls[0].slice(0, 2)).toEqual(["open", [r.path]]);
    await manifest({ "3 剪辑中/1012 访达样例": c.id });
    expect(await revealMyContent(c.id, env.dir, mac())).toMatchObject({ ok: true, path: await fs.realpath(path.join(view, "3 剪辑中/1012 访达样例")) });
  });

  it("2：id 不合法、符号链接逃出「我的内容」都拒，不开窗", async () => {
    const s = fakeSpawn();
    expect(await revealMyContent("../x", env.dir, mac(s))).toMatchObject({ ok: false, code: "bad_request" });
    await fs.mkdir(path.join(view, "2 待录制"), { recursive: true });
    await fs.symlink(env.outside, path.join(view, "2 待录制/1012 访达样例"));
    await manifest({ "2 待录制/1012 访达样例": c.id });
    expect(await revealMyContent(c.id, env.dir, mac(s))).toMatchObject({ ok: false, code: "bad_request" });
    expect(s).not.toHaveBeenCalled();
  });

  it("3：视图里没有 → 具体原因（没生成 / 没同步到 / 同步出错 / 已发布超出保留），不开别的文件夹", async () => {
    const s = fakeSpawn();
    expect(await revealMyContent(c.id, env.dir, mac(s))).toMatchObject({ ok: false, code: "not_in_view", error: "「我的内容」还没生成过" });
    await manifest({});
    expect(await revealMyContent(c.id, env.dir, mac(s))).toMatchObject({ code: "not_in_view", error: expect.stringContaining("还没同步到这条") });
    const d = new Date(c.createdAt); const title = `${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")} 访达样例`;
    await fs.writeFile(path.join(view, ".autocrew-errors.json"), JSON.stringify({ sync: [`2 待录制/${title}/口播稿.md：ENOSPC: no space left on device`] }));
    expect(await revealMyContent(c.id, env.dir, mac(s))).toMatchObject({ code: "not_in_view", error: expect.stringContaining("ENOSPC") });
    expect(await revealMyContent(c.id, env.dir, { ...mac(s), viewRoot: null })).toMatchObject({ code: "not_in_view", error: expect.stringContaining("没有配置资料库") });
    expect(s).not.toHaveBeenCalled();
  });

  it("3：已发布、不在保留名单里 → 明说（出错优先于它）", async () => {
    expect(await missingReason(view, c.id, "1012 访达样例", "已发布")).toBe("这条已发布，不在「我的内容」保留的最近几条里");
    await fs.writeFile(path.join(view, ".autocrew-errors.json"), JSON.stringify({ sync: [`访达样例（${c.id}）：坏了`] }));
    expect(await missingReason(view, c.id, "1012 访达样例", "已发布")).toContain("上次同步这条出错了");
  });

  it("4：清单里有但文件夹没了 / 非 macOS / spawn 报错 → 原因，不假装打开", async () => {
    await manifest({ "2 待录制/1012 访达样例": c.id });
    expect(await revealMyContent(c.id, env.dir, mac())).toMatchObject({ ok: false, code: "not_in_view", error: expect.stringContaining("找不到了") });
    await fs.mkdir(path.join(view, "2 待录制/1012 访达样例"), { recursive: true });
    expect(await revealMyContent(c.id, env.dir, { ...mac(), platform: "linux" })).toMatchObject({ ok: false, code: "open_failed", error: expect.stringContaining("不是 macOS") });
    expect(await revealMyContent(c.id, env.dir, mac(fakeSpawn("spawn open ENOENT")))).toMatchObject({ ok: false, code: "open_failed", error: "访达没打开：spawn open ENOENT" });
  });
});

describe("Codex 审 P2", () => {
  it("open 非 0 退出 / 一直不返回 → open_failed，不报打开了", async () => {
    await fs.mkdir(path.join(view, "2 待录制/1012 访达样例"), { recursive: true });
    await manifest({ "2 待录制/1012 访达样例": c.id });
    expect(await revealMyContent(c.id, env.dir, mac(fakeSpawn(undefined, 1)))).toMatchObject({ ok: false, code: "open_failed", error: "访达没打开：open 退出码 1" });
    expect(await revealMyContent(c.id, env.dir, { ...mac(fakeSpawn(undefined, "hang")), openTimeoutMs: 20 })).toMatchObject({ ok: false, code: "open_failed", error: expect.stringContaining("超时") });
  });
  it("清单坏了 = view_unreadable（不是 not_in_view）；重读一次赶上对账写完就成功", async () => {
    await fs.writeFile(path.join(view, ".autocrew-view.json"), "{半截");
    expect(await revealMyContent(c.id, env.dir, { ...mac(), retryMs: 5 })).toEqual({ ok: false, code: "view_unreadable", error: "「我的内容」正在同步或读不出，稍后再点" });
    await fs.mkdir(path.join(view, "2 待录制/1012 访达样例"), { recursive: true });
    await fs.writeFile(path.join(view, ".autocrew-view.json"), "{半截");
    setTimeout(() => void manifest({ "2 待录制/1012 访达样例": c.id }), 10);
    expect(await revealMyContent(c.id, env.dir, { ...mac(), retryMs: 80 })).toMatchObject({ ok: true });
  });
});

describe("/api/my-content-reveal 只给浏览器会话", () => {
  let server: http.Server, base: string;
  beforeEach(async () => {
    const route = createProjectReviewHandler({
      authorize: (req) => (req.headers.cookie === "s" ? "session" : req.headers.authorization ? "bearer" : null),
      originAllowed: (req) => req.headers.origin === base,
      resolveDataDir: async () => env.dir,
      readBody: async (req) => { let b = ""; for await (const ch of req) b += ch; return b; },
      reveal: { platform: "linux" }, myContent: { viewRoot: view },
    });
    server = http.createServer((req, res) => { void route(req, res, new URL(req.url!, base)).then((h) => { if (!h) res.writeHead(404).end(); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("bearer / 无会话 / 外站 Origin 一律 403；会话 + 本站 Origin 才回结果", async () => {
    const url = `${base}/api/my-content-reveal`, body = JSON.stringify({ content_id: c.id });
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer x", origin: base }, body })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { cookie: "s", origin: "https://evil.example" }, body })).status).toBe(403);
    const ok = await fetch(url, { method: "POST", headers: { cookie: "s", origin: base }, body });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: false, code: "not_in_view" });
  });
});

describe("读模型的交接详情（补做 B）", () => {
  type R = { active: boolean; card: { claim: unknown }; desk: { handoff: unknown } };
  it("6：没交接 = null；有交接给代次 / 时间 / 会话 / 8 位指纹 / 原片文件名；撤回过的算没有；认领带租约", async () => {
    await founderApprove(env, c.id);
    expect(((await publishDesk(c.id, env.dir)) as R).desk.handoff).toBeNull();
    const handoff = { generation: 2, hash: "abcdef0123456789", at: "2026-10-11T02:00:00Z", session: "sess-1", aroll_path: "/x/y/原片.mov" };
    const past = new Date(Date.now() - 3 * 3600_000).toISOString();
    await setContent(env, c.id, { video: { handoff } as unknown as Content["video"],
      claim: { host: "codex", employee: "editor", token: "t", at: past, leaseUntil: past, lastWriteAt: past } as unknown as Content["claim"] });
    const r = (await publishDesk(c.id, env.dir)) as R;
    expect(r.desk.handoff).toEqual({ generation: 2, at: "2026-10-11T02:00:00Z", session: "sess-1", fingerprint: "abcdef01", aroll: "原片.mov" });
    expect(r.card.claim).toMatchObject({ host: expect.any(String), lease_ok: false, idle_hours: 3 });
    await setContent(env, c.id, { video: { handoff, revoked: [handoff.hash] } as unknown as Content["video"] });
    expect(((await publishDesk(c.id, env.dir)) as R).desk.handoff).toBeNull();
  });
});
