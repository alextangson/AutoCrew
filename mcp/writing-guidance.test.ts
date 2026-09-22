import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { registerAutocrewCapabilities } from "../index.js";
import { createContext } from "../src/runtime/context.js";
import { EventBus } from "../src/runtime/events.js";
import { ToolRunner } from "../src/runtime/tool-runner.js";
import { editorialSchema } from "../src/tools/editorial.js";
import { listGuiSkills } from "../src/desktop/skills-reader.js";
import { WRITING_INSTRUCTIONS } from "./writing-instructions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = [
  "calibrate", "style-calibration", "topic-ideas", "spawn-planner", "research",
  "spawn-writer", "write-script", "spawn-batch-writer", "platform-rewrite",
  "humanizer-zh", "content-review", "memory-distill", "pre-publish", "manage-pipeline",
];
const skill = (name: string) => readFileSync(path.join(ROOT, "skills", name, "SKILL.md"), "utf8");
const harness = (name: string) => skill(name).split("\n## GUI")[0].split("\n## Changelog")[0];

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
