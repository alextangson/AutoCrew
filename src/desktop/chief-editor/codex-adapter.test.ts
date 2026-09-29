/** 本机 Codex 后端（阶段 2）：启动参数、减负、审批与沙箱强制、配置解析、认证失败认法 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pickPermissionOption } from "./backends.js";
import { CODEX_ADAPTER, codexArgs, codexHome, codexLaunch, codexMcpNames } from "./codex-adapter.js";
import { makeHarness, type Harness } from "./fake-agent.test-helper.js";
import { runLocalTurn } from "./turn.js";

const TOML = `model = "gpt-6-astra"
model_provider = "openai_http_fallback"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[sandbox_workspace_write]
writable_roots = ["/"]
network_access = true

[model_providers.openai_http_fallback]
base_url = "https://chatgpt.com/backend-api/codex"

[mcp_servers.node_repl]
command = "x"

[mcp_servers.node_repl.env]
FOO = "1"

  [mcp_servers.indented] # 带缩进和行尾注释的表头
  command = "i"

[mcp_servers.autocrew]
url = "http://127.0.0.1:4317/mcp"

[mcp_servers."chatcut"]
command = "z"
`;
const argsOf = (toml: string) => { const r = codexArgs(toml); if ("error" in r) throw new Error(r.error); return r.args; };

describe("Codex 启动参数（不改创始人的 config.toml，只用 -c 覆盖）", () => {
  it("强制每次问 + 工作区沙箱；钉死沙箱子设置：只有工作目录可写、shell 不联网（评审 P1-1）", () => {
    const args = argsOf(TOML);
    for (const o of ['approval_policy="untrusted"', 'sandbox_mode="workspace-write"', "sandbox_workspace_write.writable_roots=[]", "sandbox_workspace_write.network_access=false"]) expect(args).toContain(o);
    expect(args.filter((a) => a === "-c").length * 2).toBe(args.length);
  });
  it("用真的 TOML 解析：缩进 / 注释表头、带引号的名字、子表都认对；每个都关掉（含创始人配的 autocrew）（评审 P1-2）", () => {
    expect(codexMcpNames(TOML).sort()).toEqual(["autocrew", "chatcut", "indented", "node_repl"]);
    const args = argsOf(TOML);
    for (const n of ["node_repl", "indented", "autocrew", "chatcut"]) expect(args).toContain(`mcp_servers.${n}.enabled=false`);
    expect(args.join(" ")).not.toContain("node_repl.env");
    for (const f of ["apps", "plugins", "chronicle", "memories", "computer_use"]) expect(args).toContain(`features.${f}=false`);
    expect(args.join(" ")).not.toMatch(/model_provider|auth/);
  });
  it("内联表写法的 mcp_servers 也认（评审 P1-2）", () => {
    expect(codexMcpNames('mcp_servers = { a = { command = "x" }, b-2 = { url = "y" } }').sort()).toEqual(["a", "b-2"]);
  });
  it("名字带点 / 空格：关不掉就拒绝起 Codex，说清原因（评审 P2-4）", () => {
    const r = codexArgs('[mcp_servers."foo.bar"]\ncommand = "x"\n');
    expect(r).toMatchObject({ error: expect.stringContaining("foo.bar") });
  });
  it("config.toml 读不懂：拒绝起 Codex", () => {
    expect(codexArgs("[mcp_servers.a\ncommand=")).toMatchObject({ error: expect.stringContaining("读不懂") });
  });
});

describe("CODEX_HOME（评审 P2-5）", () => {
  let dir = "";
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  it("扫的是哪个 CODEX_HOME，就把它交给子进程；没配置文件也能起；没装就不可用", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    fs.writeFileSync(path.join(dir, "config.toml"), "[mcp_servers.only_here]\ncommand = \"x\"\n");
    const spec = codexLaunch(dir, "/fake/codex-acp.js")!;
    expect(spec.env).toEqual({ CODEX_HOME: dir });
    expect(spec.args).toContain("mcp_servers.only_here.enabled=false");
    expect(codexLaunch(path.join(dir, "missing"), "/fake/codex-acp.js")?.args[0]).toBe("/fake/codex-acp.js");
    expect(codexLaunch(dir, null)).toBeNull();
    expect(codexHome({ CODEX_HOME: "/x" })).toBe("/x");
  });
});

describe("Codex 形状的配置项（评审 P2-11）", () => {
  let h: Harness;
  afterEach(async () => { await h.cleanup(); });
  it("强度报成 reasoning_effort：切换器能拿到清单，设置也发到 reasoning_effort", async () => {
    h = await makeHarness();
    const orig = h.svc.deps.spawnAgent;
    h.svc.deps.spawnAgent = (l, c, hd) => {
      const a = orig(l, c, hd) as unknown as { configOptions: unknown };
      a.configOptions = [
        { id: "model", current: "gpt-5.5", values: [{ value: "gpt-5.5", label: "GPT-5.5" }] },
        { id: "reasoning_effort", current: "medium", values: [{ value: "medium", label: "Medium" }, { value: "high", label: "High" }] },
      ];
      return a as never;
    };
    const r = await runLocalTurn(h.svc, { message: "hi", backend: "codex", turnId: "t-cx", clientId: "c", dataDir: h.dataDir, newSettings: { effort: "high" } });
    expect(r.ok).toBe(true);
    expect(h.agents[0].configSet).toEqual([["reasoning_effort", "high"]]);
    expect(h.svc.reported.get("codex")?.efforts.map((e) => e.value)).toEqual(["medium", "high"]);
  });
});

describe("Codex 其他差异", () => {
  it("权限选项：Codex 的「总是允许」在适配层滤掉，只选允许一次 / 拒绝一次", () => {
    const opts = [{ optionId: "approved", kind: "allow_once" }, { optionId: "approved-execpolicy-amendment", kind: "allow_always" }, { optionId: "abort", kind: "reject_once" }];
    expect(pickPermissionOption(opts, "allow")).toBe("approved");
    expect(pickPermissionOption(opts, "deny")).toBe("abort");
    expect(pickPermissionOption(opts.slice(1, 2), "allow")).toBeNull();
  });
  it("真机回归：去掉 Codex 夹进正文的模型元数据警告；AutoCrew 自己的 MCP 调用不弹权限卡", () => {
    expect(CODEX_ADAPTER.cleanText!("Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.我先查一下。")).toBe("我先查一下。");
    expect(CODEX_ADAPTER.isOwnMcpCall!({ server_name: "autocrew", tool_name: "autocrew_status" })).toBe(true);
    expect(CODEX_ADAPTER.isOwnMcpCall!({ server_name: "chatcut" })).toBe(false);
  });
  it("认证失败的认法与修法", () => {
    expect(CODEX_ADAPTER.isAuthError("401 Unauthorized: token expired")).toBe(true);
    expect(CODEX_ADAPTER.isAuthError("Failed to authenticate")).toBe(true);
    expect(CODEX_ADAPTER.isAuthError("model not found")).toBe(false);
    expect(CODEX_ADAPTER.loginFix).toContain("codex login");
  });
});
