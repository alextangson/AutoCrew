/** 一键接入 / 断开（onboarding-connect §3，边界 O2–O12）。全程临时 HOME + 假 claude/codex + 假 AutoCrew。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listHostTokens } from "../host-tokens.js";
import { resolveForwarderToken } from "../../../bin/mcp-forwarder.mjs";
import { connectHost, disconnectHost, handshake } from "./connect.js";
import { detectHosts, findClaudeCli } from "./detect.js";
import { classifyClaudeFailure, probeHost } from "./probe.js";
import { makeSandbox, type Sandbox } from "./test-fakes.js";

// 真实配置文件：整套测试前后只 stat（不读内容），证明一个字节没被改
const REAL = [".claude.json", ".codex/config.toml", ".workbuddy/mcp.json"].map((f) => path.join(os.homedir(), f));
const stamp = () => REAL.map((f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return "absent"; } });
let before: string[];
beforeAll(() => { before = stamp(); });
afterAll(() => { expect(stamp()).toEqual(before); });

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox();
  vi.stubEnv("HOME", sb.home);
  vi.stubEnv("AUTOCREW_LOCAL_DIR", sb.dataDir);
});
afterEach(async () => { vi.unstubAllEnvs(); await sb.cleanup(); });

const claudeJson = () => JSON.parse(fs.readFileSync(path.join(sb.home, ".claude.json"), "utf-8")) as { mcpServers?: Record<string, { env: Record<string, string>; args: string[] }> };

describe("沙箱", () => {
  it("所有路径都在临时目录里；用到的 claude/codex 是假的", () => {
    for (const p of [sb.env.home, sb.env.dataDir, sb.env.claudeConfig, sb.env.codexHome, ...sb.env.binDirs]) expect(p.startsWith(os.tmpdir()) || p.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(findClaudeCli(sb.env)?.path).toBe(path.join(sb.bin, "claude"));
  });
});

describe("检测（O2：不花额度）", () => {
  it("什么都没装：三个都是「没找到」，且没调过 claude -p", async () => {
    const empty = await makeSandbox({ claude: false, codex: false });
    try {
      const hosts = await detectHosts(empty.env);
      expect(hosts.map((h) => [h.host, h.found])).toEqual([["claude", false], ["codex", false], ["workbuddy", false]]);
      expect(hosts[0].detail).toContain("装好后回来点一下");
    } finally { await empty.cleanup(); }
  });
  it("找到且登录的排前面；Codex 没登录排在后面；平时不调模型", async () => {
    sb.env.childEnv.FAKE_CODEX_LOGGED = "0";
    fs.mkdirSync(path.join(sb.home, ".workbuddy"));
    const hosts = await detectHosts({ ...sb.env, run: sb.env.runWith(sb.env.childEnv) });
    expect(hosts.map((h) => h.host)).toEqual(["claude", "workbuddy", "codex"]);
    expect(hosts.find((h) => h.host === "codex")).toMatchObject({ found: true, loggedIn: false });
    expect(sb.argv("claude")).toEqual([]);
  });
  it("PATH 上没有 claude 时找桌面版自带的那个，挑版本号最大的", async () => {
    fs.rmSync(path.join(sb.bin, "claude"));
    const base = path.join(sb.home, "Library", "Application Support", "Claude", "claude-code");
    for (const v of ["2.1.9", "2.1.286"]) {
      const f = path.join(base, v, "abc", "claude.app", "Contents", "MacOS", "claude");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 });
    }
    expect(findClaudeCli(sb.env)).toEqual({ path: path.join(base, "2.1.286", "abc", "claude.app", "Contents", "MacOS", "claude"), source: "desktop" });
  });
});

describe("检测登录（O3）", () => {
  it("成功 / 没登录 / 额度 / 网络 / 超时 各有人话", async () => {
    expect(await probeHost("claude", sb.env)).toMatchObject({ ok: true });
    const argv = sb.argv("claude").at(-1)!;
    expect(argv.slice(0, 1)).toEqual(["-p"]);
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    for (const [mode, code] of [["login", "not_logged_in"], ["quota", "quota"], ["net", "network"]] as const) {
      const env = { ...sb.env, run: sb.env.runWith({ ...sb.env.childEnv, FAKE_CLAUDE_PROBE: mode }) };
      expect(await probeHost("claude", env)).toMatchObject({ ok: false, code });
    }
  });
  it("认不出的失败照实给片段", () => {
    expect(classifyClaudeFailure("weird thing happened")).toMatchObject({ ok: false, code: "failed", error: expect.stringContaining("weird") });
  });
});

describe("接上 Claude Code", () => {
  it("用官方命令注册 user scope，令牌不进 Claude 配置，核对真连上才打勾", async () => {
    const r = await connectHost("claude", sb.env);
    expect(r).toMatchObject({ ok: true, registered: true, verified: true, replaced: false });
    const add = sb.argv("claude").find((a) => a[1] === "add")!;
    expect(add.slice(0, 5)).toEqual(["mcp", "add", "--scope", "user", "autocrew"]);
    expect(add).toContain("AUTOCREW_HOST=claude-code");
    expect(add.slice(-2)).toEqual([expect.stringMatching(/bin\/autocrew\.mjs$/), "mcp"]);
    const entry = claudeJson().mcpServers!.autocrew;
    expect(entry.env.AUTOCREW_HOST).toBe("claude-code");
    const token = fs.readFileSync(path.join(sb.dataDir, "tokens", "claude-code.token"), "utf-8").trim();
    expect(fs.readFileSync(path.join(sb.home, ".claude.json"), "utf-8")).not.toContain(token);
    expect(listHostTokens(sb.dataDir).find((t) => t.host === "claude-code")?.lastUsedAt).toBeTruthy();
  });

  it("O7：已有用户级 autocrew → 备份后替换，结果里说备份在哪；别的条目不动", async () => {
    fs.writeFileSync(path.join(sb.home, ".claude.json"), JSON.stringify({ mcpServers: { autocrew: { type: "http", url: "http://old" }, other: { command: "x" } } }));
    const r = await connectHost("claude", sb.env);
    expect(r).toMatchObject({ ok: true, replaced: true, verified: true });
    expect(r.message).toContain("已替换原来的 autocrew 配置（备份在");
    expect(r.backup).toBe(path.join(sb.home, ".claude.json.autocrew-bak"));
    expect(JSON.parse(fs.readFileSync(r.backup!, "utf-8")).mcpServers.autocrew.url).toBe("http://old");
    expect(claudeJson().mcpServers!.other).toBeTruthy();
    expect(sb.argv("claude").map((a) => a.slice(0, 2).join(" "))).toEqual(["mcp remove", "mcp add", "mcp list"]);
  });

  it("O8：服务没在运行 → 写进去了但不打勾，给原因", async () => {
    await sb.stopServer();
    const r = await connectHost("claude", sb.env);
    expect(r).toMatchObject({ ok: true, registered: true, verified: false, code: "not_verified" });
    expect(r.error).toContain("连不上");
  });

  it("O10：命令失败 → 可见的失败，原配置没被删", async () => {
    const env = { ...sb.env, run: sb.env.runWith({ ...sb.env.childEnv, FAKE_CLAUDE_ADD_FAIL: "1" }) };
    const r = await connectHost("claude", env);
    expect(r).toMatchObject({ ok: false, registered: false, code: "cli_failed" });
    expect(r.error).toContain("something broke");
  });

  it("O11：没有 claude 命令（也没有桌面版自带的）→ 直写 ~/.claude.json 兜底，先备份，提示新开会话", async () => {
    fs.rmSync(path.join(sb.bin, "claude"));
    fs.mkdirSync(path.join(sb.home, "Applications", "Claude.app"));
    fs.mkdirSync(path.join(sb.home, ".claude"));
    fs.writeFileSync(path.join(sb.home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
    const r = await connectHost("claude", sb.env);
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(r.message).toContain("新开一个会话");
    expect(claudeJson()).toMatchObject({ numStartups: 3, mcpServers: { autocrew: { type: "stdio" } } });
    expect(fs.existsSync(path.join(sb.home, ".claude.json.autocrew-bak"))).toBe(true);
  });

  it("O6：~/.claude.json 坏了 → 拒绝，文件原样", async () => {
    fs.writeFileSync(path.join(sb.home, ".claude.json"), "{ broken");
    const r = await connectHost("claude", sb.env);
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(sb.home, ".claude.json"), "utf-8")).toBe("{ broken");
  });
});

describe("接上 Codex", () => {
  it("codex mcp add 注册 stdio（AUTOCREW_HOST=codex），替换旧的 HTTP 条目并备份，握手核对", async () => {
    fs.mkdirSync(path.join(sb.home, ".codex"));
    fs.writeFileSync(path.join(sb.home, ".codex", "state.json"), JSON.stringify({ autocrew: { command: "old", args: [], env: {} } }));
    fs.writeFileSync(path.join(sb.home, ".codex", "config.toml"), '[mcp_servers.autocrew]\nurl = "http://127.0.0.1:4317/mcp"\n');
    const r = await connectHost("codex", sb.env);
    expect(r).toMatchObject({ ok: true, verified: true, replaced: true });
    expect(fs.readFileSync(path.join(sb.home, ".codex", "config.toml.autocrew-bak"), "utf-8")).toContain("4317");
    const add = sb.argv("codex").find((a) => a[1] === "add")!;
    expect(add.slice(0, 3)).toEqual(["mcp", "add", "autocrew"]);
    expect(add[add.indexOf("--env") + 1]).toBe("AUTOCREW_HOST=codex");
  });
  it("没登录 → 不写配置，说怎么登录", async () => {
    const env = { ...sb.env, run: sb.env.runWith({ ...sb.env.childEnv, FAKE_CODEX_LOGGED: "0" }) };
    const r = await connectHost("codex", env);
    expect(r).toMatchObject({ ok: false, code: "not_logged_in" });
    expect(r.error).toContain("codex login");
    expect(sb.argv("codex").some((a) => a[1] === "add")).toBe(false);
  });
});

describe("接上 WorkBuddy", () => {
  it("没装 → 说装好后回来；装了 → 合并 mcp.json 并握手核对", async () => {
    expect(await connectHost("workbuddy", sb.env)).toMatchObject({ ok: false, code: "not_installed" });
    fs.mkdirSync(path.join(sb.home, "Applications", "WorkBuddy.app"));
    const r = await connectHost("workbuddy", sb.env);
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(r.message).toContain("重启 WorkBuddy");
  });
});

describe("断开（O9）", () => {
  it("删条目（先备份）+ 撤令牌；撤后转发器拿不到令牌、也不回落到 server-token", async () => {
    await connectHost("claude", sb.env);
    fs.writeFileSync(path.join(sb.dataDir, "server-token"), "legacy\n");
    const r = await disconnectHost("claude", sb.env);
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toContain("令牌已撤销");
    expect(claudeJson().mcpServers?.autocrew).toBeUndefined();
    expect(fs.existsSync(path.join(sb.dataDir, "tokens", "claude-code.token"))).toBe(false);
    for (const host of ["claude-code", "codex", "workbuddy"]) {
      expect(resolveForwarderToken(sb.dataDir, { AUTOCREW_HOST: host, AUTOCREW_TOKEN: "inherited" }, host)).toBe("");
    }
    expect(await handshake("claude", sb.env)).toMatch(/拒绝|401/);
  });
  it("Codex 断开走 codex mcp remove", async () => {
    await connectHost("codex", sb.env);
    expect(await disconnectHost("codex", sb.env)).toMatchObject({ ok: true });
    expect(sb.argv("codex").at(-1)).toEqual(["mcp", "remove", "autocrew"]);
    expect(fs.readFileSync(path.join(sb.home, ".codex", "config.toml"), "utf-8")).not.toContain("autocrew");
  });
});

describe("Codex 评审 P2-3：写进去但没核对上，下次检测也不能算接上", () => {
  it("记住每个宿主上一次核对的结果；没连上就是「写进去了但没连上」并带原因", async () => {
    await sb.stopServer();
    await connectHost("claude", sb.env);
    const s = (await detectHosts(sb.env)).find((h) => h.host === "claude")!;
    expect(s.connected).toBe(false);
    expect(s.unverified).toContain("连不上");
  });
  it("核对过的才算接上；断开后状态清掉", async () => {
    await connectHost("claude", sb.env);
    expect((await detectHosts(sb.env)).find((h) => h.host === "claude")).toMatchObject({ connected: true });
    expect((await detectHosts(sb.env)).find((h) => h.host === "claude")?.unverified).toBeUndefined();
    await disconnectHost("claude", sb.env);
    const after = (await detectHosts(sb.env)).find((h) => h.host === "claude")!;
    expect(after.connected).toBe(false);
    expect(after.unverified).toBeUndefined();
  });
});

describe("Codex 评审第 2 轮 P2-c：开工提示按宿主权限（来自 host-policy）", () => {
  it("Codex 是剪辑工位不能写稿；Claude Code / WorkBuddy 能", async () => {
    const hosts = await detectHosts(sb.env);
    expect(Object.fromEntries(hosts.map((h) => [h.host, h.canWrite]))).toEqual({ claude: true, codex: false, workbuddy: true });
  });
});
