/**
 * 第 12 轮评审（Claude 代 Codex）：每条一个修之前会失败的用例。git 只碰临时仓库；装 / 建 / 重启全是假的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkForUpdate } from "./check.js";
import { gitRunner } from "./git.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review12-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

describe("P2 发布 tag 被重新指向", () => {
  it("用户本地留着旧 tag：检查照常成功，目标是 origin 现在指向的提交", async () => {
    const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), machine = path.join(tmp, "m");
    g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    const commit = (v: string) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json"); g(dev, "commit", "-q", "-m", v); };
    commit("0.4.0"); g(dev, "tag", "-a", "v0.4.0", "-m", "x"); g(dev, "push", "-q", "origin", "main", "--tags");
    g(tmp, "clone", "-q", origin, user);
    commit("0.5.0"); g(dev, "tag", "-a", "v0.5.0", "-m", "first"); g(dev, "push", "-q", "origin", "main", "--tags");
    g(user, "fetch", "-q", "--tags", "origin"); // 用户已经拉过第一版 v0.5.0
    fs.writeFileSync(path.join(dev, "CHANGELOG.md"), "fixed\n"); g(dev, "add", "CHANGELOG.md"); g(dev, "commit", "-q", "-m", "fix notes");
    g(dev, "tag", "-f", "-a", "v0.5.0", "-m", "second"); g(dev, "push", "-q", "-f", "origin", "main", "--tags");
    fs.mkdirSync(machine);
    const s = await checkForUpdate(user, machine, { git: gitRunner(user) });
    expect(s.error).toBeUndefined();
    expect(s).toMatchObject({ available: true, tag: "v0.5.0", commit: g(dev, "rev-parse", "v0.5.0^{commit}") });
  });
});
