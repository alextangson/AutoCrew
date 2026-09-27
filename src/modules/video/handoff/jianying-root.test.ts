import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callVideo, makeFixture, handedOff, writePng } from "./handoff-testkit.js";
import { contentFile, initializeProjectLayout } from "../../../storage/content-project.js";
import { getVideoSettings, setVideoSettings } from "../../../desktop/settings-video.js";
import { loadProjectRoots } from "./roots.js";
import { sha256File } from "./manifest.js";

let env: Awaited<ReturnType<typeof makeFixture>>;
let exportDir: string;
beforeEach(async () => {
  env = await makeFixture();
  await fs.unlink(path.join(env.dir, "video.json"));
  await initializeProjectLayout(env.dir, "lib-deadbeef", "default");
  exportDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-jianying-export-")));
});
afterEach(async () => { await env.cleanup(); await fs.rm(exportDir, { recursive: true, force: true }); });

async function reportAbs(v: Awaited<ReturnType<typeof handedOff>>, file: string, role: string) {
  return callVideo(env.dir, { action: "report", content_id: v.id, claim_token: v.token, _session: "editor-session",
    report: { request_id: `abs-${Math.random().toString(36).slice(2, 8)}`, generation: 1, binding_revision: 1, session_id: "editor-session", result: "导出", next_action: "等创始人",
      files: [{ path: file, sha256: await sha256File(file), role }], jianying_draft: "纠正AI-0927" } }, "codex");
}

it("没设剪映导出目录：项目外的成片候选被拒，并说清去哪里设", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const exported = await writePng(path.join(exportDir, "成片.png"), "cut");
  const r = await reportAbs(v, exported, "final-cut-candidate");
  expect(r).toMatchObject({ ok: false, code: "jianying_dir_unset" });
  expect(String(r.error)).toMatch(/设置 → 模型 → 剪映导出目录/);
});

it("设了之后：候选以绝对路径入索引并绑定项目与代次；别的角色、别的目录、符号链接段都拒", async () => {
  const v = await handedOff(env.dir, env.aroll);
  expect((await setVideoSettings({ _dataDir: env.dir, jianying_export_dir: exportDir })).ok).toBe(true);
  const exported = await writePng(path.join(exportDir, "sub/成片.png"), "cut");
  expect((await reportAbs(v, exported, "final-cut-candidate")).ok).toBe(true);
  const exec = JSON.parse(await fs.readFile(contentFile(v.id, env.dir, "execution.json"), "utf8"));
  expect(exec.artifacts[0]).toMatchObject({ role: "final-cut-candidate", path: exported, external: "jianying", generation: 1, size: expect.any(Number), mtime_ms: expect.any(Number) });
  expect(exec.artifacts[0].project_id).toMatch(/.+/);
  expect(exec.jianying_draft).toBe("纠正AI-0927");

  expect(await reportAbs(v, exported, "final-cut")).toMatchObject({ ok: false, code: "path_not_whitelisted" });
  const elsewhere = await writePng(path.join(env.outside, "x.png"), "x");
  expect(await reportAbs(v, elsewhere, "final-cut-candidate")).toMatchObject({ ok: false, code: "path_not_whitelisted" });
  const real = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-jy-link-"));
  await writePng(path.join(real, "y.png"), "y");
  await fs.symlink(real, path.join(exportDir, "linked"));
  expect(await reportAbs(v, path.join(exportDir, "linked/y.png"), "final-cut-candidate")).toMatchObject({ ok: false, code: "path_symlink" });
  await fs.rm(real, { recursive: true, force: true });
});

it("设置只写自己的键：已有的 project_roots 原样保留；只有剪映目录的 video.json 不挡交接根", async () => {
  expect((await setVideoSettings({ _dataDir: env.dir, jianying_export_dir: exportDir })).ok).toBe(true);
  expect((await loadProjectRoots(env.dir)).roots).toEqual([await fs.realpath(path.join(env.dir, "projects"))]);
  await fs.writeFile(path.join(env.dir, "video.json"), JSON.stringify({ project_roots: [path.join(env.dir, "projects")] }));
  expect((await setVideoSettings({ _dataDir: env.dir, jianying_export_dir: exportDir })).ok).toBe(true);
  const saved = JSON.parse(await fs.readFile(path.join(env.dir, "video.json"), "utf8"));
  expect(saved).toMatchObject({ project_roots: [path.join(env.dir, "projects")], jianyingExportDir: exportDir });
  expect((await getVideoSettings({ _dataDir: env.dir })).data).toMatchObject({ jianyingExportDir: exportDir });
  expect((await setVideoSettings({ _dataDir: env.dir, jianying_export_dir: "relative/dir" })).ok).toBe(false);
  expect((await setVideoSettings({ _dataDir: env.dir, jianying_export_dir: path.join(exportDir, "nope") })).ok).toBe(false);
  expect((await setVideoSettings({ _dataDir: env.dir, jianying_export_dir: null })).ok).toBe(true);
  expect(JSON.parse(await fs.readFile(path.join(env.dir, "video.json"), "utf8"))).not.toHaveProperty("jianyingExportDir");
});
