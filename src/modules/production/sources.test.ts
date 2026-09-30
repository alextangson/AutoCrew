/** 原片从哪里找（1b §5，B23 / B32 / B33）：监视文件夹的路径约束、只收浏览器会话、allow_move 才是可搬入根 */
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoardHandler } from "../../desktop/board-route.js";
import { getVideoSettingsRaw, setVideoSettingsViaInvoke } from "../../desktop/settings-video.js";
import { folderProblem, readArollSources, validateWatchFolder } from "./sources.js";
import { exists, makeEnv, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
let watch: string;
beforeEach(async () => { env = await makeEnv({ enabled: true }); watch = path.join(path.dirname(env.dir), "downloads"); await fs.mkdir(watch); });
afterEach(async () => { await env.cleanup(); });

async function call(p: string, body: unknown, auth: "session" | "bearer" = "session", method = "POST") {
  const handler = createBoardHandler({ authorize: () => auth, originAllowed: () => true, resolveDataDir: async () => env.dir, readBody: async () => JSON.stringify(body) });
  let status = 0, text = "";
  const res = { writeHead: (s: number) => { status = s; return res; }, end: (t?: string) => { text = t ?? ""; } } as unknown as http.ServerResponse;
  await handler({ method } as http.IncomingMessage, res, new URL(`http://x${p}`));
  return { status, json: text ? JSON.parse(text) : null };
}

describe("监视文件夹的路径（§14-8）", () => {
  it("存 realpath 与目录身份；不存在、是链接、不是目录、与资料库相交都拒", async () => {
    const ok = await validateWatchFolder(watch, env.dir);
    expect(ok).toMatchObject({ ok: true, folder: { path: await fs.realpath(watch) } });
    expect(await validateWatchFolder(path.join(watch, "nope"), null)).toMatchObject({ ok: false });
    await fs.symlink(watch, path.join(env.outside, "link"));
    expect(await validateWatchFolder(path.join(env.outside, "link"), null)).toMatchObject({ ok: false, error: expect.stringContaining("符号链接") });
    expect(await validateWatchFolder(await put(path.join(watch, "f.txt"), "x"), null)).toMatchObject({ ok: false, error: expect.stringContaining("不是文件夹") });
    expect(await validateWatchFolder(path.join(env.dir, "projects"), env.dir)).toMatchObject({ ok: false, error: expect.stringContaining("资料库") });
    expect(await validateWatchFolder(path.dirname(env.dir), env.dir)).toMatchObject({ ok: false, error: expect.stringContaining("资料库") });
  });

  it("使用时复核身份：文件夹被换掉 → 停用并说原因", async () => {
    const v = await validateWatchFolder(watch, null);
    if (!v.ok) throw new Error(v.error);
    const f = { ...v.folder, scan: true, allow_move: true };
    expect(await folderProblem(f)).toBeNull();
    await fs.rm(watch, { recursive: true });
    await fs.mkdir(watch);
    expect(await folderProblem(f)).toContain("被换过");
  });
});

describe("只收同源浏览器会话（B32）", () => {
  it("浏览器会话能加 / 改 / 删 / 暂停；bearer 403；/api/invoke 改这些键一律拒", async () => {
    expect((await call("/api/board/aroll-sources", { op: "add_folder", path: watch }, "bearer")).status).toBe(403);
    expect((await call("/api/board/aroll-sources", { op: "add_folder", path: watch, allow_move: true })).json).toMatchObject({ ok: true });
    expect((await call("/api/board/aroll-sources", { op: "set_paused", paused: true })).json).toMatchObject({ ok: true });
    const src = await readArollSources(env.dir);
    expect(src).toMatchObject({ paused: true, folders: [{ path: await fs.realpath(watch), scan: true, allow_move: true }] });
    for (const key of ["jianying_export_dir", "aroll_watch_folders", "arollWatchFolders", "aroll_auto_find_paused"]) {
      expect(await setVideoSettingsViaInvoke({ _dataDir: env.dir, [key]: watch })).toMatchObject({ ok: false, code: "browser_session_only" });
    }
    expect((await call("/api/board/aroll-sources", { op: "set_jianying", path: watch })).json).toMatchObject({ ok: true });
    expect((await getVideoSettingsRaw(env.dir)).jianyingExportDir).toBe(watch);
    expect((await call("/api/board/aroll-sources", { op: "remove_folder", path: await fs.realpath(watch) })).json).toMatchObject({ ok: true });
    expect((await readArollSources(env.dir)).folders).toEqual([]);
    const view = await call("/api/board/aroll-sources", {}, "session", "GET");
    expect(view.json).toMatchObject({ ok: true, paused: true, asr: { ready: false } });
  });
});

describe("allow_move 才让 agent record 直接搬入（§5）", () => {
  const TITLE = "监视文件夹里录好的一条稿";
  it("开了 allow_move：名字对上 → 搬进项目；只开扫描：只记候选；子目录里的不算", async () => {
    const c = await videoContent(env, TITLE);
    await call("/api/board/aroll-sources", { op: "add_folder", path: watch, allow_move: false });
    const a = await put(path.join(watch, `${TITLE}-原片.mov`), "take-a");
    expect(await record(env, { content_id: c.id, kind: "aroll", path: a, request_id: "r1" })).toMatchObject({ ok: true, state: "candidate" });
    await call("/api/board/aroll-sources", { op: "set_folder", path: await fs.realpath(watch), allow_move: true });
    const b = await put(path.join(watch, `${TITLE}-2.mov`), "take-b");
    expect(await record(env, { content_id: c.id, kind: "aroll", path: b, request_id: "r2" })).toMatchObject({ ok: true, state: "accepted" });
    expect(await exists(b)).toBe(false);
    const deep = await put(path.join(watch, "sub", `${TITLE}-3.mov`), "take-c");
    expect(await record(env, { content_id: c.id, kind: "aroll", path: deep, request_id: "r3" })).toMatchObject({ ok: true, state: "candidate" });
  });
});
