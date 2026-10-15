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

describe("write-script 技能（spec 2026-10-15）", () => {
  it("写法一节在标记里、在写全文之前；观众试读替代 Codex 审稿；不再每轮提规则；技能不再提 craft_method", async () => {
    const skill = await fs.readFile(path.join(import.meta.dirname, "../../../skills/write-script/SKILL.md"), "utf8");
    expect(skill).not.toContain("craft_method");
    expect(skill).not.toContain("codex-review-prompt");
    expect(skill).toContain("viewer-test-read-prompt.md");
    expect(skill.indexOf("<!-- method:start -->")).toBeLessThan(skill.indexOf("## 5 写和观众试读"));
    expect(skill).toContain("## 写法：怎么让人看下去");
    expect(skill).not.toMatch(/feedback\.lessons|"lessons"|relation:/);
    expect(skill).toContain("不用 `verify_quote` 登记");
  });
});
