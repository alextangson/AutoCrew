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
