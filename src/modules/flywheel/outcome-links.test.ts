import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDecision, readDecisions, removeDecision } from "./outcome-links.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "links-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("手动关联的存取（§36）", () => {
  it("没有文件 = 没有决定；写进去读得回，撤销后消失", async () => {
    expect(await readDecisions(dir)).toEqual([]);
    const d = await addDecision({ op: "link", works: ["douyin@a@2026-09-09"], contentId: "c1" }, dir);
    expect(await readDecisions(dir)).toHaveLength(1);
    expect(await removeDecision(d.id, dir)).toEqual({ removed: true });
    expect(await readDecisions(dir)).toEqual([]);
    expect(await removeDecision(d.id, dir)).toEqual({ removed: false });
  });

  it("并发点两下都记住，不互相覆盖", async () => {
    await Promise.all([
      addDecision({ op: "split", works: ["a"] }, dir),
      addDecision({ op: "split", works: ["b"] }, dir),
    ]);
    expect(await readDecisions(dir)).toHaveLength(2);
  });

  it("缺参数的决定被拒", async () => {
    await expect(addDecision({ op: "link", works: ["a"] }, dir)).rejects.toThrow(/稿件/);
    await expect(addDecision({ op: "merge", works: ["a"], target: "a" }, dir)).rejects.toThrow(/自己/);
    await expect(addDecision({ op: "split", works: [] }, dir)).rejects.toThrow();
  });

  it("文件坏了要报错，不当成没有决定", async () => {
    await fs.writeFile(path.join(dir, "outcome-links.json"), "{oops");
    await expect(readDecisions(dir)).rejects.toThrow();
  });

  it("不改写 outcomes.jsonl", async () => {
    await fs.writeFile(path.join(dir, "outcomes.jsonl"), "x\n");
    await addDecision({ op: "split", works: ["a"] }, dir);
    expect(await fs.readFile(path.join(dir, "outcomes.jsonl"), "utf-8")).toBe("x\n");
  });
});
