/**
 * 离线也能退回（e2e P1-2）：真的 realSteps，npm 换成一个假脚本（模拟 npm ci 先删 node_modules、断网失败），git 只碰临时仓库。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realSteps, runUpdate } from "./updater.js";
import { checkForUpdate } from "./check.js";
import { gitRunner } from "./git.js";

let tmp: string, user: string, machine: string, commit: string, npm: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const read = (rel: string) => fs.readFileSync(path.join(user, rel), "utf-8").trim();

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-deps-"));
  const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d");
  user = path.join(tmp, "u"); machine = path.join(tmp, "m");
  g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(dev, ".gitignore"), "node_modules\nnode_modules.prev-*\ndist\ndist.next\ndist.prev-*\n");
  const rel = (v: string) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json", ".gitignore"); g(dev, "commit", "-q", "-m", v); g(dev, "tag", "-a", `v${v}`, "-m", v); g(dev, "push", "-q", "origin", "main", "--tags"); };
  rel("0.4.0"); g(tmp, "clone", "-q", origin, user); rel("0.5.0");
  fs.mkdirSync(machine);
  for (const d of ["node_modules", "frontend/node_modules", "frontend/dist"]) {
    fs.mkdirSync(path.join(user, d), { recursive: true });
    fs.writeFileSync(path.join(user, d, "marker"), "old");
  }
  await checkForUpdate(user, machine, { git: gitRunner(user) });
  commit = g(user, "rev-parse", "v0.5.0^{commit}");
  npm = path.join(tmp, "fake-npm.sh");
  // npm ci 先删 node_modules（真 npm 也是这样），断网标记在就失败；run build 产出 dist.next
  fs.writeFileSync(npm, `#!/bin/sh
case "$1" in
  ci) rm -rf node_modules; if [ -f "${path.join(tmp, "offline")}" ]; then echo "npm ERR! network ENOTFOUND" >&2; exit 1; fi; mkdir -p node_modules; echo new > node_modules/marker ;;
  run) mkdir -p dist.next; echo new > dist.next/marker ;;
esac
`, { mode: 0o755 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const job = () => ({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user),
  steps: realSteps(user, 1, { serverWasRunning: false, busy: async () => null, npm }), logFile: path.join(machine, "u.log") });
const prevDirs = () => [...fs.readdirSync(user), ...fs.readdirSync(path.join(user, "frontend"))].filter((f) => f.includes(".prev-"));

describe("装依赖前留一份旧的，退回不靠网络", () => {
  it("断网：npm ci 失败 → 退回旧版本，旧依赖与旧前端原样换回，没有一步需要网络", async () => {
    fs.writeFileSync(path.join(tmp, "offline"), "");
    const r = await runUpdate(job());
    expect(r).toMatchObject({ ok: false, outcome: "rolled_back" });
    expect(read("node_modules/marker")).toBe("old");
    expect(read("frontend/node_modules/marker")).toBe("old");
    expect(read("frontend/dist/marker")).toBe("old");
    expect(g(user, "rev-parse", "HEAD")).not.toBe(commit);
    expect(prevDirs()).toEqual([]);
  });

  it("成功：新依赖、新前端换上；留着的旧目录在健康检查之后删掉；用的是 --prefer-offline", async () => {
    const r = await runUpdate(job());
    expect(r).toMatchObject({ ok: true });
    expect(read("node_modules/marker")).toBe("new");
    expect(read("frontend/dist/marker")).toBe("new");
    expect(prevDirs()).toEqual([]);
    expect(fs.readFileSync(path.join(machine, "u.log"), "utf-8")).toContain("--prefer-offline");
  });

  it("退回也失败：手动恢复命令用留着的旧依赖换回，不需要网络", async () => {
    fs.writeFileSync(path.join(tmp, "offline"), "");
    const steps = realSteps(user, 1, { serverWasRunning: false, busy: async () => null, npm });
    const r = await runUpdate({ ...job(), steps: { ...steps, restore: async () => { throw new Error("换回失败"); } } });
    expect(r).toMatchObject({ outcome: "stuck" });
    expect(r.manualCommands?.join("\n")).toMatch(/mv "node_modules\.prev-\d+" "node_modules"/);
    expect(r.manualCommands?.join("\n")).not.toContain("npm ci");
  });
});
