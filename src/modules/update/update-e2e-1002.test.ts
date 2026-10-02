/**
 * 真机验收 2026-10-02 的发现：每条一个修之前会失败的用例。涉及进程、信号的用真进程跑；
 * `autocrew update` 用一份拷贝的启动器 + 假更新脚本（不碰本仓库 git、不起真服务）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DepsSwap } from "./deps-swap.js";
import { recoveryCommands } from "./interrupted.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-e2e1002-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const until = async (f: () => boolean, ms = 20_000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return f(); };

function fakeInstall(updateScript: string): string {
  const root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "bin", "autocrew.mjs"), path.join(root, "bin", "autocrew.mjs"));
  fs.symlinkSync(fs.realpathSync(path.join(REPO, "node_modules", ".bin", "tsx")), path.join(root, "node_modules", ".bin", "tsx"));
  fs.symlinkSync(path.join(REPO, "node_modules", "tsx"), path.join(root, "node_modules", "tsx"));
  fs.writeFileSync(path.join(root, "scripts", "update.mts"), updateScript);
  return root;
}

describe("P1-A Ctrl-C 正好落在更新进程忙着（事件循环被占住）的那几秒", () => {
  it("前台 Ctrl-C：更新进程不被强杀，忙完后在安全点中止、退回、写结果，前台等到结果才退出", async () => {
    const marker = path.join(tmp, "rolled-back");
    // 假更新进程：打一行开始，然后同步忙 3 秒（像同步删 node_modules），忙完再看有没有收到中止
    const root = fakeInstall(`
import fs from "node:fs";
let aborted = false;
process.on("SIGINT", () => { aborted = true; });
console.log("开始更新");
setTimeout(() => {
  const end = Date.now() + 3000; while (Date.now() < end) { /* 同步忙 */ }
  setTimeout(() => {
    if (aborted) { fs.writeFileSync(${JSON.stringify(marker)}, "x"); console.log("更新中止了，已退回 0.4.9"); process.exit(1); }
    console.log("已更新"); process.exit(0);
  }, 50);
}, 300);
`);
    const p = spawn(process.execPath, [path.join(root, "bin", "autocrew.mjs"), "update"], { detached: true, env: { ...process.env, AUTOCREW_LOCAL_DIR: path.join(tmp, "m") } });
    let out = "";
    p.stdout.on("data", (c) => { out += c; });
    const exit = new Promise<number | null>((r) => p.on("exit", (c) => r(c)));
    expect(await until(() => out.includes("开始更新"))).toBe(true);
    await new Promise((r) => setTimeout(r, 800)); // 已经进了同步忙的那段
    process.kill(-p.pid!, "SIGINT");
    const code = await exit;
    expect(fs.existsSync(marker), "更新进程活下来、走完了中止").toBe(true);
    expect(out).toContain("已退回 0.4.9");
    expect(code).toBe(1);
  }, 30_000);
});

describe("P1-A 删依赖目录不卡事件循环", () => {
  it("退回换回旧依赖时，删新装的 node_modules 是异步的：期间定时器照样能跑", async () => {
    const root = path.join(tmp, "r");
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "old"), "old");
    const swap = new DepsSwap(root, "1");
    swap.backupDeps(() => {});
    // 「新装的」依赖：几千个文件，同步删要占住事件循环
    const nm = path.join(root, "node_modules");
    for (let i = 0; i < 40; i++) {
      const d = path.join(nm, `pkg${i}`);
      fs.mkdirSync(d, { recursive: true });
      for (let j = 0; j < 100; j++) fs.writeFileSync(path.join(d, `f${j}.js`), "x");
    }
    let ticks = 0;
    let done = false;
    const spin = () => { if (done) return; ticks++; setImmediate(spin); };
    setImmediate(spin);
    await swap.restore(() => {});
    done = true;
    expect(ticks).toBeGreaterThan(1);
    expect(fs.readFileSync(path.join(nm, "old"), "utf-8")).toBe("old");
  });

  it("删到一半的旧依赖（已改名成 .trash-…）绝不当恢复来源", () => {
    const root = path.join(tmp, "r");
    fs.mkdirSync(path.join(root, "node_modules.prev-5.trash-1-2"), { recursive: true });
    fs.mkdirSync(path.join(root, "frontend"), { recursive: true });
    const cmds = recoveryCommands(root, "abc");
    expect(cmds.join("\n")).not.toContain("trash");
  });

  it("健康检查通过后的清理：留着的 .prev 要么完整、要么不在（先改名再删），删完不留东西", async () => {
    const root = path.join(tmp, "r");
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    const swap = new DepsSwap(root, "7");
    swap.backupDeps(() => {});
    fs.mkdirSync(path.join(root, "node_modules"));
    await swap.cleanup(() => {});
    expect(fs.readdirSync(root).filter((n) => n.includes(".prev-") || n.includes(".trash-"))).toEqual([]);
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import http from "node:http";
import { detectInterrupted, readInflight, writeInflight } from "./interrupted.js";
import { readResult } from "./state.js";
import { createUpdateHandler } from "../../desktop/update-route.js";
import { startEpoch } from "../../desktop/chief-editor/run-store.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
/** 一个 git 安装：HEAD 一个提交，两份依赖的关键命令在 */
function consistentInstall(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  execFileSync("git", ["add", "package.json"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "x"], { cwd: root, env: ENV });
  for (const f of ["node_modules/.bin/tsx", "frontend/node_modules/.bin/vite"]) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "");
  }
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
}

describe("P2-B 照步骤恢复好之后，不再报中断、不叫人重装能用的依赖", () => {
  it("新起的服务 / 命令行看到安装一致：清掉在途记录，不报「上次更新中断」", () => {
    const root = path.join(tmp, "r"), m = path.join(tmp, "m");
    const head = consistentInstall(root);
    fs.mkdirSync(m);
    writeInflight(m, { at: new Date(Date.now() - 60_000).toISOString(), from: "0.4.9", to: "0.5.0", log: "/l", oldHead: head, commit: "f".repeat(40) });
    expect(detectInterrupted(root, m, { trustInstall: true })).toBeNull();
    expect(readInflight(m)).toBeNull();
    expect(readResult(m)).toBeNull();
  });

  it("恢复命令不叫人删掉 / 重装一份完整的依赖", () => {
    const root = path.join(tmp, "r");
    consistentInstall(root);
    const cmds = recoveryCommands(root, "abc").join("\n");
    expect(cmds).not.toContain("npm ci");
    expect(cmds).not.toContain("rm -rf");
  });
});

describe("P2-C 更新进程死了、旧服务还在跑：读状态就认出来，显示真正在跑的版本", () => {
  it("在途记录在、锁的主人没了、这个服务在中断之前就起来了：页面拿到「上次更新中断」，版本是在跑的那一版", async () => {
    const root = path.join(tmp, "r"), m = path.join(tmp, "m");
    const head = consistentInstall(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.5.0" })); // 磁盘上已被换成新版本
    fs.mkdirSync(m);
    const startedAt = Date.now() - 120_000;
    writeInflight(m, { at: new Date(Date.now() - 60_000).toISOString(), from: "0.4.9", to: "0.5.0", log: "/l", oldHead: head, commit: head });
    const route = createUpdateHandler({ authorize: () => "session", originAllowed: () => true, readBody: async () => "", root, machineDir: m, port: 1, runningVersion: "0.4.9", processStartedAt: startedAt });
    const server = http.createServer((req, res) => void route(req, res, new URL(req.url!, "http://x")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      const body = await (await fetch(`http://127.0.0.1:${port}/api/update`)).json() as { data: { current: string; result: { outcome: string; message: string } | null } };
      expect(body.data.current).toBe("0.4.9");
      expect(body.data.result?.message).toContain("上次更新中断了");
    } finally { await new Promise((r) => server.close(r)); }
  });
});

/** 一份拷贝的启动器（程序根是临时目录）；依赖缺失 */
function bareBin(): string {
  const root = path.join(tmp, "bare");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "bin", "autocrew.mjs"), path.join(root, "bin", "autocrew.mjs"));
  return root;
}
const runBin = (root: string, cmd: string, m: string) =>
  spawnSync(process.execPath, [path.join(root, "bin", "autocrew.mjs"), cmd, "--no-open"], { env: { ...process.env, AUTOCREW_LOCAL_DIR: m, AUTOCREW_PORT: "1" }, encoding: "utf-8", timeout: 20_000 });

describe("P2-D 装依赖期间再跑 autocrew update", () => {
  it("更新锁有活人拿着、tsx 暂时不在：回「正在更新」，不叫人去 npm ci", () => {
    const root = bareBin(), m = path.join(tmp, "m");
    fs.mkdirSync(m);
    fs.writeFileSync(path.join(m, "update.lock"), JSON.stringify({ pid: process.pid, token: "t", at: "", start: startEpoch(process.pid) }));
    const r = runBin(root, "update", m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("正在更新");
    expect(r.stderr).not.toContain("npm ci");
  });
});

describe("P3-F 中断状态下 npm start", () => {
  it("安装不一致：打完恢复步骤就停，不接着去构建", () => {
    const root = bareBin(), m = path.join(tmp, "m");
    fs.mkdirSync(m);
    writeInflight(m, { at: "", from: "0.4.9", to: "0.5.0", log: "/l", oldHead: "abc123" });
    const r = runBin(root, "start", m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("上次一键更新中断了");
    expect(`${r.stdout}${r.stderr}`).not.toContain("正在构建前端");
  });
});

describe("P3-E 更新进程意外退出", () => {
  it("没留下这一次的结果：前台说一声，并告诉下一步", () => {
    const root = fakeInstall(`console.log("开始更新"); process.exit(9);`);
    const r = runBin(root, "update", path.join(tmp, "m"));
    expect(r.status).toBe(9);
    expect(r.stderr).toContain("更新进程意外退出了");
    expect(r.stderr).toContain("autocrew update");
  });
});

import { admitMutation } from "../../desktop/http-busy-guard.js";
import { activeWorkCount, beginWork, resetActiveWork } from "./active-work.js";
import { activeTurnCount, registerTurn, resetActiveTurns } from "../../desktop/turn-registry.js";

describe("P3-G 一个对话轮只算一件事", () => {
  it("浏览器发来的对话轮：请求本身、IPC 长通道、对话轮登记合起来只算 1", async () => {
    resetActiveWork(); resetActiveTurns();
    let seen = -1, release!: () => void;
    const server = http.createServer((req, res) => {
      if (!admitMutation(req, res, "/api/invoke")) return;
      void (async () => {
        await Promise.resolve();
        const w = beginWork("chat:turn"); // IPC 长通道
        const t = registerTurn("turn-g", "client-g"); // 对话轮登记
        seen = activeWorkCount() + activeTurnCount();
        await new Promise<void>((r) => { release = r; });
        if (w.ok) w.end();
        void t;
        res.writeHead(200).end("{}");
      })();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      const pending = fetch(`http://127.0.0.1:${port}/api/invoke`, { method: "POST", body: "{}" });
      expect(await until(() => seen >= 0)).toBe(true);
      expect(seen).toBe(1);
      release();
      await pending;
    } finally { await new Promise((r) => server.close(r)); resetActiveTurns(); resetActiveWork(); }
  });
});
