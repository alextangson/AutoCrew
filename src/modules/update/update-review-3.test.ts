/**
 * Codex 审第 3 轮的三条（P1×2 + P2）：每条一个修之前会失败的用例。
 * git 只碰临时仓库；装 / 建 / 重启全是假的；MCP 用进程内的 handleMcpRequest，不起服务。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QuiesceError, runUpdate, type UpdateSteps } from "./updater.js";
import { checkForUpdate, programRoot } from "./check.js";
import { gitRunner } from "./git.js";
import { acquireLock, releaseLock, UPDATING_MESSAGE } from "./preflight.js";
import { resetActiveWork } from "./active-work.js";
import { isLongRunningTool, LONG_RUNNING_CHANNELS } from "./long-running.js";
import { parseChangelog } from "./changelog.js";
import { handleMcpRequest } from "../../../mcp/server.js";

let tmp: string;
const prev = process.env.AUTOCREW_LOCAL_DIR;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-upd-review3-")); process.env.AUTOCREW_LOCAL_DIR = tmp; resetActiveWork(); });
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

async function setup() {
  const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), machine = path.join(tmp, "m");
  g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
  const rel = (v: string) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json"); g(dev, "commit", "-q", "-m", v); g(dev, "tag", "-a", `v${v}`, "-m", v); g(dev, "push", "-q", "origin", "main", "--tags"); };
  rel("0.4.0"); g(tmp, "clone", "-q", origin, user); rel("0.5.0");
  fs.mkdirSync(machine);
  await checkForUpdate(user, machine, { git: gitRunner(user) });
  return { user, machine, old: g(user, "rev-parse", "HEAD"), commit: g(user, "rev-parse", "v0.5.0^{commit}") };
}

describe("P1 新版没起来：退回要把旧版启动起来", () => {
  it("健康检查失败、服务已经不在：代码退回，不问忙不忙，直接启动旧版，结果看得见", async () => {
    const { user, machine, old, commit } = await setup();
    const calls: string[] = [];
    let healths = 0;
    const steps: UpdateSteps = {
      install: async () => { calls.push("install"); }, build: async () => { calls.push("build"); },
      // 服务不在时问忙不忙会一直问不到 → 旧实现把它当「忙」，旧版永远不启动
      quiesce: async () => { calls.push("quiesce"); if (calls.includes("restart")) throw new QuiesceError("没法确认是否空闲（问不到服务）"); },
      serviceDown: async () => true,
      restart: async () => { calls.push("restart"); },
      health: async () => { calls.push("health"); if (++healths === 1) throw new Error("服务 60 秒内没回来"); },
    };
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(machine, "u.log") });
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
    expect(calls).toEqual(["install", "build", "quiesce", "restart", "health", "install", "build", "restart", "health"]);
    expect(r).toMatchObject({ ok: false, outcome: "rolled_back" });
    expect(r.message).toMatch(/更新失败，已退回 0\.4\.0，原因：服务 60 秒内没回来/);
  });

  it("服务还在、而且说忙：照样不重启", async () => {
    const { user, machine, commit } = await setup();
    const calls: string[] = [];
    let installs = 0;
    const steps: UpdateSteps = {
      install: async () => { calls.push("install"); if (++installs === 1) throw new Error("npm ci 坏了"); }, build: async () => { calls.push("build"); },
      quiesce: async () => { calls.push("quiesce"); throw new QuiesceError("有 1 个任务正在跑"); },
      serviceDown: async () => false,
      restart: async () => { calls.push("restart"); }, health: async () => { calls.push("health"); },
    };
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(machine, "u.log") });
    expect(calls).not.toContain("restart");
    expect(r.message).toContain("服务没有重启（有任务在跑）");
  });
});

describe("P1 宿主走 /mcp 的长动作也算在跑", () => {
  it("更新锁在手：MCP 上的改写 / 发布推送回「正在更新，稍后再试」，不执行", async () => {
    expect(acquireLock(tmp, "t")).toBe(true);
    for (const [name, args] of [["autocrew_rewrite", { content_id: "content-1-a" }], ["autocrew_publish", { action: "wechat_mp_draft", content_id: "content-1-a" }]] as const) {
      const r = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } as never, undefined, path.join(tmp, "lib"));
      const result = (r as { result: { structuredContent?: { code?: string; error?: string }; isError?: boolean } }).result;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "updating", error: UPDATING_MESSAGE });
    }
    releaseLock(tmp, "t");
  });

  it("两张表对得上：工作台的长通道在 MCP 上的同类动作也在表里", () => {
    const pairs: Array<[string, string, string]> = [
      ["publish:wechat_draft", "autocrew_publish", "wechat_mp_draft"],
      ["publish:digest", "autocrew_publish", "digest"],
      ["style:distill", "autocrew_style", "distill"],
      ["style:absorb", "autocrew_style", "absorb_samples"],
      ["radar:refresh", "autocrew_research", "discover"],
      ["draft:rewrite_selection", "autocrew_rewrite", "x"],
    ];
    for (const [ch, tool, action] of pairs) {
      expect(LONG_RUNNING_CHANNELS.has(ch), ch).toBe(true);
      expect(isLongRunningTool(tool, action), `${tool} ${action}`).toBe(true);
    }
    expect(isLongRunningTool("autocrew_publish", "check")).toBe(false);
    expect(isLongRunningTool("autocrew_status", undefined)).toBe(false);
  });
});

describe("P2 更新记录里的格式示例不是发布记录", () => {
  it("仓库里现在的 CHANGELOG.md 解析出 0 个版本", () => {
    expect(parseChangelog(fs.readFileSync(path.join(programRoot(), "CHANGELOG.md"), "utf-8"))).toEqual([]);
  });

  it("代码块里的示例跳过，块外的真记录照读", () => {
    const md = "# 记录\n\n```\n## 0.5.0 · 2026-10-01\n\n### 新东西\n\n- 示例\n```\n\n## 0.6.0 · 2026-10-09\n\n### 需要你做的\n\n- 真的\n";
    expect(parseChangelog(md)).toEqual([{ version: "0.6.0", date: "2026-10-09", news: [], fixes: [], todo: ["真的"] }]);
  });
});
