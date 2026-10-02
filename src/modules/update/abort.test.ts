/**
 * Ctrl-C 落在更新中途（e2e P1-3）：真的子进程跑真的 runUpdate + realSteps，npm 换成会卡住的假脚本；
 * 在装依赖时给整个进程组发 SIGINT（和终端里按 Ctrl-C 一样），看它退回、写结果、放锁、退出。git 只碰临时仓库。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAbortHandle } from "./abort.js";
import { checkForUpdate } from "./check.js";
import { gitRunner } from "./git.js";
import { lockHeld } from "./preflight.js";
import { readResult } from "./state.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
let tmp: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-abort-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("再按一次 Ctrl-C", () => {
  it("第一次请求中止；之后只提示「正在退回，请稍等」", () => {
    const said: string[] = [];
    const h = createAbortHandle((m) => said.push(m));
    h.onSignal();
    expect(h.signal.aborted).toBe(true);
    h.onSignal();
    expect(said[1]).toBe("正在退回，请稍等");
  });
});

describe("装依赖时按 Ctrl-C", () => {
  it("中止 → 正常退回：代码、依赖换回旧的，结果写好，锁放掉，进程退出", async () => {
    const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), machine = path.join(tmp, "m");
    g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    fs.writeFileSync(path.join(dev, ".gitignore"), "node_modules\nnode_modules.prev-*\n");
    const rel = (v: string) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json", ".gitignore"); g(dev, "commit", "-q", "-m", v); g(dev, "tag", "-a", `v${v}`, "-m", v); g(dev, "push", "-q", "origin", "main", "--tags"); };
    rel("0.4.0"); g(tmp, "clone", "-q", origin, user); rel("0.5.0");
    fs.mkdirSync(machine);
    fs.mkdirSync(path.join(user, "node_modules"));
    fs.writeFileSync(path.join(user, "node_modules", "marker"), "old");
    await checkForUpdate(user, machine, { git: gitRunner(user) });
    const old = g(user, "rev-parse", "HEAD");
    const started = path.join(tmp, "npm-started");
    const npm = path.join(tmp, "fake-npm.sh");
    fs.writeFileSync(npm, `#!/bin/sh\nrm -rf node_modules; mkdir -p node_modules; echo half > node_modules/marker; touch "${started}"; sleep 30\n`, { mode: 0o755 });
    const mod = (f: string) => JSON.stringify(pathToFileURL(path.join(REPO, "src/modules/update", f)).href);
    const script = path.join(tmp, "run.mts");
    fs.writeFileSync(script, [
      `import { runUpdate, realSteps } from ${mod("updater.ts")};`,
      `import { acquireLock, releaseLock } from ${mod("preflight.ts")};`,
      `import { installAbortHandlers } from ${mod("abort.ts")};`,
      `import { gitRunner } from ${mod("git.ts")};`,
      `const abort = installAbortHandlers((m) => console.log(m));`,
      `acquireLock(${JSON.stringify(machine)}, "cli");`,
      `try {`,
      `  const r = await runUpdate({ root: ${JSON.stringify(user)}, machineDir: ${JSON.stringify(machine)}, tag: "v0.5.0", commit: ${JSON.stringify(g(user, "rev-parse", "v0.5.0^{commit}"))}, from: "0.4.0", to: "0.5.0",`,
      `    git: gitRunner(${JSON.stringify(user)}), steps: realSteps(${JSON.stringify(user)}, 1, { serverWasRunning: false, busy: async () => null, npm: ${JSON.stringify(npm)} }), logFile: ${JSON.stringify(path.join(machine, "u.log"))}, signal: abort.signal });`,
      `  console.log("RESULT " + r.outcome);`,
      `} finally { releaseLock(${JSON.stringify(machine)}, "cli"); abort.dispose(); }`,
    ].join("\n"));
    const child = spawn(path.join(REPO, "node_modules", ".bin", "tsx"), [script], { detached: true, env: { ...process.env, AUTOCREW_LOCAL_DIR: machine } });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(started) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(started), "假 npm 跑起来了").toBe(true);
    process.kill(-child.pid!, "SIGINT"); // 和终端里按 Ctrl-C 一样：发给整个前台进程组
    await exited;
    expect(out).toContain("收到中止");
    expect(out).toContain("RESULT rolled_back");
    expect(readResult(machine)).toMatchObject({ ok: false, outcome: "rolled_back", message: expect.stringContaining("中止") });
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
    expect(fs.readFileSync(path.join(user, "node_modules", "marker"), "utf-8")).toBe("old");
    expect(lockHeld(machine)).toBe(false);
  }, 45_000);
});
