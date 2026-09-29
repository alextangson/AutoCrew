/** 本机 Codex 后端（阶段 2）：启动参数、减负、审批强制、认证失败认法 */
import { describe, expect, it } from "vitest";
import { pickPermissionOption } from "./backends.js";
import { CODEX_ADAPTER, codexArgs, codexLaunch, codexMcpNames } from "./codex-adapter.js";

const TOML = `model = "gpt-6-astra"
model_provider = "openai_http_fallback"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.openai_http_fallback]
base_url = "https://chatgpt.com/backend-api/codex"

[mcp_servers.node_repl]
command = "x"

[mcp_servers.node_repl.env]
FOO = "1"

[mcp_servers.computer-use]
command = "y"

[mcp_servers.autocrew]
url = "http://127.0.0.1:4317/mcp"

[mcp_servers."chatcut"]
command = "z"
`;

describe("Codex 启动参数（不改创始人的 config.toml，只用 -c 覆盖）", () => {
  it("强制每次问 + 工作区沙箱，压过全局的 never / danger-full-access", () => {
    const args = codexArgs(TOML);
    expect(args).toContain('approval_policy="untrusted"');
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args.filter((a) => a === "-c").length * 2).toBe(args.length);
  });
  it("减负：config 里每个 MCP 都关掉（含创始人配的 autocrew，本会话的由 ACP 另挂）；子表不误认；插件类功能关掉", () => {
    expect(codexMcpNames(TOML)).toEqual(["node_repl", "computer-use", "autocrew", "chatcut"]);
    const args = codexArgs(TOML);
    expect(args).toContain("mcp_servers.node_repl.enabled=false");
    expect(args).toContain("mcp_servers.chatcut.enabled=false");
    expect(args).toContain("mcp_servers.autocrew.enabled=false");
    expect(args.join(" ")).not.toContain("node_repl.env");
    for (const f of ["apps", "plugins", "chronicle", "memories", "computer_use"]) expect(args).toContain(`features.${f}=false`);
    // 登录与模型提供方不碰
    expect(args.join(" ")).not.toMatch(/model_provider|auth/);
  });
  it("没有 config.toml 也能起；适配器没装 → 不可用（X8 / 边界 1）", () => {
    expect(codexLaunch("/nonexistent/config.toml", "/fake/codex-acp.js")?.args.slice(0, 1)).toEqual(["/fake/codex-acp.js"]);
    expect(codexLaunch("/nonexistent/config.toml", null)).toBeNull();
  });
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
    expect(CODEX_ADAPTER.isOwnMcpCall!({ command: "rm -rf" })).toBe(false);
  });
  it("认证失败的认法与修法", () => {
    expect(CODEX_ADAPTER.isAuthError("401 Unauthorized: token expired")).toBe(true);
    expect(CODEX_ADAPTER.isAuthError("Failed to authenticate")).toBe(true);
    expect(CODEX_ADAPTER.isAuthError("model not found")).toBe(false);
    expect(CODEX_ADAPTER.loginFix).toContain("codex login");
  });
});
