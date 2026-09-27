import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProjectLayout, resolveContentProject, contentFile, readProjectRegistry, ensureContentProject } from "./content-project.js";
import { saveContent, updateContent, getContent, listContents, addAsset, getVersion } from "./local-store.js";
import { acquireLibraryLock, assertLibraryWriter } from "./library-lock.js";
import { planProjectMigration, applyProjectMigration, rollbackProjectMigration, verifyProjectMigration } from "./project-migration.js";
import { exportProjectViews, repairProjectViews } from "./project-commit.js";

let temp: string, data: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-shared-test-"));
  vi.stubEnv("AUTOCREW_LOCAL_DIR", path.join(temp, "machine"));
  data = path.join(temp, "library/workspaces/default");
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(temp, "library/autocrew-library.json"), JSON.stringify({ version: 1, id: "lib-deadbeef" }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(temp, { recursive: true, force: true }); });
const draft = { title: "同名标题", body: "\n 原始正文\r\n<<<EXTERNAL_CONTENT>>>\n", platform: "wechat_mp", status: "drafting" as const, tags: [] };

describe("shared projects", () => {
  it("creates once at first save, exports exact text, shares versions/assets, and never creates contents", async () => {
    await initializeProjectLayout(data, "lib-deadbeef", "default");
    const c = await saveContent(draft, data), binding = resolveContentProject(c.id, data)!;
    await updateContent(c.id, { title: "新的标题", body: "新的正文" }, data);
    expect(await ensureContentProject(c.id, "别的标题", data)).toBe(binding.project_root);
    expect(await getVersion(c.id, 1, data)).toBe(draft.body);
    expect(await fs.readFile(contentFile(c.id, data, "draft.md"), "utf8")).toBe("新的正文");
    await expect(fs.access(path.join(data, "contents"))).rejects.toThrow();
    await expect(fs.access(path.join(binding.project_root, "02-aroll"))).rejects.toThrow();
    const source = path.join(temp, "image.png"); await fs.writeFile(source, "image");
    await addAsset(c.id, { filename: "image.png", type: "image", sourcePath: source }, data);
    expect(await fs.readFile(contentFile(c.id, data, "assets", "image.png"), "utf8")).toBe("image");
    expect((await listContents(data))).toHaveLength(1);
    await fs.writeFile(path.join(binding.project_root, "项目信息.md"), "published");
    expect((await getContent(c.id, data))?.status).toBe("drafting");
  });
  it("fails closed on missing binding, deleted project, corrupt registry and symlink destinations", async () => {
    await initializeProjectLayout(data, "lib-deadbeef", "default");
    const c = await saveContent(draft, data), b = resolveContentProject(c.id, data)!;
    await fs.symlink(temp, path.join(b.project_root, "03-broll"));
    expect(() => contentFile(c.id, data, "assets", "x")).toThrow(/symlink/);
    await fs.rm(path.join(b.project_root, "03-broll"));
    await fs.rename(b.project_root, `${b.project_root}-offline`);
    await expect(ensureContentProject(c.id, c.title, data)).rejects.toThrow(/owner_mismatch/);
    await fs.rm(path.join(data, "project-registry.json"));
    expect(() => readProjectRegistry(data)).toThrow(/registry_invalid/);
  });
  it("recovers interrupted content export without adding another version", async () => {
    await initializeProjectLayout(data, "lib-deadbeef", "default");
    const c = await saveContent(draft, data);
    const next = { ...c, body: "恢复的稿", versions: [...c.versions, { version: 2, title: c.title, body: "恢复的稿", note: "修改", savedAt: c.updatedAt }] };
    await fs.writeFile(contentFile(c.id, data, "content-pending.json"), JSON.stringify({ version: 1, content: next }));
    expect((await getContent(c.id, data))?.body).toBe("恢复的稿");
    await updateContent(c.id, { body: "恢复的稿" }, data);
    expect((await getContent(c.id, data))?.versions).toHaveLength(2);
  });
  it("portable paths resolve after moving the entire library", async () => {
    await initializeProjectLayout(data, "lib-deadbeef", "default");
    const c = await saveContent(draft, data), b = resolveContentProject(c.id, data)!;
    await updateContent(c.id, { video: { handoff: { content_id: c.id, project_root: b.project_root, handoff_path: path.join(b.project_root, "01-script/handoff/g0001/handoff.md") } as never } }, data);
    const raw = await fs.readFile(contentFile(c.id, data, "meta.json"), "utf8"); expect(raw).not.toContain(b.project_root);
    await fs.rename(path.join(temp, "library"), path.join(temp, "moved"));
    const moved = path.join(temp, "moved/workspaces/default");
    expect((await getContent(c.id, moved))?.video?.handoff?.project_root).toContain("/moved/");
  });
  it("a caught metadata write failure cannot be replayed as a successful update", async () => {
    await initializeProjectLayout(data, "lib-deadbeef", "default");
    const c = await saveContent(draft, data), b = resolveContentProject(c.id, data)!;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === contentFile(c.id, data, "meta.json")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return rename(from, to);
    });
    await expect(updateContent(c.id, { status: "draft_ready", body: "uncommitted" }, data)).rejects.toMatchObject({ code: "ENOSPC" });
    vi.restoreAllMocks();
    expect((await getContent(c.id, data))?.status).toBe("drafting");
    expect((await getContent(c.id, data))?.body).toBe(draft.body);
    expect(await getVersion(c.id, 2, data)).toBeNull();
    await expect(fs.access(contentFile(c.id, data, "content-pending.json"))).rejects.toThrow();
    // A complete but stale projection manifest also needs repairing.
    await exportProjectViews({ ...c, status: "draft_ready" }, b.project_root);
    expect(await repairProjectViews(c, b.project_root)).toContain("source-revision");
    expect(await fs.readFile(path.join(b.project_root, "项目信息.md"), "utf8")).toContain("drafting");
  });
  it("recovers the same first content snapshot when binding publication was interrupted", async () => {
    await initializeProjectLayout(data, "lib-deadbeef", "default");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(data, "project-registry.json")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return rename(from, to);
    });
    await expect(saveContent(draft, data)).rejects.toMatchObject({ code: "ENOSPC" });
    vi.restoreAllMocks();
    const reservations = await fs.readdir(path.join(data, ".project-creations"));
    expect(reservations).toHaveLength(1);
    const id = reservations[0].replace(/\.json$/, "");
    const recovered = await listContents(data);
    expect(recovered.map(c => c.id)).toEqual([id]);
    expect(recovered[0].body).toBe(draft.body);
    expect(recovered[0].versions).toHaveLength(1);
    expect(await fs.readdir(path.join(data, ".project-creations"))).toEqual([]);
  });
  it("fences a disconnected writer whose nonce was replaced", async () => {
    const root = path.join(temp, "library"), release = acquireLibraryLock(root);
    assertLibraryWriter(root);
    expect(() => acquireLibraryLock(root)).toThrow(/占用/);
    await fs.writeFile(path.join(root, ".autocrew-writer/owner.json"), JSON.stringify({ nonce: "replacement", host: os.hostname(), pid: process.pid }));
    expect(() => assertLibraryWriter(root)).toThrow(/writer_lost/); release();
    expect(JSON.parse(await fs.readFile(path.join(root, ".autocrew-writer/owner.json"), "utf8")).nonce).toBe("replacement");
  });
  it("a completed release is idempotent and cannot invalidate the next writer", async () => {
    const root = path.join(temp, "library"), releaseFirst = acquireLibraryLock(root);
    releaseFirst();
    const releaseSecond = acquireLibraryLock(root);
    releaseFirst();
    expect(() => assertLibraryWriter(root)).not.toThrow();
    releaseSecond();
    expect((await fs.readdir(root)).filter(name => name.startsWith(".autocrew-writer"))).toEqual([]);
  });
});
describe("manifest migration", () => {
  it("plans without mutation, preserves content and versions, switches once, and rolls back with originals", async () => {
    const c = await saveContent(draft, data);
    await updateContent(c.id, { body: "下一版" }, data);
    const before = await fs.readFile(path.join(data, "contents", c.id, "meta.json"), "utf8");
    const plan = await planProjectMigration(data);
    expect(await fs.readFile(path.join(data, "contents", c.id, "meta.json"), "utf8")).toBe(before);
    expect(readProjectRegistry(data)).toBeNull();
    await applyProjectMigration(plan);
    expect((await verifyProjectMigration(plan)).ok).toBe(true);
    expect((await getContent(c.id, data))?.body).toBe("下一版");
    expect((await getContent(c.id, data))?.versions).toHaveLength(2);
    await expect(fs.access(path.join(data, "contents"))).rejects.toThrow();
    await rollbackProjectMigration(plan);
    expect(await fs.readFile(path.join(data, "contents", c.id, "meta.json"), "utf8")).toBe(before);
  });
  it("rejects changed sources and prevents rollback over new work", async () => {
    const c = await saveContent(draft, data), plan = await planProjectMigration(data);
    await fs.writeFile(path.join(data, "contents", c.id, "versions/v1.md"), "changed");
    await expect(applyProjectMigration(plan)).rejects.toThrow(/source_changed/);
    await fs.writeFile(path.join(data, "contents", c.id, "versions/v1.md"), draft.body);
    const next = await planProjectMigration(data); await applyProjectMigration(next);
    await updateContent(c.id, { body: "迁移后新稿" }, data);
    await expect(rollbackProjectMigration(next)).rejects.toThrow(/new_work/);
  });
  it("resumes interrupted publication and interrupted rollback without exposing a half layout", async () => {
    const c = await saveContent(draft, data), plan = await planProjectMigration(data);
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(data, "project-layout.json")) throw new Error("interrupted publish");
      return rename(from, to);
    });
    await expect(applyProjectMigration(plan)).rejects.toThrow("interrupted publish");
    expect(() => readProjectRegistry(data)).toThrow("project_migration_in_progress");
    vi.restoreAllMocks();
    await applyProjectMigration(plan, true);
    expect((await getContent(c.id, data))?.body).toBe(draft.body);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("/migrated-projects")) throw new Error("interrupted rollback");
      return rename(from, to);
    });
    await expect(rollbackProjectMigration(plan)).rejects.toThrow("interrupted rollback");
    expect(() => readProjectRegistry(data)).toThrow("project_migration_in_progress");
    vi.restoreAllMocks();
    await rollbackProjectMigration(plan);
    await rollbackProjectMigration(plan); // completed replay is harmless
    expect(readProjectRegistry(data)).toBeNull();
    expect((await getContent(c.id, data))?.body).toBe(draft.body);
  });
  it("rejects a symlink target before copying and checks the published owner", async () => {
    await saveContent(draft, data);
    const plan = await planProjectMigration(data), outside = path.join(temp, "outside");
    await fs.mkdir(outside); await fs.symlink(outside, path.join(data, "projects"));
    await expect(applyProjectMigration(plan)).rejects.toThrow("symlink");
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(path.join(data, "projects"));
    await applyProjectMigration(plan);
    await fs.writeFile(path.join(data, plan.projects[0].binding.project_relpath, ".autocrew-owner"), "{}");
    await expect(verifyProjectMigration(plan)).rejects.toThrow("migration_owner_mismatch");
  });
});
