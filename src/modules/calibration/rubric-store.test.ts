import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUMP_RULES } from "./constants.js";
import { composite, DEFAULT_RUBRIC, formulaText, rubricFormMismatch, rubricLeaks } from "./rubric.js";
import { appendLog, calibrationDir, ensureCalibration, readLog, serializeCalibration, writeRubric } from "./store.js";
import { executeInsights } from "../../tools/insights.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "calib-"));

describe("§一 评分表", () => {
  it("起步公式是 cheat-on 观点视频 v2：7 维、三项 ×1.5、/8.5×2.0", () => {
    expect(DEFAULT_RUBRIC.formula).toEqual({ weights: { ER: 1.5, SR: 1.5, HP: 1.5, QL: 1, NA: 1, AB: 1, SAT: 1 }, divisor: 8.5, multiplier: 2.0 });
    expect(formulaText(DEFAULT_RUBRIC.formula)).toBe(DEFAULT_RUBRIC.formula_text.replace("2.0", "2"));
    expect(DEFAULT_RUBRIC.trial_dimensions).toEqual(["MS", "TS"]);
  });
  it("综合分：满分 10、全 0 为 0；候选维度不进综合分；缺维度 → null", () => {
    const all = (n: number) => ({ ER: n, SR: n, HP: n, QL: n, NA: n, AB: n, SAT: n });
    expect(composite(all(5), DEFAULT_RUBRIC.formula)).toBe(10);
    expect(composite({ ...all(0), MS: 5, TS: 5 }, DEFAULT_RUBRIC.formula)).toBe(0);
    expect(composite({ ER: 5, SR: 5, HP: 5, QL: 3, NA: 3, AB: 3, SAT: 3 }, DEFAULT_RUBRIC.formula)).toBe(8.12);
    expect(composite({ ER: 5 }, DEFAULT_RUBRIC.formula)).toBeNull();
  });
  it("起步 rubric 本身通过盲评白名单自检", () => expect(rubricLeaks(DEFAULT_RUBRIC)).toEqual([]));
  it("写 rubric.json 时含数据/样本 → 拒写，文件不变", async () => {
    const dir = await tmp();
    await ensureCalibration(dir);
    const dirty = { ...DEFAULT_RUBRIC, observations: [{ id: "o1", stage: "observation", text: "那条视频播放 13.7w" }] };
    expect(rubricLeaks(dirty).length).toBeGreaterThan(0);
    await expect(writeRubric(dirty, dir)).rejects.toThrow(/盲评白名单/);
    const onDisk = JSON.parse(await fs.readFile(path.join(calibrationDir(dir), "rubric.json"), "utf-8"));
    expect(onDisk.observations).toEqual([]);
  });
  it("口播=匹配，长文=借用标 mismatch", () => {
    const video = new Set(["douyin"]);
    expect(rubricFormMismatch("douyin", video)).toBe(false);
    expect(rubricFormMismatch("wechat_mp", video)).toBe(true);
  });
  it("升级阈值冻结，运行时改不动", () => {
    expect(() => { (BUMP_RULES as { THRESHOLD: number }).THRESHOLD = 0.6; }).toThrow();
    expect(BUMP_RULES.THRESHOLD).toBe(0.8);
  });
});

describe("§一 状态与 append-only", () => {
  it("第一次用落 rubric.json + state.json", async () => {
    const dir = await tmp();
    const { state, rubric } = await ensureCalibration(dir);
    expect(state.rubric_version).toBe("v2");
    expect(state.calibration_samples).toBe(0);
    expect(rubric.version).toBe("v2");
    await expect(fs.stat(path.join(calibrationDir(dir), "state.json"))).resolves.toBeTruthy();
  });
  it("哈希链：改一行或删一行都会被读出来", async () => {
    const dir = await tmp();
    await serializeCalibration(dir, async () => {
      await appendLog("predictions", { type: "a", n: 1 }, dir);
      await appendLog("predictions", { type: "b", n: 2 }, dir);
      await appendLog("predictions", { type: "c", n: 3 }, dir);
    });
    expect((await readLog("predictions", dir)).integrity.ok).toBe(true);
    const p = path.join(calibrationDir(dir), "predictions.jsonl");
    const lines = (await fs.readFile(p, "utf-8")).trim().split("\n");
    await fs.writeFile(p, `${lines[0].replace('"n":1', '"n":9')}\n${lines[1]}\n${lines[2]}\n`);
    expect((await readLog("predictions", dir)).integrity.problems.join()).toMatch(/被改过/);
    await fs.writeFile(p, `${lines[0]}\n${lines[2]}\n`);
    expect((await readLog("predictions", dir)).integrity.problems.join()).toMatch(/被删或插入/);
  });
  it("autocrew_insights calib_status 走得通；calib 传 JSON 串也收", async () => {
    const dir = await tmp();
    const r = await executeInsights({ action: "calib_status", calib: "{}", _dataDir: dir });
    expect(r.ok).toBe(true);
    expect((r.rubric as { version: string }).version).toBe("v2");
    const bad = await executeInsights({ action: "calib_status", calib: "[1]", _dataDir: dir });
    expect(bad.ok).toBe(false);
  });
});
