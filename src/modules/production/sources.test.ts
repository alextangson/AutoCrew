/**
 * 「原片放哪里」设置（手动收件 spec 2026-10-06 规则 6）：监视文件夹与「暂停自动找原片」已删；
 * 带着旧键的设置文件照常读得进来（忽略旧键）；剪映导出目录仍只收浏览器会话。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoardHandler } from "../../desktop/board-route.js";
import { getVideoSettings, getVideoSettingsRaw, setVideoSettings, setVideoSettingsViaInvoke } from "../../desktop/settings-video.js";
import { getConfigDir } from "../../storage/storage-roots.js";
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

/** 停用前的设置文件：带监视文件夹（含 allow_move）和暂停开关 */
async function writeOldSettings(): Promise<string> {
  const file = path.join(getConfigDir(env.dir), "video.json");
  const st = await fs.stat(watch);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ renderConcurrency: 2, arollAutoFindPaused: true, otherModuleKey: "keep",
    arollWatchFolders: [{ path: await fs.realpath(watch), scan: true, allow_move: true, dev: st.dev, ino: st.ino }] }));
  return file;
}

describe("旧设置里的监视文件夹（规则 6）", () => {
  it("带旧键的 video.json 照常读得进来，旧键被忽略；下次写盘时丢掉，别的模块的键留着", async () => {
    const file = await writeOldSettings();
    const raw = await getVideoSettingsRaw(env.dir);
    expect(raw).toEqual({ renderConcurrency: 2 });
    expect(await getVideoSettings({ _dataDir: env.dir })).toMatchObject({ ok: true, data: { renderConcurrency: 2, jianyingExportDir: null } });
    expect(await setVideoSettings({ _dataDir: env.dir, render_concurrency: 3 })).toMatchObject({ ok: true });
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ renderConcurrency: 3, otherModuleKey: "keep" });
    expect(saved).not.toHaveProperty("arollWatchFolders");
    expect(saved).not.toHaveProperty("arollAutoFindPaused");
  });

  it("旧设置里开过 allow_move 的文件夹不再是可搬入根：agent 报那里的原片只记候选，文件不动", async () => {
    await writeOldSettings();
    const TITLE = "监视文件夹里录好的一条稿";
    const c = await videoContent(env, TITLE);
    const a = await put(path.join(watch, `${TITLE}-原片.mov`), "take-a");
    expect(await record(env, { content_id: c.id, kind: "aroll", path: a, request_id: "r1" })).toMatchObject({ ok: true, state: "candidate" });
    expect(await exists(a)).toBe(true);
  });

  it("设置页只给收件箱路径；加 / 改 / 删监视文件夹、暂停一律回「已停用」", async () => {
    const view = await call("/api/board/aroll-sources", {}, "session", "GET");
    expect(view.json).toEqual({ ok: true, inbox: env.inbox });
    for (const op of ["add_folder", "remove_folder", "set_folder", "set_paused"]) {
      expect((await call("/api/board/aroll-sources", { op, path: watch, paused: true })).json).toMatchObject({ ok: false, code: "retired" });
    }
    expect(await getVideoSettingsRaw(env.dir)).toEqual({});
  });
});

describe("剪映导出目录只收同源浏览器会话（B32）", () => {
  it("浏览器会话能设；bearer 403；/api/invoke 改它一律拒", async () => {
    expect((await call("/api/board/aroll-sources", { op: "set_jianying", path: watch }, "bearer")).status).toBe(403);
    for (const key of ["jianying_export_dir", "jianyingExportDir"]) {
      expect(await setVideoSettingsViaInvoke({ _dataDir: env.dir, [key]: watch })).toMatchObject({ ok: false, code: "browser_session_only" });
    }
    expect((await call("/api/board/aroll-sources", { op: "set_jianying", path: watch })).json).toMatchObject({ ok: true });
    expect((await getVideoSettingsRaw(env.dir)).jianyingExportDir).toBe(watch);
  });
});

describe("在访达中显示只认收件箱", () => {
  it("收件箱目录、收件箱顶层文件可以；别的路径拒；bearer 403", async () => {
    const { revealSourcePath } = await import("./sources-view.js");
    const deps = { platform: "linux" };
    const f = await put(path.join(env.inbox, "IMG_1.mov"), "x");
    expect(await revealSourcePath(f, env.dir, deps)).toMatchObject({ ok: true });
    expect(await revealSourcePath(env.inbox, env.dir, deps)).toMatchObject({ ok: true });
    expect(await revealSourcePath(await put(path.join(env.outside, "y.mov"), "y"), env.dir, deps)).toMatchObject({ ok: false, code: "not_allowed" });
    expect(await revealSourcePath(watch, env.dir, deps)).toMatchObject({ ok: false, code: "not_allowed" });
    expect((await call("/api/board/reveal-source", { path: f }, "bearer")).status).toBe(403);
  });
});
