/** `autocrew_asset add{source_path}`：素材只写路径（P6 §13.4-F，评审 #9）。 */
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeAsset } from "./asset.js";
import { initializeProjectLayout, resolveContentProject } from "../storage/content-project.js";
import { getContent, saveContent } from "../storage/local-store.js";
import { hostPolicy } from "../../mcp/host-policy.js";

let dir: string, outside: string, id: string, root: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-asset-path-")));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-asset-outside-")));
  await initializeProjectLayout(dir, "lib-deadbeef", "default");
  id = (await saveContent({ title: "素材登记", body: "正文", status: "draft_ready", platform: "douyin", tags: [] }, dir)).id;
  root = resolveContentProject(id, dir)!.project_root;
});
afterEach(async () => { for (const d of [dir, outside]) await fs.rm(d, { recursive: true, force: true }); });

const add = (filename: string, source: string) => executeAsset({ _dataDir: dir, action: "add", content_id: id, filename, asset_type: "broll", source_path: source });
async function put(file: string, text: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file; }

it("项目里的文件只记项目内相对路径，原地不动", async () => {
  const file = await put(path.join(root, "02-aroll/口播.mov"), "aroll");
  const r = await add("口播.mov", file);
  expect(r.ok).toBe(true);
  expect(r.asset).toMatchObject({ filename: "口播.mov", projectPath: "02-aroll/口播.mov" });
  expect(await fs.readFile(file, "utf8")).toBe("aroll");
});

it("资料库里别处的文件只记相对资料库的路径，不挪不拷", async () => {
  const file = await put(path.join(dir, "shared-assets/片头.mp4"), "intro");
  const r = await add("片头.mp4", file);
  expect(r.asset).toMatchObject({ libraryPath: "shared-assets/片头.mp4" });
  expect(await fs.readFile(file, "utf8")).toBe("intro");
});

it("库外文件挪进项目（不复制）再记；同名不覆盖、原件不动", async () => {
  const file = await put(path.join(outside, "空镜.mp4"), "broll bytes");
  const r = await add("空镜.mp4", file);
  expect(r.ok).toBe(true);
  expect(r.asset).not.toHaveProperty("projectPath");
  await expect(fs.access(file)).rejects.toThrow();
  expect(await fs.readFile(path.join(root, "03-broll/assets/空镜.mp4"), "utf8")).toBe("broll bytes");
  expect((await getContent(id, dir))?.assets.map(a => a.filename)).toEqual(["空镜.mp4"]);

  const again = await put(path.join(outside, "空镜.mp4"), "another take");
  const dup = await add("空镜.mp4", again);
  expect(dup).toMatchObject({ ok: false });
  expect(String(dup.error)).toMatch(/同名/);
  expect(await fs.readFile(again, "utf8")).toBe("another take");
});

it("符号链接和相对路径不收", async () => {
  const real = await put(path.join(outside, "real.mp4"), "x");
  await fs.symlink(real, path.join(outside, "link.mp4"));
  await expect(add("link.mp4", path.join(outside, "link.mp4"))).rejects.toThrow(/符号链接/);
  await expect(add("rel.mp4", "rel.mp4")).rejects.toThrow(/绝对路径/);
  expect(await fs.readFile(real, "utf8")).toBe("x");
});

it("codex 的素材动作与 claude-code 一样放行（2026-10-02 起不再单独限权）", () => {
  for (const action of ["add", "remove", "revert"]) {
    expect(hostPolicy("codex", "autocrew_asset", { action })).toEqual(hostPolicy("claude-code", "autocrew_asset", { action }));
  }
});
