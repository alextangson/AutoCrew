/** 体裁手册上线后（spec 2026-10-13 §6.1）：start 不再加载 craft/method.md，文件本身不动；审稿提示词的 {{CRAFT}} 填手册全文 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "../../tools/draft.js";
import { getDataDir } from "../../storage/local-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "craft-method-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("start 不再带 craft_method", () => {
  it("有方法页也不进上下文，文件保留原样", async () => {
    const file = path.join(getDataDir(dir), "craft", "method.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "# 方法\nMETHOD-SECRET");
    const r = (await executeDraft({ action: "start", inspiration: "用了 AI 反而更忙", _dataDir: dir, _host: "claude-code", _session: "s1" })) as { ok: boolean; context: Record<string, unknown> };
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("METHOD-SECRET");
    expect(r.context).not.toHaveProperty("craft_method");
    expect(r.context.playbooks_index).toHaveLength(5);
    expect(await fs.readFile(file, "utf8")).toBe("# 方法\nMETHOD-SECRET");
  });
});

describe("Codex 审稿提示词与技能", () => {
  it("{{CRAFT}} 是选定的体裁手册，判据三项；技能不再提 craft_method", async () => {
    const prompt = await fs.readFile(path.join(import.meta.dirname, "../../../skills/write-script/codex-review-prompt.md"), "utf8");
    expect(prompt).toContain("{{CRAFT}}");
    expect(prompt).toContain("体裁手册");
    expect(prompt.match(/^\d\. /gm)).toHaveLength(3);
    const skill = await fs.readFile(path.join(import.meta.dirname, "../../../skills/write-script/SKILL.md"), "utf8");
    expect(skill).toContain("{{CRAFT}}");
    expect(skill).not.toContain("craft_method");
    expect(skill).toContain("playbook:<体裁 id>");
    expect(skill).toContain("不要用 `verify_quote` 登记");
  });
});
