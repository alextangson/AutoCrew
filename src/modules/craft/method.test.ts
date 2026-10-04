/** autocrew_draft start 的 context.craft_method：有 / 没有 / 读不了 / 超长截断；拆解卡不进上下文；审稿提示词占位 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "../../tools/draft.js";
import { getDataDir } from "../../storage/local-store.js";

let dir: string;
const start = async () => (await executeDraft({ action: "start", inspiration: "用了 AI 反而更忙", _dataDir: dir, _host: "claude-code", _session: "s1" })) as { ok: boolean; context: Record<string, unknown> };
const craftDir = () => path.join(getDataDir(dir), "craft");

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "craft-method-")); });
afterEach(async () => { await fs.chmod(path.join(craftDir(), "method.md"), 0o644).catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });

describe("start 的 craft_method", () => {
  it("没有方法页：null，提示还没有拆解库", async () => {
    const r = await start();
    expect(r.ok).toBe(true);
    expect(r.context).toMatchObject({ craft_method: null, craft_method_error: null });
    expect(r.context.craft_method_note).toContain("还没有拆解库");
  });

  it("有方法页：附正文；拆解卡不进上下文", async () => {
    await fs.mkdir(path.join(craftDir(), "dankoe"), { recursive: true });
    await fs.writeFile(path.join(craftDir(), "method.md"), "# 方法\n假设 1：开头先替观众说出处境");
    await fs.writeFile(path.join(craftDir(), "dankoe", "abc.md"), "CARD-SECRET");
    const r = await start();
    expect(r.context.craft_method).toBe("# 方法\n假设 1：开头先替观众说出处境");
    expect(JSON.stringify(r)).not.toContain("CARD-SECRET");
  });

  it("超过 6000 字截断并说明", async () => {
    await fs.mkdir(craftDir(), { recursive: true });
    await fs.writeFile(path.join(craftDir(), "method.md"), "字".repeat(7000));
    const r = await start();
    expect(Array.from(r.context.craft_method as string)).toHaveLength(6000);
    expect(r.context.craft_method_note).toContain("6000");
  });

  it("读不了（是目录 / 没权限）：返回错误原因，不当成没有", async () => {
    await fs.mkdir(path.join(craftDir(), "method.md"), { recursive: true });
    const r = await start();
    expect(r.ok).toBe(true);
    expect(r.context.craft_method).toBeNull();
    expect(r.context.craft_method_error).toContain("方法页读不了");
    expect(r.context.craft_method_note).toBeNull();
  });
});

describe("Codex 审稿提示词的 {{CRAFT}} 占位", () => {
  it("有占位、只作开头和收获的参考，判据仍是三项", async () => {
    const prompt = await fs.readFile(path.join(import.meta.dirname, "../../../skills/write-script/codex-review-prompt.md"), "utf8");
    expect(prompt).toContain("{{CRAFT}}");
    expect(prompt.match(/^\d\. /gm)).toHaveLength(3);
    const skill = await fs.readFile(path.join(import.meta.dirname, "../../../skills/write-script/SKILL.md"), "utf8");
    expect(skill).toContain("{{CRAFT}}");
    expect(skill).toContain("不要用 `verify_quote` 登记");
  });
});
