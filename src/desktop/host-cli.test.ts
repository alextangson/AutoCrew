/**
 * `autocrew host`（P3 §7.1）：钥匙只以路径出现，Codex 那一行必须能原样粘。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostInstructions, PERSONA_END, PERSONA_START } from "./host-cli.js";

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

  it("rejects unknown hosts", () => {
    expect(hostInstructions("gemini", { dataDir: booted() })).toContain("未知宿主");
  });

  it("shows the token path as ~/… when it lives under home", () => {
    const home = path.dirname(booted());
    expect(hostInstructions("codex", { dataDir, home })).toContain(`~${path.sep}${path.basename(dataDir)}`);
  });
});

/**
 * `--dir`（P3 §7.1）：人设写进工作目录的 AGENTS.md / CLAUDE.md，
 * **永远只动定界符之间那一段**——用户自己的约定比我们这一段重要。
 */
describe("autocrew host --dir", () => {
  let ws: string;
  let personaDir: string;

  beforeEach(() => {
    ws = mkdtempSync(path.join(os.tmpdir(), "autocrew-host-ws-"));
    personaDir = mkdtempSync(path.join(os.tmpdir(), "autocrew-host-persona-"));
    writeFileSync(path.join(personaDir, "AGENTS.editor-writer.md"), "# 总编辑 + 写手\n\n先看 status。\n");
    writeFileSync(path.join(personaDir, "AGENTS.cover.md"), "# 封面师\n\n只做 3:4 与 4:3。\n");
  });

  it("creates AGENTS.md for codex with the default editor-writer persona", () => {
    const out = hostInstructions("codex", { dataDir: booted(), dir: ws, personaDir });
    const file = path.join(ws, "AGENTS.md");
    expect(readFileSync(file, "utf-8")).toBe(`${PERSONA_START}\n# 总编辑 + 写手\n\n先看 status。\n${PERSONA_END}\n`);
    expect(out).toContain("已新建");
    expect(out).toContain(file);
  });

  it("writes CLAUDE.md for claude-code and honours --role cover", () => {
    hostInstructions("claude-code", { dataDir: booted(), dir: ws, role: "cover", personaDir });
    expect(readFileSync(path.join(ws, "CLAUDE.md"), "utf-8")).toContain("只做 3:4 与 4:3。");
    expect(existsSync(path.join(ws, "AGENTS.md"))).toBe(false);
  });

  it("appends to an existing file without touching a single character of it", () => {
    const file = path.join(ws, "AGENTS.md");
    writeFileSync(file, "# 我自己的约定\n\n提交前跑 lint。\n");
    const out = hostInstructions("codex", { dataDir: booted(), dir: ws, personaDir });
    const text = readFileSync(file, "utf-8");
    expect(text.startsWith("# 我自己的约定\n\n提交前跑 lint。\n")).toBe(true);
    expect(text).toContain(PERSONA_START);
    expect(out).toContain("已追加");
  });

  it("replaces only the delimited section on a rerun", () => {
    const file = path.join(ws, "AGENTS.md");
    writeFileSync(file, `头部约定\n\n${PERSONA_START}\n旧人设\n${PERSONA_END}\n\n尾部约定\n`);
    const out = hostInstructions("codex", { dataDir: booted(), dir: ws, personaDir });
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("头部约定");
    expect(text).toContain("尾部约定");
    expect(text).not.toContain("旧人设");
    expect(text).toContain("先看 status。");
    expect(out).toContain("已更新定界符里那一段");
  });

  it("is idempotent: two runs leave exactly one section", () => {
    hostInstructions("codex", { dataDir: booted(), dir: ws, personaDir });
    hostInstructions("codex", { dataDir: booted(), dir: ws, personaDir });
    const text = readFileSync(path.join(ws, "AGENTS.md"), "utf-8");
    expect(text.split(PERSONA_START)).toHaveLength(2);
  });

  it("reports a bad --role instead of writing a wrong persona", () => {
    const out = hostInstructions("codex", { dataDir: booted(), dir: ws, role: "editor", personaDir });
    expect(out).toContain("--role editor 不认识");
    expect(existsSync(path.join(ws, "AGENTS.md"))).toBe(false);
  });

  it("tells dsh its persona lives in the preset and writes nothing", () => {
    const out = hostInstructions("dsh", { dataDir: booted(), dir: ws, personaDir });
    expect(out).toContain("agent.cordis.yml");
    expect(existsSync(path.join(ws, "AGENTS.md"))).toBe(false);
  });

  it("surfaces a failure instead of silently skipping the write", () => {
    const asFile = path.join(ws, "not-a-dir");
    writeFileSync(asFile, "x");
    const out = hostInstructions("codex", { dataDir: booted(), dir: asFile, personaDir });
    expect(out).toContain("人设没写成");
    expect(out).toContain("--dir 必须是目录");
  });

  it("ships both persona templates in adapters/codex (default persona dir)", () => {
    const out = hostInstructions("codex", { dataDir: booted(), dir: ws });
    expect(out).not.toContain("人设没写成");
    expect(readFileSync(path.join(ws, "AGENTS.md"), "utf-8")).toContain("AutoCrew 总编辑 + 写手");
  });
});
