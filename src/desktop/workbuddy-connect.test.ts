/** WorkBuddy 反向接入（spec W1–W8）——全部在临时 HOME 里，绝不碰真的 ~/.workbuddy */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostPolicy, hostListsTool, ADOPTION_HOST_DENIED } from "../../mcp/host-policy.js";
import { KNOWN_HOSTS } from "./host-cli.js";
import { lookupHostToken, revokeHostToken } from "./host-tokens.js";
import { autocrewEntry, connectWorkbuddy, mergeWorkbuddyMcp, stableNodePath, workbuddyInstalled, workbuddyPrompt } from "./workbuddy-connect.js";
import { forwardMessage, resolveForwarderToken } from "../../bin/mcp-forwarder.mjs";

let home: string;
let dataDir: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-home-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-data-"));
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
const file = () => path.join(home, ".workbuddy", "mcp.json");
const entry = autocrewEntry("/repo", "/usr/bin/node");

describe("WorkBuddy 接入：mcp.json 合并", () => {
  it("W2 不存在：新建，只含 autocrew 一条", () => {
    expect(mergeWorkbuddyMcp(home, entry)).toMatchObject({ ok: true, outcome: "created" });
    expect(JSON.parse(fs.readFileSync(file(), "utf-8"))).toEqual({ mcpServers: { autocrew: entry } });
  });
  it("W3 已有别的条目：只合并 autocrew，别的原样保留；写前备份", () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const before = { mcpServers: { chatcut_desktop: { command: "/x/chatcut-mcp", env: { K: "v" } } }, other: 1 };
    fs.writeFileSync(file(), JSON.stringify(before));
    expect(mergeWorkbuddyMcp(home, entry)).toMatchObject({ ok: true, outcome: "added" });
    const after = JSON.parse(fs.readFileSync(file(), "utf-8"));
    expect(after.mcpServers.chatcut_desktop).toEqual(before.mcpServers.chatcut_desktop);
    expect(after.other).toBe(1);
    expect(JSON.parse(fs.readFileSync(`${file()}.autocrew-bak`, "utf-8"))).toEqual(before);
  });
  it("W4 解析失败：不写、报错说在哪、绝不覆盖", () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{\n  "mcpServers": {\n    "x": { "secret": "sk-123", }\n}');
    const r = mergeWorkbuddyMcp(home, entry);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/第 \d+ 行附近/);
    expect(!r.ok && r.error).not.toContain("sk-123");
    expect(fs.readFileSync(file(), "utf-8")).toContain("sk-123");
    expect(fs.existsSync(`${file()}.autocrew-bak`)).toBe(false);
  });
  it("W5 已有 autocrew：原地更新成当前路径，不重复加", () => {
    mergeWorkbuddyMcp(home, autocrewEntry("/old/place", "/usr/bin/node"));
    expect(mergeWorkbuddyMcp(home, entry)).toMatchObject({ ok: true, outcome: "updated" });
    const after = JSON.parse(fs.readFileSync(file(), "utf-8"));
    expect(Object.keys(after.mcpServers)).toEqual(["autocrew"]);
    expect(after.mcpServers.autocrew.args[0]).toBe("/repo/bin/autocrew.mjs");
    expect(after.mcpServers.autocrew.env).toEqual({ AUTOCREW_HOST: "workbuddy" });
  });
});

describe("WorkBuddy 接入：连接动作与宿主身份", () => {
  it("W1 没装：不写、说没找到；装了：发令牌 + 合并 + 提示重启（W6）", () => {
    expect(connectWorkbuddy({ home, dataDir, installed: false, entry })).toMatchObject({ ok: false, error: expect.stringContaining("没找到 WorkBuddy") });
    expect(fs.existsSync(file())).toBe(false);
    const r = connectWorkbuddy({ home, dataDir, installed: true, entry });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("重启 WorkBuddy 后生效") });
    expect(fs.existsSync(path.join(dataDir, "tokens", "workbuddy.token"))).toBe(true);
    expect(workbuddyInstalled(["/nonexistent/WorkBuddy.app"])).toBe(false);
  });
  it("W7 撤销：转发器只认 workbuddy 的令牌，撤销后不回落到本机全能令牌", () => {
    connectWorkbuddy({ home, dataDir, installed: true, entry });
    fs.writeFileSync(path.join(dataDir, "server-token"), "local-all-powerful");
    const env = { AUTOCREW_HOST: "workbuddy" };
    const token = resolveForwarderToken(dataDir, env);
    expect(token).not.toBe("local-all-powerful");
    expect(lookupHostToken(token, dataDir)).toBe("workbuddy");
    revokeHostToken("workbuddy", dataDir);
    expect(resolveForwarderToken(dataDir, env)).toBe("");
    // 没点名宿主的老路径（Claude Code 的 .mcp.json）照旧回落
    expect(resolveForwarderToken(dataDir, {})).toBe("local-all-powerful");
  });
  it("权限同 claude-code：不限工具，但采纳硬拒照旧", () => {
    expect(KNOWN_HOSTS).toContain("workbuddy");
    expect(hostPolicy("workbuddy", "autocrew_writer", { action: "submit" })).toEqual({ ok: true });
    expect(hostPolicy("workbuddy", "autocrew_content", { action: "adoption" })).toEqual({ ok: false, error: ADOPTION_HOST_DENIED });
    expect(hostListsTool("workbuddy", "autocrew_desk")).toBe(true);
  });
  it("条目里的 node 用稳定路径：软链指向同一个可执行文件就用软链，否则用原路径", () => {
    const real = path.join(home, "node-26.5.0");
    fs.writeFileSync(real, "");
    const link = path.join(home, "node");
    fs.symlinkSync(real, link);
    expect(stableNodePath(real, [link])).toBe(link);
    expect(stableNodePath(real, ["/nonexistent/node"])).toBe(real);
  });
  it("复制给 WorkBuddy 的那句话是创始人认过的措辞", () => {
    expect(workbuddyPrompt("FDE 会消失", "content-1-a")).toBe("通过 autocrew MCP 调用 autocrew_content summary 查看《FDE 会消失》（id: content-1-a），总结这篇现在在哪一步、卡在哪，然后等我指示，先不要改任何东西。");
  });
});

describe("W7 撤销后的提示按宿主", () => {
  it("401 提示「重新执行 autocrew host workbuddy」", async () => {
    const r = await forwardMessage({ jsonrpc: "2.0", id: 1, method: "ping" }, { url: "http://x", token: "t", host: "workbuddy", fetchImpl: async () => new Response("", { status: 401 }) });
    expect(JSON.stringify(r)).toContain("autocrew host workbuddy");
  });
});

describe("评审 WorkBuddy P1-3 / P2-6 / P2-7 / P2-9 / P2-8", () => {
  it("P1-3：0600 的 mcp.json 写完还是 0600，备份也不放宽；新建的文件是 0600", () => {
    mergeWorkbuddyMcp(home, entry);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    fs.chmodSync(file(), 0o600);
    mergeWorkbuddyMcp(home, entry);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${file()}.autocrew-bak`).mode & 0o777).toBe(0o600);
    fs.chmodSync(file(), 0o640);
    mergeWorkbuddyMcp(home, entry);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o640);
  });
  it("P2-6：mcp.json 或备份是软链接 → 拒绝，不跟着链接写", () => {
    const victim = path.join(home, "victim.txt");
    fs.writeFileSync(victim, "untouched");
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.symlinkSync(victim, file());
    expect(mergeWorkbuddyMcp(home, entry)).toMatchObject({ ok: false });
    expect(fs.readFileSync(victim, "utf-8")).toBe("untouched");
    fs.rmSync(file());
    fs.writeFileSync(file(), "{}");
    fs.symlinkSync(victim, `${file()}.autocrew-bak`);
    expect(mergeWorkbuddyMcp(home, entry)).toMatchObject({ ok: false });
    expect(fs.readFileSync(victim, "utf-8")).toBe("untouched");
    expect(fs.readdirSync(path.dirname(file())).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("P2-7：读到换名之间文件被 WorkBuddy 改了 → 不覆盖它的改动，报错", () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    const r = mergeWorkbuddyMcp(home, entry, { beforeRename: () => fs.writeFileSync(file(), JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "new" } } })) });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("改过了") });
    expect(JSON.parse(fs.readFileSync(file(), "utf-8")).mcpServers.b).toEqual({ command: "new" });
    expect(fs.readdirSync(path.dirname(file())).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("P2-9：守护进程跑在别的端口 / 状态目录时，条目里带上它们", () => {
    const e = autocrewEntry("/repo", "/usr/bin/node", { AUTOCREW_PORT: "4327", AUTOCREW_LOCAL_DIR: "/data" });
    expect(e.env).toEqual({ AUTOCREW_HOST: "workbuddy", AUTOCREW_PORT: "4327", AUTOCREW_LOCAL_DIR: "/data" });
    expect(autocrewEntry("/repo", "/usr/bin/node", {}).env).toEqual({ AUTOCREW_HOST: "workbuddy" });
  });
  it("P2-8：点名宿主时继承来的 AUTOCREW_TOKEN 不作数；Claude Code 的老路径（没点名）照旧优先用它", () => {
    connectWorkbuddy({ home, dataDir, installed: true, entry });
    revokeHostToken("workbuddy", dataDir);
    expect(resolveForwarderToken(dataDir, { AUTOCREW_HOST: "workbuddy", AUTOCREW_TOKEN: "generic" })).toBe("");
    expect(resolveForwarderToken(dataDir, { AUTOCREW_TOKEN: "generic" })).toBe("generic");
  });
});
