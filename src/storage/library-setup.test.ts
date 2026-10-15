import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkLibraryTarget, defaultLibraryPath, setupLibrary } from "./library-setup.js";
import { getConfigDir, readLibraryLocation, resolveDataDir, LIBRARY_MARKER } from "./storage-roots.js";
import { releaseProcessLibraryLocks } from "./library-lock.js";

let home: string, machine: string;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-setup-")));
  machine = path.join(home, ".autocrew");
  await fs.mkdir(machine);
  vi.stubEnv("HOME", home);
  vi.stubEnv("AUTOCREW_LOCAL_DIR", machine);
  vi.stubEnv("AUTOCREW_DATA_DIR", "");
});
afterEach(async () => { releaseProcessLibraryLocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });

const put = async (file: string, text = "x") => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };

describe("checkLibraryTarget", () => {
  it("default path is ~/AutoCrew资料库 and ~ expands", async () => {
    expect(defaultLibraryPath(home)).toBe(path.join(home, "AutoCrew资料库"));
    expect(await checkLibraryTarget("~/AutoCrew资料库", { home })).toEqual({ kind: "new", target: path.join(home, "AutoCrew资料库") });
  });
  it("O13: non-empty non-library folder is refused with a subfolder suggestion", async () => {
    await put(path.join(home, "stuff", "a.txt"));
    const r = await checkLibraryTarget(path.join(home, "stuff"), { home });
    expect(r).toMatchObject({ kind: "refused", code: "not_empty", suggestion: path.join(home, "stuff", "AutoCrew资料库") });
  });
  it("O13: empty folder (only .DS_Store) is fine; existing library is recognized", async () => {
    await put(path.join(home, "empty", ".DS_Store"));
    expect((await checkLibraryTarget(path.join(home, "empty"), { home })).kind).toBe("new");
    await put(path.join(home, "lib", LIBRARY_MARKER), "{}");
    expect((await checkLibraryTarget(path.join(home, "lib"), { home })).kind).toBe("library");
  });
  it("O14: Desktop/Documents/Downloads refused on macOS; unmounted volume explained; relative path refused", async () => {
    for (const f of ["Desktop", "Documents", "Downloads"]) {
      expect(await checkLibraryTarget(path.join(home, f, "lib"), { home, platform: "darwin" })).toMatchObject({ kind: "refused", code: "privacy_folder" });
    }
    await fs.mkdir(path.join(home, "Documents"));
    expect((await checkLibraryTarget(path.join(home, "Documents", "lib"), { home, platform: "linux" })).kind).toBe("new");
    expect(await checkLibraryTarget("/Volumes/no-such-nas-xyz/AutoCrew", { home })).toMatchObject({ code: "not_mounted" });
    expect(await checkLibraryTarget("relative/path", { home })).toMatchObject({ code: "not_absolute" });
    expect(await checkLibraryTarget(path.join(home, "missing", "lib"), { home })).toMatchObject({ code: "no_parent" });
  });
});

describe("setupLibrary", () => {
  it("creates the library immediately, carries the key config, and is idempotent (O16)", async () => {
    await put(path.join(machine, "engine.json"), '{"provider":"deepseek"}');
    const target = defaultLibraryPath(home);
    const r = await setupLibrary({ target, home });
    expect(r.status).toBe("created");
    expect(readLibraryLocation()?.root).toBe(target);
    expect(resolveDataDir()).toBe(path.join(target, "workspaces", "default"));
    expect(await fs.readFile(path.join(getConfigDir(), "engine.json"), "utf8")).toContain("deepseek");
    expect(await fs.readFile(path.join(machine, "engine.json"), "utf8")).toContain("deepseek");
    expect(await setupLibrary({ target, home })).toEqual({ status: "already", root: target });
    expect(await setupLibrary({ target: path.join(home, "other"), home })).toMatchObject({ status: "refused", code: "other_library" });
  });

  it("O14: refusal never falls back to ~/.autocrew", async () => {
    const r = await setupLibrary({ target: path.join(home, "Desktop", "lib"), home, platform: "darwin" });
    expect(r.status).toBe("refused");
    expect(readLibraryLocation()).toBeNull();
  });

  it("O15: legacy drafts → asks first; keep leaves them; nothing moved without a choice", async () => {
    await put(path.join(machine, "contents", "c1", "meta.json"), "{}");
    await put(path.join(machine, "contents", "c2", "meta.json"), "{}");
    const target = defaultLibraryPath(home);
    expect(await setupLibrary({ target, home })).toEqual({ status: "needs_legacy_choice", root: target, drafts: 2, files: 2 });
    expect(readLibraryLocation()).toBeNull();
    const kept = await setupLibrary({ target, home, legacy: "keep" });
    expect(kept.status).toBe("created");
    expect(await fs.readFile(path.join(machine, "contents", "c1", "meta.json"), "utf8")).toBe("{}");
  });

  it("O15: migrate backs up first; in the running service it is queued for the next start", async () => {
    await put(path.join(machine, "contents", "c1", "meta.json"), "{}");
    const r = await setupLibrary({ target: defaultLibraryPath(home), home, legacy: "migrate", live: true });
    expect(r.status).toBe("queued_restart");
    const backup = (r as { backup: string }).backup;
    expect(await fs.readFile(path.join(backup, "workspaces", "default", "contents", "c1", "meta.json"), "utf8")).toBe("{}");
    expect(readLibraryLocation()).toBeNull();
  });

  it("opens an existing library folder instead of writing a new one", async () => {
    const target = defaultLibraryPath(home);
    await setupLibrary({ target, home });
    await fs.rm(path.join(machine, "storage.json"));
    const r = await setupLibrary({ target, home });
    expect(r.status).toBe("opened");
    expect(readLibraryLocation()?.root).toBe(target);
  });
});

describe("codex review fixes", () => {
  it("O15: drafts in a non-default workspace or as flat JSON count, and get backed up with the registry", async () => {
    await put(path.join(machine, "contents", "c-flat.json"), "{}");
    await put(path.join(machine, "workspaces.json"), '{"active":"default","workspaces":[]}');
    await put(path.join(machine, "workspaces", "ws-abc", "contents", "c2", "meta.json"), "{}");
    await put(path.join(machine, "engine.json"), '{"k":1}');
    const target = defaultLibraryPath(home);
    expect(await setupLibrary({ target, home })).toMatchObject({ status: "needs_legacy_choice", drafts: 2 });
    const r = await setupLibrary({ target, home, legacy: "migrate", live: true });
    const backup = (r as { backup: string }).backup;
    expect(await fs.readFile(path.join(backup, "workspaces", "default", "contents", "c-flat.json"), "utf8")).toBe("{}");
    expect(await fs.readFile(path.join(backup, "workspaces", "ws-abc", "contents", "c2", "meta.json"), "utf8")).toBe("{}");
    expect(await fs.readFile(path.join(backup, "workspaces.json"), "utf8")).toContain("active");
    await expect(fs.access(path.join(backup, "workspaces", "default", "engine.json"))).rejects.toThrow();
  });

  it("O16: a config-copy failure after activation is finished on retry (configs + writer lock), not reported as already-done-but-broken", async () => {
    await put(path.join(machine, "engine.json"), '{"provider":"deepseek"}');
    await fs.chmod(path.join(machine, "engine.json"), 0o000);
    const target = defaultLibraryPath(home);
    await expect(setupLibrary({ target, home, live: true })).rejects.toThrow();
    await fs.chmod(path.join(machine, "engine.json"), 0o600);
    releaseProcessLibraryLocks();
    expect(await setupLibrary({ target, home, live: true })).toMatchObject({ status: "already" });
    expect(await fs.readFile(path.join(getConfigDir(), "engine.json"), "utf8")).toContain("deepseek");
    const { assertLibraryWriter } = await import("./library-lock.js");
    expect(() => assertLibraryWriter(target)).not.toThrow();
  });

  it("O16: rerun through a symlinked path is still the same library", async () => {
    const real = path.join(home, "real"); await fs.mkdir(real);
    const link = path.join(home, "link"); await fs.symlink(real, link);
    await setupLibrary({ target: path.join(link, "lib"), home });
    expect(await setupLibrary({ target: path.join(link, "lib"), home })).toMatchObject({ status: "already" });
    expect(await setupLibrary({ target: path.join(real, "lib"), home })).toMatchObject({ status: "already" });
  });
});
