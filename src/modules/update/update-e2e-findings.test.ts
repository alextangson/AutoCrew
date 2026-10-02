/**
 * Verifier findings from the real end-to-end run (2026-10-01, fake install on :4324).
 * Each test encodes the behaviour the spec / user-facing copy promises; the ones that fail are findings, not flakes.
 * Real git and the real launcher (bin/autocrew.mjs) are used — no mocked steps.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { parseChangelog } from "./changelog.js";
import { prepareUpdate } from "./start.js";
import { realSteps } from "./updater.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
const BASE = os.tmpdir();
let tmp: string;
const prevLocal = process.env.AUTOCREW_LOCAL_DIR;

beforeEach(() => {
  fs.mkdirSync(BASE, { recursive: true });
  tmp = fs.mkdtempSync(path.join(BASE, "findings-"));
  process.env.AUTOCREW_LOCAL_DIR = path.join(tmp, "machine");
  fs.mkdirSync(process.env.AUTOCREW_LOCAL_DIR, { recursive: true });
});
afterEach(() => {
  if (prevLocal === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prevLocal;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", LC_ALL: "C" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" }).trim();
const writeVersion = (dir: string, v: string) => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: v }) + "\n");

/** origin with releases v0.4.9 and v0.5.0 on main; user clone left at v0.4.9 */
function releasedRepos(): { origin: string; user: string } {
  const origin = path.join(tmp, "origin.git");
  const work = path.join(tmp, "work");
  const user = path.join(tmp, "user");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "init", "-q", "-b", "main", work);
  writeVersion(work, "0.4.9");
  git(work, "add", "package.json"); git(work, "commit", "-qm", "0.4.9"); git(work, "tag", "v0.4.9");
  writeVersion(work, "0.5.0");
  git(work, "add", "package.json"); git(work, "commit", "-qm", "0.5.0"); git(work, "tag", "v0.5.0");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main", "v0.4.9", "v0.5.0");
  git(tmp, "clone", "-q", origin, user);
  git(user, "reset", "-q", "--hard", "v0.4.9");
  return { origin, user };
}

describe("diverged install (local commit on an older release)", () => {
  it("does not tell the user their install is newer than the release, and does not treat it as 'nothing to do'", async () => {
    const { user } = releasedRepos();
    fs.writeFileSync(path.join(user, "LOCAL.md"), "local tweak\n");
    git(user, "add", "LOCAL.md"); git(user, "commit", "-qm", "local tweak");
    // local package.json is still 0.4.9; the published release is 0.5.0 → the install is diverged, not newer
    const r = await prepareUpdate(user, process.env.AUTOCREW_LOCAL_DIR!, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).not.toContain("比最新发布版还新");
    expect(r.reason).toContain("分叉");
    // `autocrew update` exits 0 for code "no_update"; a diverged install that cannot update is a refusal, not success
    expect(r.code).not.toBe("no_update");
  }, 30_000);
});

describe("truly ahead install (local commit on top of the latest release)", () => {
  it("is not offered an update and gets a no-update answer (guard for whoever fixes the diverged message)", async () => {
    const { user } = releasedRepos();
    git(user, "reset", "-q", "--hard", "v0.5.0");
    fs.writeFileSync(path.join(user, "LOCAL.md"), "local tweak\n");
    git(user, "add", "LOCAL.md"); git(user, "commit", "-qm", "local tweak");
    const r = await prepareUpdate(user, process.env.AUTOCREW_LOCAL_DIR!, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("no_update");
  }, 30_000);
});

describe("CHANGELOG '需要你做的' written as 无", () => {
  it("the CHANGELOG header tells release writers to put 无 when there is nothing to do; that must not become a highlighted todo", () => {
    const notes = parseChangelog([
      "## 0.5.5 · 2026-10-06",
      "### 新东西",
      "- 一个新东西",
      "### 修好的",
      "- 无",
      "### 需要你做的",
      "- 无",
    ].join("\n"));
    expect(notes).toHaveLength(1);
    expect(notes[0].todo).toEqual([]);
    expect(notes[0].fixes).toEqual([]);
  });
});

describe("restart step when the port is held by a process the launcher did not start", () => {
  let foreign: http.Server;
  let port: number;
  beforeEach(async () => {
    foreign = http.createServer((_req, res) => { res.writeHead(200).end("old process still serving"); });
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    port = (foreign.address() as AddressInfo).port;
  });
  afterEach(async () => { await new Promise<void>((resolve) => foreign.close(() => resolve())); });

  it("must not report a successful restart + health check while the old/foreign process keeps serving", async () => {
    // Observed on :4324: a release whose server needs >15 s to print its URL makes the launcher give up and delete
    // autocrew.pid while the process lives on. The rollback's restart then says 「AutoCrew 已在运行」 and the health
    // check passes against that leftover process → 「已退回 0.5.0」 while 0.5.3 code is serving; the next update then
    // reports 「已更新到 0.5.4」 without restarting anything. Root cause reproduced here with no pid file and a foreign
    // 200 on the port.
    const lines: string[] = [];
    const steps = realSteps(REPO, port, { serverWasRunning: true, busy: async () => null });
    let restartedAndHealthy = false;
    try {
      await steps.restart((l) => lines.push(l));
      await steps.health((l) => lines.push(l));
      restartedAndHealthy = true;
    } catch { /* expected: the update must fail and roll back / surface the problem */ }
    expect(lines.join("\n")).toContain("已在运行"); // documents the launcher path taken
    expect(restartedAndHealthy).toBe(false);
  }, 30_000);
});
