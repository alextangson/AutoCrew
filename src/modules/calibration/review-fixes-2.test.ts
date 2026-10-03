/** Codex 复审 39558f35 的 5 条回归测试 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { executeInsights } from "../../tools/insights.js";
import { buildGateSamples, proposeBump } from "./bump.js";
import { EARLY_RETRO_WEIGHT } from "./constants.js";
import { calibrationPool } from "./pool.js";
import { rankGate } from "./rank-gate.js";
import { retro } from "./retro.js";
import { appendLog, calibrationDir, ensureCalibration, fingerprint, readLog, serializeCalibration } from "./store.js";
import { audit, engine, fakeLoop, predictPublished, SELF } from "./test-fixtures.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-fix2-")); });
const ER_HEAVY = { weights: { ER: 3, SR: 1.5, HP: 1.5, QL: 1, NA: 1, AB: 1, SAT: 1 }, divisor: 10, multiplier: 2 };

describe("复审 P1", () => {
  it("#1 末尾被删后拒绝追加；只能经确认显式恢复，恢复留痕", async () => {
    await serializeCalibration(dir, async () => { for (const n of [1, 2, 3]) await appendLog("predictions", { type: "t", n }, dir); });
    const f = path.join(calibrationDir(dir), "predictions.jsonl");
    const lines = (await fs.readFile(f, "utf-8")).trim().split("\n");
    await fs.writeFile(f, `${lines.slice(0, -1).join("\n")}\n`);
    await expect(serializeCalibration(dir, () => appendLog("predictions", { type: "t", n: 4 }, dir))).rejects.toThrow(/拒绝再追加/);
    expect((await readLog("predictions", dir)).integrity.ok).toBe(false);
    expect(await executeInsights({ action: "calib_status", calib: { repair_log: "predictions" }, _dataDir: dir })).toMatchObject({ ok: false, code: "needs_confirmation" });
    const r = await executeInsights({ action: "calib_status", calib: { repair_log: "predictions", confirm: true, reason: "我手动删的测试行" }, _dataDir: dir });
    expect(r.ok).toBe(true);
    expect((await readLog("predictions", dir)).integrity.ok).toBe(true);
    expect(await fs.readFile(path.join(calibrationDir(dir), "repairs.jsonl"), "utf-8")).toMatch(/我手动删的测试行/);
  });
  it("#2/#4 自评来的试评分维度不复用，新维度照样补跑盲评；补打分的线路留存并参与审计独立性", async () => {
    await engine(dir, true);
    for (let i = 0; i < 5; i++) {
      const { p, later } = await predictPublished(dir, 100 * (i + 1) ** 2, `样本${i}`, { ...SELF, ER: i, MS: i }, i === 0);
      await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x" }, dir, later);
    }
    // 第一次升级不引入 MS：样本 0 是自评，其 MS 不能被当成可复用的盲评分
    expect((await proposeBump({ formula: ER_HEAVY, kind: "default-aligned" }, dir, { auditLoop: audit("PASS") })).ok).toBe(true);
    const pool = await calibrationPool(dir);
    const { rubric } = await ensureCalibration(dir);
    const withMs = { weights: { ...ER_HEAVY.weights, MS: 1 }, divisor: 11, multiplier: 2 };
    let calls = 0;
    const blind = ((...a: unknown[]) => { calls++; return (fakeLoop({ ...SELF, MS: 1 }) as unknown as (...x: unknown[]) => unknown)(...a); }) as never;
    const g = await buildGateSamples(pool, rubric.formula, withMs, dir, { blindLoop: blind });
    expect(calls).toBe(1);
    const s0 = g.samples.find((s) => s.label === "样本0")!;
    expect(s0.provenance.MS).toMatchObject({ source: "backfill", endpoint: "https://main.example" });
    expect(g.blindEndpoints).toContain("https://main.example");
  });
  it("#4 复用补打分时，它的线路仍进审计独立性检查", async () => {
    await engine(dir, true);
    for (let i = 0; i < 5; i++) {
      const { p, later } = await predictPublished(dir, 100 * (i + 1) ** 2, `样本${i}`, { ...SELF, ER: i, MS: i }, i === 0);
      await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x" }, dir, later);
    }
    const withMs = { weights: { ...ER_HEAVY.weights, MS: 1 }, divisor: 11, multiplier: 2 };
    expect((await proposeBump({ formula: withMs, kind: "default-aligned" }, dir, { auditLoop: audit("PASS"), blindLoop: fakeLoop({ ...SELF, MS: 1 }) })).ok).toBe(true);
    const re = (await readLog<{ type: string; provenance?: Record<string, { source: string; endpoint?: string }> }>("predictions", dir)).records.filter((r) => r.type === "rescored");
    expect(re.some((r) => r.provenance?.MS?.source === "backfill" && r.provenance.MS.endpoint === "https://main.example")).toBe(true);
    const pool = await calibrationPool(dir);
    const { rubric } = await ensureCalibration(dir);
    const g = await buildGateSamples(pool, rubric.formula, { ...withMs, weights: { ...withMs.weights, ER: 2.5 } }, dir, { blindLoop: (async () => { throw new Error("不该补"); }) as never });
    expect(g.blindEndpoints).toContain("https://main.example");
  });
});

describe("复审 P2", () => {
  it("#3 降权样本按权重计入一致性（Codex 例：5 个完整样本 + 1 个 0.5 权重）", () => {
    const actual = [50, 40, 30, 20, 10];
    const full = [3, 5, 4, 2, 1].map((n, i) => ({ id: `f${i}`, oldScore: n, newScore: n, actual: actual[i] }));
    // 早复盘样本落在最末：名次差 0 → 一致性 = (4×1 + 0.5) / 5.5
    const low = rankGate([...full, { id: "x", oldScore: 0, newScore: 0, actual: 5, weight: EARLY_RETRO_WEIGHT }]);
    expect(low.consistency).toBeCloseTo(4.5 / 5.5, 6);
    expect(low.pass).toBe(true);
    // 早复盘样本新分排第一：所有完整样本名次下移一位，f0 差 3、x 差 5 → (4×1) / 5.5 < 0.8
    const high = rankGate([...full, { id: "x", oldScore: 0, newScore: 6, actual: 5, weight: EARLY_RETRO_WEIGHT }]);
    expect(high.consistency).toBeCloseTo(4 / 5.5, 6);
    expect(high.pass).toBe(false);
    expect(high.regressions).toEqual([]);
    expect(high.soft_regressions).toHaveLength(5);
    expect(high.soft_regression_weight).toBeCloseTo(2.5, 6);
    // 两个完整样本之间的倒序仍是绝对否决
    const veto = rankGate([{ id: "a", oldScore: 2, newScore: 1, actual: 20 }, { id: "b", oldScore: 1, newScore: 2, actual: 10 }]);
    expect(veto.regressions).toEqual([["a", "b"]]);
  });
  it("#5 正在追加（行写了、链头还没写）不算删除；并发读写不误报", async () => {
    await serializeCalibration(dir, () => appendLog("predictions", { type: "t", n: 1 }, dir));
    const { records } = await readLog("predictions", dir);
    const body = { type: "t", n: 2, prev: records[0].fp };
    await fs.appendFile(path.join(calibrationDir(dir), "predictions.jsonl"), `${JSON.stringify({ ...body, fp: fingerprint(body) })}\n`);
    expect((await readLog("predictions", dir)).integrity).toEqual({ ok: true, problems: [] });
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "calib-fix2c-"));
    const writes = Array.from({ length: 20 }, (_, n) => serializeCalibration(dir2, () => appendLog("predictions", { type: "t", n }, dir2)));
    const reads = Array.from({ length: 40 }, () => readLog("predictions", dir2).then((r) => r.integrity.problems));
    const [, problems] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
    expect(problems.flat()).toEqual([]);
  });
});
