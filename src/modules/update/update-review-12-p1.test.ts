/**
 * 第 12 轮 P1：命令行更新中途关终端（SIGHUP）/ 按 Ctrl-C / 进程被硬杀。
 * 真进程：更新脚本跑在 tsx 里；`autocrew update` 用一份拷贝的启动器 + 假更新脚本（不碰本仓库 git、不起真服务）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkForUpdate } from "./check.js";
import { gitRunner } from "./git.js";
import { lockHeld } from "./preflight.js";
import { readResult } from "./state.js";
import { detectInterrupted, readInflight, writeInflight } from "./interrupted.js";
import { prepareUpdate } from "./start.js";
import { runUpdate, type UpdateSteps } from "./updater.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
const TSX = fs.realpathSync(path.join(REPO, "node_modules", ".bin", "tsx"));
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-r12p1-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const until = async (f: () => boolean, ms = 20_000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return f(); };

describe("关终端（SIGHUP）按中止处理", () => {
  it("装依赖时收到 SIGHUP：正常退回、写结果、放锁", async () => {
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
    const child = spawn(TSX, [script], { detached: true, env: { ...process.env, AUTOCREW_LOCAL_DIR: machine } });
    const exited = new Promise((r) => child.on("exit", r));
    expect(await until(() => fs.existsSync(started))).toBe(true);
    process.kill(-child.pid!, "SIGHUP"); // 关掉终端窗口：整个前台进程组收到 SIGHUP
    await exited;
    // tsx 外壳可能先退出；真正的更新进程接着把退回跑完
    expect(await until(() => readResult(machine) !== null && !lockHeld(machine))).toBe(true);
    expect(readResult(machine)).toMatchObject({ ok: false, outcome: "aborted" });
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
    expect(fs.readFileSync(path.join(user, "node_modules", "marker"), "utf-8")).toBe("old");
    expect(lockHeld(machine)).toBe(false);
  }, 45_000);
});

/** 一份拷贝的启动器：程序根是临时目录，scripts/update.mts 换成假的 */
function fakeInstall(updateScript: string | null): string {
  const root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(REPO, "bin", "autocrew.mjs"), path.join(root, "bin", "autocrew.mjs"));
  if (updateScript !== null) {
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    fs.symlinkSync(TSX, path.join(root, "node_modules", ".bin", "tsx"));
    fs.symlinkSync(path.join(REPO, "node_modules", "tsx"), path.join(root, "node_modules", "tsx")); // 更新进程用 node --import tsx 起
    fs.writeFileSync(path.join(root, "scripts", "update.mts"), updateScript);
  }
  return root;
}

describe("autocrew update：更新进程脱离终端，前台只跟输出", () => {
  const FAKE = (marker: string) => `
import fs from "node:fs";
console.log("开始更新 0.4.0 → 0.5.0");
let aborted = false;
process.on("SIGINT", () => { if (aborted) return; aborted = true; console.log("收到中止"); setTimeout(() => { console.log("更新中止了，已退回 0.4.0"); process.exit(1); }, 1500); });
setTimeout(() => { if (!aborted) { fs.writeFileSync(${JSON.stringify(marker)}, "done"); console.log("已更新到 0.5.0"); process.exit(0); } }, 2500);
setInterval(() => {}, 1000);
`;
  const runCli = (root: string) => {
    const p = spawn(process.execPath, [path.join(root, "bin", "autocrew.mjs"), "update"], { detached: true, env: { ...process.env, AUTOCREW_LOCAL_DIR: path.join(tmp, "m") } });
    let out = "";
    p.stdout.on("data", (c) => { out += c; });
    const exit = new Promise<number | null>((r) => p.on("exit", (c) => r(c)));
    return { p, out: () => out, exit };
  };

  it("Ctrl-C：转给更新进程请求中止，前台等到退回跑完、拿到结果才退出", async () => {
    const root = fakeInstall(FAKE(path.join(tmp, "done")));
    const cli = runCli(root);
    expect(await until(() => cli.out().includes("开始更新"))).toBe(true);
    process.kill(-cli.p.pid!, "SIGINT"); // 终端里按 Ctrl-C：发给前台进程组
    const code = await cli.exit;
    expect(cli.out()).toContain("已退回 0.4.0");
    expect(code).toBe(1);
  }, 30_000);

  it("关终端（SIGHUP）：前台走了，更新进程照常跑完", async () => {
    const marker = path.join(tmp, "done");
    const root = fakeInstall(FAKE(marker));
    const cli = runCli(root);
    expect(await until(() => cli.out().includes("开始更新"))).toBe(true);
    process.kill(-cli.p.pid!, "SIGHUP");
    await cli.exit;
    expect(await until(() => fs.existsSync(marker), 10_000)).toBe(true);
  }, 30_000);

  it("依赖装到一半、连 tsx 都没有：启动器按磁盘现状给出恢复命令（有旧依赖就改名换回）", () => {
    const root = fakeInstall(null);
    fs.mkdirSync(path.join(root, "node_modules.prev-123"));
    const m = path.join(tmp, "m");
    fs.mkdirSync(m, { recursive: true });
    fs.writeFileSync(path.join(m, "update-inflight.json"), JSON.stringify({ at: "", from: "0.4.0", to: "0.5.0", log: "/l", oldHead: "abc123" }));
    const r = execFileSyncSafe(process.execPath, [path.join(root, "bin", "autocrew.mjs"), "update"], { ...process.env, AUTOCREW_LOCAL_DIR: m });
    expect(r).toContain("上次一键更新中断了");
    expect(r).toContain("git reset --hard abc123");
    expect(r).toContain('mv "node_modules.prev-123" "node_modules"');
    expect(r).not.toContain("npm ci");
  });
});

function execFileSyncSafe(cmd: string, args: string[], env: NodeJS.ProcessEnv): string {
  try { return execFileSync(cmd, args, { env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { const x = e as { stdout?: string; stderr?: string }; return `${x.stdout ?? ""}${x.stderr ?? ""}`; }
}

describe("被硬杀之后下次能认出「上次更新中断了」", () => {
  it("在途记录在、锁没人拿：写一份「需要手动恢复」的结果，命令按磁盘现状算；再跑更新先叫你恢复", async () => {
    const root = path.join(tmp, "r"), m = path.join(tmp, "m");
    fs.mkdirSync(path.join(root, "frontend", "node_modules.prev-9"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules.prev-9"));
    fs.mkdirSync(m);
    writeInflight(m, { at: "", from: "0.4.0", to: "0.5.0", log: "/l", oldHead: "abc123" });
    const r = detectInterrupted(root, m);
    expect(r).toMatchObject({ ok: false, outcome: "stuck", message: expect.stringContaining("上次更新中断了") });
    expect(r!.manualCommands).toContain('rm -rf "frontend/node_modules" && mv "frontend/node_modules.prev-9" "frontend/node_modules"');
    expect(readResult(m)?.outcome).toBe("stuck");
    expect(readInflight(m)).toBeNull();
    writeInflight(m, { at: "", from: "0.4.0", to: "0.5.0", log: "/l", oldHead: "abc123" });
    const prep = await prepareUpdate(root, m, {});
    expect(prep).toMatchObject({ ok: false, code: "interrupted" });
  });

  it("正常跑完（成功或退回）会删掉在途记录", async () => {
    const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), m = path.join(tmp, "m");
    g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    const rel = (v: string) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json"); g(dev, "commit", "-q", "-m", v); g(dev, "tag", "-a", `v${v}`, "-m", v); g(dev, "push", "-q", "origin", "main", "--tags"); };
    rel("0.4.0"); g(tmp, "clone", "-q", origin, user); rel("0.5.0");
    fs.mkdirSync(m);
    await checkForUpdate(user, m, { git: gitRunner(user) });
    const s = async () => {};
    const steps: UpdateSteps = { install: s, build: s, quiesce: s, serviceDown: async () => false, restart: s, health: s };
    const r = await runUpdate({ root: user, machineDir: m, tag: "v0.5.0", commit: g(user, "rev-parse", "v0.5.0^{commit}"), from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(m, "u.log") });
    expect(r.ok).toBe(true);
    expect(readInflight(m)).toBeNull();
  });
});
