/**
 * 能力一致性（P3 spec §7.2）——人设里出现的工具名，必须在**那个宿主真的看得见**的工具表里。
 *
 * 这条测试要挡的是总编辑历史 bug 的第一根因：人设许诺一个能力，模型照着调，
 * 工具不存在，于是它开始编。工具名写错一个字母是同一类事故，只是更隐蔽。
 *
 * 三张表：
 * - Claude Code / Codex：全部 MCP 工具（`registerAutocrewCapabilities` 的注册结果）。
 * - dsh：`PORTED_TOOLS`（**import 进来，不许在这里抄一份**——抄的那份迟早和真表分叉）。
 *
 * dsh 那份人设刻意不点任何工具名（见 preset 文件顶部注释），所以它的断言在今天是空跑；
 * 留着是为了以后有人往里加动词时当场被抓。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORTED_TOOLS } from "../../adapters/dsh/src/tools.js";
import { HOST_ROLES } from "../desktop/host-cli.js";
import { registerAutocrewCapabilities } from "../../index.js";
import { createContext } from "../runtime/context.js";
import { EventBus } from "../runtime/events.js";
import { ToolRunner } from "../runtime/tool-runner.js";
import { ADOPTION_HOST_DENIED, hostPolicy } from "../../mcp/host-policy.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 人设/技能文本里的工具名长这样。`~/.autocrew/…` 这类路径没有下划线，不会被误抓。 */
const TOOL_NAME = /autocrew_[a-z_]+/g;

function registeredTools(): Set<string> {
  const runner = new ToolRunner({ ctx: createContext({}), eventBus: new EventBus() });
  registerAutocrewCapabilities(runner);
  return new Set(runner.getTools().map((t) => t.name));
}

/**
 * 只看模型真会照着做的那部分：`## Changelog` 之后是写给人看的，
 * 它必须能点名「这个工具已经退役」——把它算进能力表反而挡住了如实记录。
 */
function personaBody(relativePath: string): string {
  const text = readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
  const cut = text.indexOf("\n## Changelog");
  return cut >= 0 ? text.slice(0, cut) : text;
}

function toolNamesIn(relativePath: string): string[] {
  return [...new Set(personaBody(relativePath).match(TOOL_NAME) ?? [])].sort();
}

const ALL_TOOLS = registeredTools();

/**
 * P3b 的后端半片（`autocrew_desk`）由另一个代理并行落地。它还没注册时不炸这条测试；
 * 一旦注册，下面的断言自动覆盖它——不需要谁记得回来删这一行。
 */
const IN_FLIGHT = new Set(["autocrew_desk"].filter((name) => !ALL_TOOLS.has(name)));

/** Claude Code 与 Codex 都经 MCP 拿到全部工具，所以共用这张表。 */
const HOST_TOOL_FILES: Array<{ file: string; host: string; visible: Set<string> }> = [
  { file: "skills/write-script/SKILL.md", host: "claude-code", visible: ALL_TOOLS },
  { file: "skills/spawn-writer/SKILL.md", host: "claude-code", visible: ALL_TOOLS },
  { file: "skills/research/SKILL.md", host: "claude-code", visible: ALL_TOOLS },
  { file: "skills/cover-generator/SKILL.md", host: "claude-code", visible: ALL_TOOLS },
  { file: "adapters/codex/AGENTS.editor-writer.md", host: "codex", visible: ALL_TOOLS },
  { file: "adapters/codex/AGENTS.cover.md", host: "codex", visible: ALL_TOOLS },
  { file: "adapters/codex/AGENTS.editor.md", host: "codex", visible: ALL_TOOLS },
  { file: "adapters/codex/README.md", host: "codex", visible: ALL_TOOLS },
  {
    file: "adapters/dsh/agent-presets/autocrew/agent.cordis.yml",
    host: "dsh",
    visible: new Set(PORTED_TOOLS),
  },
];

describe("persona ↔ capability consistency", () => {
  it.each(HOST_TOOL_FILES)("$file only names tools visible to $host", ({ file, visible }) => {
    const missing = toolNamesIn(file).filter((name) => !visible.has(name) && !IN_FLIGHT.has(name));
    expect(missing, `${file} 点了这个宿主看不见的工具`).toEqual([]);
  });

  it("keeps the douyin writing skill on autocrew_draft, never autocrew_content save", () => {
    const text = personaBody("skills/write-script/SKILL.md");
    // 2026-10-04 薄路径：抖音口播走 autocrew_draft，定稿只到 prepare_final，「定了」归创始人
    expect(text).toContain("autocrew_draft");
    expect(text).not.toMatch(/autocrew_content[^\n]{0,40}save/);
    expect(text).toMatch(/"action":\s*"prepare_final"/);
  });

  it("keeps research off the retired autocrew_research tool", () => {
    // dsh 审计判定不放行：浏览器适配器拿不到数据时会造 5 条占位选题、然后 ok:true 报成功
    for (const file of ["skills/research/SKILL.md", "skills/spawn-writer/SKILL.md"]) {
      expect(toolNamesIn(file), file).not.toContain("autocrew_research");
    }
    expect(toolNamesIn("skills/research/SKILL.md")).toContain("autocrew_workflow");
  });

  it("keeps Codex covers on the subscription route with honest model provenance", () => {
    const text = personaBody("adapters/codex/AGENTS.cover.md");
    // 人设里提一个不该用的名字，等于把它变成一个可用选项（codex 评审 #14）
    expect(text).not.toContain("generate_ratios");
    expect(text.toLowerCase()).not.toContain("gemini");
    expect(text).toContain("image_gen");
    expect(text).toContain("订阅额度");
    expect(text).toContain('model_requested="Image 2.5"');
    expect(text).toContain("model_reported=null");
    expect(text).toContain("只有用户明确选择另计费 API");
    expect(text).toContain('ratios:["4:3"]');
  });

  /**
   * 剪辑师（P3c §14.2）：`autocrew_video` 必须真的注册，且**不进 dsh**——
   * dsh preset 只放行写作线（§2「封面师、剪辑师只在 Claude Code / Codex 宿主上跑」）。
   */
  it("keeps the editor persona on autocrew_video, and keeps that tool out of dsh", () => {
    const named = toolNamesIn("adapters/codex/AGENTS.editor.md");
    expect(named).toContain("autocrew_video");
    expect(ALL_TOOLS.has("autocrew_video")).toBe(true);
    expect(PORTED_TOOLS).not.toContain("autocrew_video");
    // 人设点到的每个名字都必须真的注册过（写错一个字母 = 那个能力悄悄消失）
    expect(named.filter((n) => !ALL_TOOLS.has(n))).toEqual([]);
  });

  it("keeps the editor persona off the writing and publishing tools", () => {
    const named = toolNamesIn("adapters/codex/AGENTS.editor.md");
    // 不改文案、不碰发布（§14.3）：点了名就等于给了它一个可用选项
    for (const off of ["autocrew_writer", "autocrew_publish", "autocrew_pre_publish", "autocrew_cover_review"]) {
      expect(named, off).not.toContain(off);
    }
  });

  it("names every host persona shipped for --dir", () => {
    for (const role of HOST_ROLES) {
      expect(() => readFileSync(path.join(REPO_ROOT, `adapters/codex/AGENTS.${role}.md`), "utf-8")).not.toThrow();
    }
  });
});

/**
 * 服务端按宿主限权（P6 §3.4）：人设文本挡不住模型照调，这张表挡得住。
 * 断言的是 `hostPolicy` 的放行结果，而不是人设里写了什么。
 */
describe("host policy: every named host has the same capabilities; only founder decisions are refused", () => {
  // 2026-10-02 创始人：codex 与 claude-code 能力一样（写稿、封面、剪辑、发布准备）；「Claude 写、Codex 剪」只是习惯
  const ACTIONS: Array<[tool: string, action: string]> = [
    ["autocrew_workflow", "write"], ["autocrew_scout", "prepare"], ["autocrew_writer", "submit"], ["autocrew_review_desk", "submit"],
    ["autocrew_cover_review", "create"], ["autocrew_video", "register"], ["autocrew_video", "handoff"], ["autocrew_content", "record"],
    ["autocrew_publish", "check"], ["autocrew_publish", "ego_lite_prepare"], ["autocrew_asset", "add"],
  ];
  it.each(ACTIONS)("codex 与 claude-code 一样放行 %s %s", (tool, action) => {
    expect(hostPolicy("codex", tool, { action })).toEqual({ ok: true });
    expect(hostPolicy("claude-code", tool, { action })).toEqual({ ok: true });
  });

  it("采纳不能由宿主代填：命名宿主调 autocrew_content adoption 一律拒，工作台放行（P6-e r3）", () => {
    for (const host of ["claude-code", "codex", "dsh"]) {
      const d = hostPolicy(host, "autocrew_content", { action: "adoption" });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.error).toBe(ADOPTION_HOST_DENIED);
    }
    expect(hostPolicy("local-user", "autocrew_content", { action: "adoption" }).ok).toBe(true);
    expect(hostPolicy("claude-code", "autocrew_content", { action: "get" }).ok).toBe(true);
  });

  it("剪辑工位人设点名的每个工具动作，服务端都放行（人设不许许诺被拒的能力）", () => {
    const text = personaBody("adapters/codex/AGENTS.editor.md");
    const calls = [...text.matchAll(/(autocrew_[a-z_]+)\s*\{action:"([a-z_]+)"/g)].map((m) => [m[1], m[2]] as const);
    expect(text).toContain("`autocrew_video register`");
    for (const [tool, action] of [...calls, ["autocrew_video", "register"] as const]) {
      expect(hostPolicy("codex", tool, { action }).ok, `${tool} ${action}`).toBe(true);
    }
  });
});
