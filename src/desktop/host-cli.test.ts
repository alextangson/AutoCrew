/**
 * `autocrew host`（P3 §7.1）：钥匙只以路径出现，Codex 那一行必须能原样粘。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostInstructions } from "./host-cli.js";

/** 32 字节 token 的十六进制形态——输出里出现它就是泄漏。 */
const TOKEN_VALUE = /[a-f0-9]{64}/;

let dataDir: string;

function booted(): string {
  writeFileSync(path.join(dataDir, "server-token"), "server-token-value\n");
  return dataDir;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "autocrew-host-cli-"));
});

describe("autocrew host", () => {
  it("prints the exact codex registration line and never the token value", () => {
    const out = hostInstructions("codex", { dataDir: booted(), port: 4317 });
    expect(out).toContain(
      "codex mcp add autocrew --url http://127.0.0.1:4317/mcp --bearer-token-env-var AUTOCREW_MCP_TOKEN",
    );
    expect(out).toContain("export AUTOCREW_MCP_TOKEN=$(cat ");
    expect(out).toContain(path.join("tokens", "codex.token"));
    expect(out).not.toMatch(TOKEN_VALUE);
  });

  it("warns that codex exec cancels tool calls without the bypass flag", () => {
    const out = hostInstructions("codex", { dataDir: booted() });
    expect(out).toContain("codex exec");
    expect(out).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("tells Claude Code it is already wired to the forwarder", () => {
    const out = hostInstructions("claude-code", { dataDir: booted() });
    expect(out).toContain(".mcp.json");
    expect(out).toContain("bin/autocrew.mjs mcp");
    expect(out).not.toMatch(TOKEN_VALUE);
  });

  it("points dsh at its own README", () => {
    const out = hostInstructions("dsh", { dataDir: booted() });
    expect(out).toContain("adapters/dsh/README.md");
    expect(out).not.toMatch(TOKEN_VALUE);
  });

  it("asks for npm start when the server has never run", () => {
    const out = hostInstructions("codex", { dataDir });
    expect(out).toContain("npm start");
    expect(out).not.toContain("codex mcp add");
  });

  it("defers persona files to the next slice and rejects unknown hosts", () => {
    expect(hostInstructions("codex", { dataDir: booted(), dir: "/tmp/ws" })).toContain("人设文件写入将在下一版提供");
    expect(hostInstructions("gemini", { dataDir: booted() })).toContain("未知宿主");
  });

  it("shows the token path as ~/… when it lives under home", () => {
    const home = path.dirname(booted());
    expect(hostInstructions("codex", { dataDir, home })).toContain(`~${path.sep}${path.basename(dataDir)}`);
  });
});
