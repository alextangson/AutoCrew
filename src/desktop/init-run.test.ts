/** autocrew init（O16）：幂等、失败停在那一步给原因与下一步、不报假成功；O15 先问 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatInit, resolveCaller, runInit, type InitDeps } from "./init-run.js";
import type { HostStatus } from "./host-connect/detect.js";
import type { HostEnv } from "./host-connect/env.js";
import { readLibraryLocation } from "../storage/storage-roots.js";

let home: string;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-init-")));
  await fs.mkdir(path.join(home, ".autocrew"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("AUTOCREW_LOCAL_DIR", path.join(home, ".autocrew"));
  vi.stubEnv("AUTOCREW_DATA_DIR", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });

function deps(state: { connected: boolean; connectOk?: boolean }): InitDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    env: {} as HostEnv,
    processEnv: {},
    serviceSetup: async () => null,
    detect: async (host) => ({ host, connected: state.connected } as HostStatus),
    connect: async (host) => {
      calls.push(`connect:${host}`);
      return state.connectOk === false
        ? { ok: false, host, registered: false, verified: false, message: "Claude Code 没登录", error: "Claude Code 没登录" }
        : { ok: true, host, registered: true, verified: true, message: "接好了" };
    },
  };
}

it("caller: --host wins; CLAUDECODE=1 means Claude Code; otherwise unknown", () => {
  expect(resolveCaller("codex", { CLAUDECODE: "1" })).toBe("codex");
  expect(resolveCaller(undefined, { CLAUDECODE: "1" })).toBe("claude");
  expect(resolveCaller(undefined, {})).toBeNull();
});

it("first run connects and creates the library; second run skips both and says so", async () => {
  const d = deps({ connected: false });
  const first = await runInit({ host: "claude" }, d);
  expect(first).toMatchObject({ ok: true, exitCode: 0 });
  expect(first.steps.map((s) => s.state)).toEqual(["done", "done"]);
  expect(readLibraryLocation()?.root).toBe(path.join(home, "AutoCrew资料库"));
  const again = await runInit({ host: "claude" }, deps({ connected: true }));
  expect(again.steps.map((s) => s.state)).toEqual(["skipped", "skipped"]);
  expect(formatInit(again)).toContain("跳过");
});

it("connect failure stops there: raw reason + next step, library untouched, exit 1", async () => {
  const r = await runInit({ host: "claude" }, deps({ connected: false, connectOk: false }));
  expect(r).toMatchObject({ ok: false, exitCode: 1 });
  expect(r.steps).toHaveLength(1);
  expect(r.steps[0]).toMatchObject({ state: "failed", error: "Claude Code 没登录" });
  expect(formatInit(r)).not.toContain("全部完成");
  expect(readLibraryLocation()).toBeNull();
});

it("unknown caller → asks for --host", async () => {
  const r = await runInit({}, deps({ connected: false }));
  expect(r.steps[0].next).toContain("--host");
});

it("O15: legacy drafts → exit 2 with the question; nothing created until answered", async () => {
  await fs.mkdir(path.join(home, ".autocrew", "contents", "c1"), { recursive: true });
  const r = await runInit({ host: "claude" }, deps({ connected: true }));
  expect(r).toMatchObject({ ok: false, exitCode: 2 });
  expect(r.steps[1].message).toContain("1 篇稿");
  expect(readLibraryLocation()).toBeNull();
  expect((await runInit({ host: "claude", legacy: "bogus" }, deps({ connected: true }))).exitCode).toBe(1);
});

it("O13: refused path fails visibly with a suggestion", async () => {
  await fs.mkdir(path.join(home, "stuff")); await fs.writeFile(path.join(home, "stuff", "a"), "x");
  const r = await runInit({ host: "claude", library: path.join(home, "stuff") }, deps({ connected: true }));
  expect(r.exitCode).toBe(1);
  expect(r.steps[1].next).toContain(path.join(home, "stuff", "AutoCrew资料库"));
});

it("service running → library goes through the service (it holds the writer lock)", async () => {
  const d = deps({ connected: true });
  d.serviceSetup = async (b) => ({ status: "created", root: b.target, plan: {} as never });
  const r = await runInit({ host: "claude" }, d);
  expect(r.steps[1].state).toBe("done");
  expect(readLibraryLocation()).toBeNull();
});
