import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { registerAutocrewCapabilities } from "../index.js";
import { createContext } from "../src/runtime/context.js";
import { EventBus } from "../src/runtime/events.js";
import { ToolRunner } from "../src/runtime/tool-runner.js";
import { editorialSchema } from "../src/tools/editorial.js";
import { scoutSchema } from "../src/tools/scout.js";
import { reviewDeskSchema } from "../src/tools/host-review.js";
import { writerSchema } from "../src/tools/writer.js";
import { listGuiSkills } from "../src/desktop/skills-reader.js";
import { WRITING_INSTRUCTIONS } from "./writing-instructions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = [
  "calibrate", "style-calibration", "topic-ideas", "topic-meeting", "research",
  "spawn-writer", "write-script", "spawn-batch-writer", "platform-rewrite",
  "humanizer-zh", "content-review", "memory-distill", "pre-publish", "manage-pipeline", "onboarding",
  "video-session",
];
const skill = (name: string) => readFileSync(path.join(ROOT, "skills", name, "SKILL.md"), "utf8");
const harness = (name: string) => skill(name).split("\n## GUI")[0].split("\n## Changelog")[0];
// Writer exposes JSON Schema enums with Type.Unsafe. Value.Errors cannot
// execute that marker, so project their actual enum values to equivalent unions.
const writerExampleSchema = Type.Object({
  ...writerSchema.properties,
  action: Type.Union((writerSchema.properties.action.enum as string[]).map(value => Type.Literal(value))),
  research_mode: Type.Optional(Type.Union((writerSchema.properties.research_mode.enum as string[]).map(value => Type.Literal(value)))),
  review: Type.Optional(Type.Union((writerSchema.properties.review.enum as string[]).map(value => Type.Literal(value)))),
}, { additionalProperties: false });

describe("writing guidance matches callable product capabilities", () => {
  it("all writing skills name registered MCP tools and keep GUI-only calls on the GUI surface", async () => {
    const runner = new ToolRunner({ ctx: createContext({}), eventBus: new EventBus() });
    registerAutocrewCapabilities(runner);
    const names = new Set(runner.getTools().map(tool => tool.name));
    for (const name of SKILLS) {
      const mentioned = harness(name).match(/autocrew_[a-z_]+/g) ?? [];
      expect(mentioned.filter(tool => !names.has(tool)), name).toEqual([]);
      expect(harness(name), name).not.toMatch(/`(?:generate_persona|save_persona|add_style_rule|revise_focus|review_scan)`/);
    }
    for (const gui of await listGuiSkills(path.join(ROOT, "skills"))) {
      expect(gui.guiContent, gui.id).not.toMatch(/autocrew_[a-z_]+/);
    }
  });

  it("batch and adaptation instructions use the same prepared submission path", () => {
    for (const name of ["spawn-batch-writer", "platform-rewrite"]) {
      expect(harness(name), name).toContain('action:"prepare"');
      expect(harness(name), name).toContain("autocrew_writer pack");
      expect(harness(name), name).toContain("submit_status");
      expect(harness(name), name).not.toMatch(/action[=:]\s*["']save["']|save_as_draft\s*[:=]\s*true/);
    }
  });

  it("does not revive quality scores, mandatory CTA checks or mechanical semantic rewrites", () => {
    const text = SKILLS.map(skill).join("\n");
    expect(text).not.toMatch(/review_scan|AI\s*味评分|CTA\s*清晰度|quality\s*≥|不要暗示哪张更好/);
    expect(harness("humanizer-zh")).toContain("只清理空白");
    expect(harness("content-review")).toContain("audience_review");
    expect(harness("pre-publish")).toContain("不是作者批准");
  });

  it("存盘失败就停下报告，不许写库外文件兜底（§13.4-A）", () => {
    for (const text of [harness("write-script"), harness("video-session"), WRITING_INSTRUCTIONS]) {
      expect(text).toContain("storage_unavailable");
      expect(text).toMatch(/不得把稿子.{0,8}写成库外文件/);
    }
  });

  it("published editorial JSON examples satisfy the actual schema", () => {
    for (const name of ["style-calibration", "memory-distill"]) {
      const blocks = [...harness(name).matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
      expect(blocks.length, name).toBeGreaterThan(0);
      for (const block of blocks) {
        const example = JSON.parse(block[1]);
        expect([...Value.Errors(editorialSchema, example)], name).toEqual([]);
        expect(example.user_confirmed).toBe(true);
        if (example.action === "feedback") expect(example.scope).toBe("draft");
        if (example.action === "update_profile") expect(Object.keys(example.profile).length).toBeGreaterThan(0);
      }
    }
  });

  it("published host research, writing and review examples satisfy their real tool schemas", () => {
    for (const [name, schema] of [
      ["research", scoutSchema], ["write-script", writerExampleSchema], ["content-review", reviewDeskSchema],
    ] as const) {
      const examples = [...harness(name).matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
      expect(examples.length, name).toBeGreaterThan(0);
      for (const block of examples) expect([...Value.Errors(schema, JSON.parse(block[1]))], name).toEqual([]);
    }
  });

  it("all shipped host entry points route research and review to the current host", () => {
    const entryPoints = [
      WRITING_INSTRUCTIONS,
      ...["README.md", "adapters/codex/README.md", "adapters/codex/AGENTS.editor-writer.md",
        "adapters/dsh/README.md", "adapters/dsh/agent-presets/autocrew/agent.cordis.yml",
        "templates/AGENTS.md", "docs/2026-09-22-host-driven-mcp.md"]
        .map(file => readFileSync(path.join(ROOT, file), "utf8")),
    ];
    for (const text of entryPoints) {
      expect(text).toMatch(/scout/);
      expect(text).toMatch(/review_desk/);
      expect(text).toContain("host_self_review");
      expect(text).not.toMatch(/审稿转后台|调研与把关归产品|调研\/审稿由产品执行|起调研（分钟级、后台|整稿最多 3 次、单次最多 45 秒/);
    }
    expect(WRITING_INSTRUCTIONS).toContain("普通 MCP 流程无需配置 engine");
    expect(WRITING_INSTRUCTIONS).toContain("awaiting_host_review");
    expect(WRITING_INSTRUCTIONS).toContain("第三方搜索、图像与视频仍使用独立服务额度");
    expect(harness("research")).toContain('action:"read_page"');
    expect(harness("research")).toContain("不要求第三方搜索 key");
    // 风格分析归当前宿主：autocrew_style 对宿主不列（host-policy），技能不能指望它，也不能把分析转给后台模型
    expect(harness("style-calibration")).toContain("样本由你自己读、自己分析");
    expect(harness("style-calibration")).toContain("无需后台模型");
    expect(harness("style-calibration")).not.toMatch(/autocrew_style|execution=engine/);
  });

  it("MCP hosts receive the feedback and audience contract without loading local skills", () => {
    expect(WRITING_INSTRUCTIONS).toContain("audience_review");
    expect(WRITING_INSTRUCTIONS).toContain("draft_hash");
    expect(WRITING_INSTRUCTIONS).toContain("event_id");
    expect(WRITING_INSTRUCTIONS).toContain("scope=draft");
    expect(WRITING_INSTRUCTIONS).toContain("user_confirmed:true");
    for (const name of ["calibrate", "style-calibration", "memory-distill"]) {
      expect(harness(name), name).not.toContain("autocrew_init");
      expect(harness(name), name).not.toMatch(/(?:读取|更新|写入|追加)\s*`~\/\.autocrew\//);
    }
  });
});
