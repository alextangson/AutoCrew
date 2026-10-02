/**
 * 启动器认人（e2e P1-1）：用真的 bin/autocrew.mjs，但服务换成一个假脚本（AUTOCREW_SERVER_SCRIPT），不起真服务、不构建前端。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { realSteps } from "./updater.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
let tmp: string, port: number;
const prev = process.env.AUTOCREW_LOCAL_DIR;

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
}
/** 假服务：等 delayMs 再监听，报启动标记，打印启动链接 */
function fakeServer(delayMs: number): string {
  const f = path.join(tmp, "fake-server.mjs");
  fs.writeFileSync(f, `import http from "node:http";
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url === "/__autocrew/launch") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, nonce: process.env.AUTOCREW_LAUNCH_NONCE ?? null, via: "launcher" }));
    res.writeHead(200).end("ok");
  }).listen(Number(process.env.AUTOCREW_PORT), "127.0.0.1", () => console.log("http://127.0.0.1:" + process.env.AUTOCREW_PORT + "/?token=ab12"));
}, ${delayMs});
setInterval(() => {}, 1000);
`);
  return f;
}
const launcher = (cmd: string, env: Record<string, string>) =>
  spawnSync(process.execPath, [path.join(REPO, "bin", "autocrew.mjs"), cmd, "--no-open"], { env: { ...process.env, AUTOCREW_LOCAL_DIR: tmp, AUTOCREW_PORT: String(port), ...env }, encoding: "utf-8", timeout: 30_000 });
const answers = async () => { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }); return true; } catch { return false; } };

beforeEach(async () => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-launcher-")); port = await freePort(); process.env.AUTOCREW_LOCAL_DIR = tmp; });
afterEach(() => {
  launcher("stop", {});
  if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("启动器只认自己起的那个进程", () => {
  it("起得慢、超时：结束这次起的进程，不留没人管的服务，报失败", async () => {
    const r = launcher("start", { AUTOCREW_SERVER_SCRIPT: fakeServer(4_000), AUTOCREW_LAUNCH_TIMEOUT_MS: "1500" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("没起来");
    await new Promise((res) => setTimeout(res, 4_500));
    expect(await answers()).toBe(false);
    expect(fs.existsSync(path.join(tmp, "autocrew.pid"))).toBe(false);
  }, 30_000);

  it("正常起来：标记对上；更新的健康检查认它；再 start 说已在运行", async () => {
    const r = launcher("start", { AUTOCREW_SERVER_SCRIPT: fakeServer(200) });
    expect(r.status, r.stderr).toBe(0);
    const lines: string[] = [];
    await realSteps(REPO, port, { serverWasRunning: true, busy: async () => null, machineDir: tmp }).health((l) => lines.push(l));
    expect(lines.join("\n")).toContain("这次启动的进程");
    const again = launcher("start", { AUTOCREW_SERVER_SCRIPT: fakeServer(200) });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("已在运行");
  }, 30_000);

  it("标记文件被换掉（端口上是上一次留下的进程）：健康检查不认", async () => {
    expect(launcher("start", { AUTOCREW_SERVER_SCRIPT: fakeServer(200) }).status).toBe(0);
    fs.writeFileSync(path.join(tmp, "autocrew.launch"), "another-launch\n");
    await expect(realSteps(REPO, port, { serverWasRunning: true, busy: async () => null, machineDir: tmp, healthTimeoutMs: 3_000 }).health(() => {}))
      .rejects.toThrow(/不是这次启动的/);
  }, 30_000);
});
