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
import { registerAutocrewCapabilities } from "../../index.js";
import { createContext } from "../runtime/context.js";
import { EventBus } from "../runtime/events.js";
import { ToolRunner } from "../runtime/tool-runner.js";

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

  it("keeps the writer skill on the pack/submit path, never autocrew_content save", () => {
    const text = personaBody("skills/write-script/SKILL.md");
    expect(text).toContain("autocrew_writer");
    // 存草稿绕过格式门/数字门/质量门与审稿人——这条路 P3b 关掉了
    expect(text).not.toMatch(/autocrew_content[^\n]{0,40}save/);
    expect(text).toMatch(/"action":\s*"submit"/);
  });

  it("keeps research off the retired autocrew_research tool", () => {
    // dsh 审计判定不放行：浏览器适配器拿不到数据时会造 5 条占位选题、然后 ok:true 报成功
    for (const file of ["skills/research/SKILL.md", "skills/spawn-writer/SKILL.md"]) {
      expect(toolNamesIn(file), file).not.toContain("autocrew_research");
    }
    expect(toolNamesIn("skills/research/SKILL.md")).toContain("autocrew_workflow");
  });

  it("keeps the cover persona off the legacy ratio action and off other image models", () => {
    const text = personaBody("adapters/codex/AGENTS.cover.md");
    // 人设里提一个不该用的名字，等于把它变成一个可用选项（codex 评审 #14）
    expect(text).not.toContain("generate_ratios");
    expect(text.toLowerCase()).not.toContain("gemini");
    expect(text).toContain("gpt-image-2");
    expect(text).toContain('ratios:["4:3"]');
  });

  it("names every host persona shipped for --dir", () => {
    for (const role of ["editor-writer", "cover"]) {
      expect(() => readFileSync(path.join(REPO_ROOT, `adapters/codex/AGENTS.${role}.md`), "utf-8")).not.toThrow();
    }
  });
});
