import { describe, expect, it } from "vitest";
import { runBlindChannel } from "./blind.js";
import { DEFAULT_RUBRIC, composite } from "./rubric.js";
import { TS_LENS_HINT } from "./ts-lens.js";
import { fakeLoop, SELF } from "./test-fixtures.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("§七 转发尴尬尺子 TS", () => {
  it("TS 是候选维度：每次盲评都试评分，但不进综合分", async () => {
    expect(DEFAULT_RUBRIC.trial_dimensions).toContain("TS");
    expect(DEFAULT_RUBRIC.formula.weights).not.toHaveProperty("TS");
    expect(composite({ ...SELF, TS: 0 }, DEFAULT_RUBRIC.formula)).toBe(composite({ ...SELF, TS: 5 }, DEFAULT_RUBRIC.formula));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-ts-"));
    const r = await runBlindChannel("稿子", DEFAULT_RUBRIC, dir, { runLoopImpl: fakeLoop({ ...SELF, TS: 1 }) });
    expect(r.scores.TS.score).toBe(1);
  });
  it("受众审与选题会只提醒、不扣分", async () => {
    expect(TS_LENS_HINT).toMatch(/不扣分/);
    const src = await fs.readFile(path.join(process.cwd(), "src/modules/review/audience-review.ts"), "utf-8");
    expect(src).toContain("TS_LENS_HINT");
    const skill = await fs.readFile(path.join(process.cwd(), "skills/topic-meeting/SKILL.md"), "utf-8");
    expect(skill).toMatch(/转发尴尬（只提醒、不扣分）/);
  });
});
