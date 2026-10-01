/**
 * Codex 审第 6 轮的两条 P2：每条一个修之前会失败的用例。
 * 抢锁用两个真进程（tsx）同时收回同一批死锁；MCP 用进程内的 handleMcpRequest，不起服务。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireLock, releaseLock, UPDATING_MESSAGE } from "./preflight.js";
import { resetActiveWork } from "./active-work.js";
import { isLongRunningTool, TOOL_DEFAULT_ACTIONS } from "./long-running.js";
import { handleMcpRequest } from "../../../mcp/server.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
let tmp: string;
const prev = process.env.AUTOCREW_LOCAL_DIR;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-upd-review6-")); process.env.AUTOCREW_LOCAL_DIR = tmp; resetActiveWork(); });
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P2 省略 action 也按默认动作分类", () => {
  it("每个有默认动作的工具：省略 action 与显式写默认动作分类一致", () => {
    for (const [tool, def] of Object.entries(TOOL_DEFAULT_ACTIONS)) {
      expect(isLongRunningTool(tool, undefined), tool).toBe(isLongRunningTool(tool, def));
      expect(isLongRunningTool(tool, ""), tool).toBe(isLongRunningTool(tool, def));
    }
    expect(isLongRunningTool("autocrew_research", undefined)).toBe(true);
    expect(isLongRunningTool("autocrew_insights", undefined)).toBe(true);
  });

  it("更新中经 /mcp 省略 action 调调研 / 洞察：照样被拒", async () => {
    expect(acquireLock(tmp, "t")).toBe(true);
    for (const name of ["autocrew_research", "autocrew_insights"]) {
      const r = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } } as never, undefined, path.join(tmp, "lib"));
      expect((r as { result: { structuredContent?: unknown } }).result.structuredContent, name).toMatchObject({ code: "updating", error: UPDATING_MESSAGE });
    }
    releaseLock(tmp, "t");
  });
});

describe("P2 收回死锁不互相删", () => {
  it("两个进程同时收回同一把死锁：每把只有一个拿到", async () => {
    const ROUNDS = 150;
    const dirs = Array.from({ length: ROUNDS }, (_, i) => path.join(tmp, `d${i}`));
    for (const d of dirs) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "update.lock"), JSON.stringify({ pid: 99999999, token: "dead", at: "" }));
    }
    const go = path.join(tmp, "go");
    const script = path.join(tmp, "racer.mts");
    fs.writeFileSync(script, [
      `import fs from "node:fs";`,
      `import { acquireLock } from ${JSON.stringify(pathToFileURL(path.join(REPO, "src/modules/update/preflight.ts")).href)};`,
      `const [me, go, ...dirs] = process.argv.slice(2);`,
      `fs.writeFileSync(go + "." + me, "ready");`,
      `while (!fs.existsSync(go)) { /* 自旋等起跑，两边尽量同时开抢 */ }`,
      `const won = dirs.map((d) => acquireLock(d, me) ? 1 : 0);`,
      `process.stdout.write(JSON.stringify(won));`,
    ].join("\n"));
    const tsx = path.join(REPO, "node_modules", ".bin", "tsx");
    const run = (me: string) => new Promise<number[]>((resolve, reject) => {
      const p = spawn(tsx, [script, me, go, ...dirs]);
      let out = "";
      p.stdout.on("data", (c) => { out += c; });
      p.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out) as number[]) : reject(new Error(`racer ${me} 退出码 ${code}`))));
    });
    const a = run("A"), b = run("B");
    while (!(fs.existsSync(`${go}.A`) && fs.existsSync(`${go}.B`))) await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(go, "go");
    const [wa, wb] = await Promise.all([a, b]);
    const both = dirs.filter((_, i) => wa[i] + wb[i] !== 1);
    expect(both, "每把死锁恰好一个赢家").toEqual([]);
    // 锁里留下的就是赢家的
    for (const [i, d] of dirs.entries()) {
      expect(JSON.parse(fs.readFileSync(path.join(d, "update.lock"), "utf-8")).token).toBe(wa[i] ? "A" : "B");
    }
  }, 60_000);
});
