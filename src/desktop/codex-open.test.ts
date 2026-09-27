import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { contentFile, initializeProjectLayout } from "../storage/content-project.js";
import { saveContent, type Content } from "../storage/local-store.js";
import { openCodexForContent } from "./codex-open.js";

const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
let dir: string, content: Content, exitCode: number;
const spawnImpl = vi.fn(() => { const c = new EventEmitter(); setImmediate(() => c.emit("exit", exitCode)); return c; }) as unknown as typeof spawn;
const mac = { platform: "darwin" as const, spawnImpl };
const writeSession = (session_id: string) => fs.writeFile(contentFile(content.id, dir, "execution.json"), JSON.stringify({ schema: 2, generation: 1, session_id, machine: "m", host: "codex",
  transport_session: null, heartbeat: { result: "r", next_action: "n", reported_at: "2026-09-27T08:00:00Z", session_id }, artifacts: [] }));

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-codex-open-")));
  await initializeProjectLayout(dir, "lib-deadbeef", "default");
  content = await saveContent({ title: "发布样例", body: "正文", status: "drafting", platform: "douyin", tags: [] }, dir);
  exitCode = 0;
  vi.mocked(spawnImpl).mockClear();
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it("打开本条稿执行记录里的那条 Codex 对话", async () => {
  await writeSession(THREAD.toUpperCase());
  expect(await openCodexForContent(content.id, dir, mac)).toEqual({ ok: true, link: `codex://threads/${THREAD}`, thread: true, opened: true });
  expect(vi.mocked(spawnImpl).mock.calls[0].slice(0, 2)).toEqual(["open", [`codex://threads/${THREAD}`]]);
});

it("会话 id 不是 UUID 或没有执行记录 → 新开对话，不把原串拼进链接", async () => {
  await writeSession("abc?x=1&codex://evil");
  expect(await openCodexForContent(content.id, dir, mac)).toMatchObject({ ok: true, link: "codex://threads/new", thread: false });
  await fs.rm(contentFile(content.id, dir, "execution.json"));
  expect(await openCodexForContent(content.id, dir, mac)).toMatchObject({ ok: true, link: "codex://threads/new" });
});

it("坏 id、找不到稿都拒，且不开窗；非 darwin 只回链接", async () => {
  expect(await openCodexForContent("../x", dir, mac)).toMatchObject({ ok: false, code: "bad_request" });
  expect(await openCodexForContent("content-1-nope", dir, mac)).toMatchObject({ ok: false, code: "not_found" });
  await writeSession(THREAD);
  expect(await openCodexForContent(content.id, dir, { platform: "linux", spawnImpl })).toEqual({ ok: true, link: `codex://threads/${THREAD}`, thread: true, opened: false });
  expect(spawnImpl).not.toHaveBeenCalled();
});

it("open 失败 → 明说原因并带链接", async () => {
  exitCode = 1;
  expect(await openCodexForContent(content.id, dir, mac)).toMatchObject({ ok: false, code: "open_failed", link: "codex://threads/new" });
});
