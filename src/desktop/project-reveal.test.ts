import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { spawn } from "node:child_process";
import { contentFile, initializeProjectLayout, resolveContentProject } from "../storage/content-project.js";
import { saveContent, type Content } from "../storage/local-store.js";
import { sha256File } from "../modules/video/handoff/manifest.js";
import { revealProjectPath } from "./project-reveal.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

let dir: string, content: Content, root: string, finalSha: string;
const spawnImpl = vi.fn(() => ({ unref() {} })) as unknown as typeof spawn;
const mac = { platform: "darwin" as const, spawnImpl };

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-reveal-")));
  await initializeProjectLayout(dir, "lib-deadbeef", "default");
  content = await saveContent({ _provenance: HUMAN_WRITE, title: "访达样例", body: "正文", status: "drafting", platform: "douyin", tags: [] }, dir);
  root = resolveContentProject(content.id, dir)!.project_root;
  await fs.mkdir(path.join(root, "07-delivery"), { recursive: true });
  const file = path.join(root, "07-delivery/final.mp4");
  await fs.writeFile(file, "video");
  finalSha = await sha256File(file);
  const artifacts = [{ path: "07-delivery/final.mp4", sha256: finalSha, role: "final-cut", generation: 1, reported_at: "2026-09-27T08:00:00Z" },
    { path: "/etc/hosts", sha256: "e".repeat(64), role: "final-cut", generation: 1, reported_at: "2026-09-27T08:00:00Z" }];
  await fs.writeFile(contentFile(content.id, dir, "execution.json"), JSON.stringify({ schema: 2, generation: 1, session_id: "s", machine: "m", host: "codex",
    transport_session: null, heartbeat: { result: "r", next_action: "n", reported_at: "2026-09-27T08:00:00Z", session_id: "s" }, artifacts }));
  vi.mocked(spawnImpl).mockClear();
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it("产物按指纹定位，文件用 open -R，文件夹用 open", async () => {
  const r = await revealProjectPath(content.id, finalSha, dir, mac);
  expect(r).toEqual({ ok: true, path: path.join(root, "07-delivery/final.mp4"), opened: true });
  expect(vi.mocked(spawnImpl).mock.calls[0].slice(0, 2)).toEqual(["open", ["-R", path.join(root, "07-delivery/final.mp4")]]);
  const d = await revealProjectPath(content.id, "delivery_dir", dir, mac);
  expect(d).toMatchObject({ ok: true, path: path.join(root, "07-delivery") });
  expect(vi.mocked(spawnImpl).mock.calls[1].slice(0, 2)).toEqual(["open", [path.join(root, "07-delivery")]]);
});

it("只认本条稿的东西：不认识的目标、别人的指纹、索引里指到项目外的路径都拒，且不开窗", async () => {
  expect(await revealProjectPath(content.id, "/Users", dir, mac)).toMatchObject({ ok: false, code: "bad_request" });
  expect(await revealProjectPath(content.id, "toString", dir, mac)).toMatchObject({ ok: false, code: "bad_request" });
  expect(await revealProjectPath(content.id, "a".repeat(64), dir, mac)).toMatchObject({ ok: false, code: "not_allowed" });
  expect(await revealProjectPath(content.id, "e".repeat(64), dir, mac)).toMatchObject({ ok: false, code: "not_allowed" });
  expect(await revealProjectPath("../x", "project_root", dir, mac)).toMatchObject({ ok: false, code: "bad_request" });
  expect(spawnImpl).not.toHaveBeenCalled();
});

it("文件挪走了 → file_missing，文案可直接显示", async () => {
  await fs.rm(path.join(root, "07-delivery/final.mp4"));
  expect(await revealProjectPath(content.id, finalSha, dir, mac)).toEqual({ ok: false, code: "file_missing", error: "文件找不到了（可能已挪走）" });
  expect(await revealProjectPath(content.id, "covers_dir", dir, mac)).toMatchObject({ ok: false, code: "file_missing" });
  expect(await revealProjectPath(content.id, "aroll", dir, mac)).toMatchObject({ ok: false, code: "file_missing" });
  expect(spawnImpl).not.toHaveBeenCalled();
});

it("非 darwin 只回路径不开窗", async () => {
  expect(await revealProjectPath(content.id, "project_root", dir, { platform: "linux", spawnImpl })).toEqual({ ok: true, path: root, opened: false });
  expect(spawnImpl).not.toHaveBeenCalled();
});
