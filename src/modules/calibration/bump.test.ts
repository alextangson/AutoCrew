import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getConfigDir } from "../../storage/storage-roots.js";
import { proposalGate, proposeBump, readFormula } from "./bump.js";
import { nextVersion } from "./bump-cleanup.js";
import { readObservations } from "./obs-store.js";
import { pairwiseRegressions, rankGate, ranks, spearman } from "./rank-gate.js";
import { retro } from "./retro.js";
import { ensureCalibration, readLog } from "./store.js";
import { predictPublished, SELF } from "./test-fixtures.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-b-")); });

async function engine(withReviewer: boolean) {
  const cfg = { apiKey: "k", baseUrl: "https://main.example", strongModel: "s", fastModel: "f", protocol: "openai",
    ...(withReviewer ? { routes: { reviewer: { baseUrl: "https://api.deepseek.com", apiKey: "k2", model: "deepseek-v4-pro", protocol: "openai" } } } : {}) };
  await fs.mkdir(getConfigDir(dir), { recursive: true });
  await fs.writeFile(path.join(getConfigDir(dir), "engine.json"), JSON.stringify(cfg));
}
const audit = (verdict: string, calls: unknown[] = []) => (async (config: unknown, opts: { tools: Array<{ execute: (a: Record<string, unknown>) => unknown }> }) => {
  calls.push(config);
  await opts.tools[0].execute({ verdict, reason: "理由".repeat(60) });
  return { finalMessage: "", turns: 1, totalTokens: 1, toolCallCount: 1, stopReason: "no_tool_calls" };
}) as never;

/** n 个样本：ER 越高实绩越高；SR 与实绩无关 */
async function seedPool(n: number, opts: { skipBlindFirst?: boolean } = {}) {
  for (let i = 0; i < n; i++) {
    const scores = { ...SELF, ER: i, SR: (i * 3) % 5, MS: i };
    const { p, later } = await predictPublished(dir, 100 * (i + 1) ** 2, `样本${i}`, scores, opts.skipBlindFirst === true && i === 0);
    await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", observations: i === 0 ? ["开头给具体场景更留人"] : [] }, dir, later);
  }
}
const ER_HEAVY = { weights: { ER: 3, SR: 1.5, HP: 1.5, QL: 1, NA: 1, AB: 1, SAT: 1 }, divisor: 10, multiplier: 2 };

describe("§四 排序门数学", () => {
  it("名次并列取平均；Spearman 正序 1、逆序 -1", () => {
    expect(ranks([10, 20, 20, 5])).toEqual([3, 1.5, 1.5, 4]);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });
  it("一致性 = |名次差|≤1 的占比，<80% 不过", () => {
    const s = (id: string, n: number, a: number) => ({ id, oldScore: n, newScore: n, actual: a });
    expect(rankGate([s("a", 5, 50), s("b", 4, 40), s("c", 3, 30), s("d", 2, 20), s("e", 1, 10)]).consistency).toBe(1);
    const bad = rankGate([s("a", 1, 50), s("b", 2, 40), s("c", 3, 30), s("d", 4, 20), s("e", 5, 10)]);
    expect(bad.pass).toBe(false);
    expect(bad.consistency).toBeLessThan(0.8);
  });
  it("逐对不倒序：旧公式排对的一对被排反或打平都算回退", () => {
    expect(pairwiseRegressions([{ id: "a", oldScore: 2, newScore: 1, actual: 20 }, { id: "b", oldScore: 1, newScore: 2, actual: 10 }])).toEqual([["a", "b"]]);
    expect(pairwiseRegressions([{ id: "a", oldScore: 2, newScore: 1, actual: 20 }, { id: "b", oldScore: 1, newScore: 1, actual: 10 }])).toHaveLength(1);
    expect(pairwiseRegressions([{ id: "a", oldScore: 1, newScore: 2, actual: 20 }, { id: "b", oldScore: 2, newScore: 1, actual: 10 }])).toEqual([]);
  });
});

describe("§四 提议门", () => {
  it("阈值不收参数；有进行中预测、没有新样本都禁止；软约束要理由且 judgment-driven", async () => {
    const { state } = await ensureCalibration(dir);
    const s = { ...state, calibration_samples: 6 };
    expect(proposalGate(s, 6, { threshold: 0.6, kind: "default-aligned" })).toMatch(/写死/);
    expect(proposalGate({ ...s, in_progress: { blind_run_id: "b", content_id: "c", started_at: "", rubric_version: "v2" } }, 6, { kind: "default-aligned" })).toMatch(/进行中/);
    expect(proposalGate({ ...s, calibration_samples_at_last_bump: 6 }, 6, { kind: "default-aligned" })).toMatch(/没有新校准样本/);
    expect(proposalGate(s, 3, { kind: "default-aligned" })).toMatch(/soft_violation_reason/);
    expect(proposalGate(s, 3, { kind: "default-aligned", soft_violation_reason: "一次 10 倍偏差" })).toMatch(/judgment-driven/);
    expect(proposalGate(s, 3, { kind: "judgment-driven", soft_violation_reason: "一次 10 倍偏差" })).toBeNull();
    expect(proposalGate(s, 6, { kind: "default-aligned" })).toBeNull();
  });
  it("方程必须完整", () => {
    expect(() => readFormula({ weights: { ER: 2 } })).toThrow(/divisor/);
    expect(() => readFormula({ weights: { XX: 2 }, divisor: 1, multiplier: 1 })).toThrow(/不在评分表/);
    expect(readFormula(JSON.stringify(ER_HEAVY)).divisor).toBe(10);
  });
  it("nextVersion", () => { expect(nextVersion("v2")).toBe("v2.1"); expect(nextVersion("v2.1")).toBe("v2.2"); });
});

describe("§四 五步升级", () => {
  it("本地过 + 审计 PASS → 清算：版本、memo、观察删掉留墓碑、每个样本追加 Re-scored、状态清零", async () => {
    await engine(true);
    await seedPool(5);
    const { live } = await readObservations(dir);
    const calls: unknown[] = [];
    const r = await proposeBump({ formula: ER_HEAVY, kind: "default-aligned", rationale: "ER 主导", absorbs_observations: [live[0].id] }, dir, { auditLoop: audit("PASS", calls) });
    expect(r).toMatchObject({ ok: true, version: "v2.1", rescored: 5 });
    expect((calls[0] as { baseUrl: string }).baseUrl).toBe("https://api.deepseek.com");
    const { state, rubric } = await ensureCalibration(dir);
    expect(rubric.version).toBe("v2.1");
    expect(state).toMatchObject({ rubric_version: "v2.1", calibration_samples_at_last_bump: 5, consecutive_directional_errors: [] });
    expect((await readObservations(dir)).tombstones.map((t) => t.reason)).toEqual(["absorbed"]);
    const preds = (await readLog<{ type: string }>("predictions", dir)).records;
    expect(preds.filter((x) => x.type === "rescored")).toHaveLength(5);
    expect(await proposeBump({ formula: ER_HEAVY, kind: "default-aligned" }, dir, { auditLoop: audit("PASS") })).toMatchObject({ code: "bump_not_allowed" });
  });
  it("本地过 + 审计 REJECT → 视为 REJECT，理由进被拒 log，评分表不动", async () => {
    await engine(true);
    await seedPool(5);
    const r = await proposeBump({ formula: ER_HEAVY, kind: "default-aligned" }, dir, { auditLoop: audit("REJECT") });
    expect(r).toMatchObject({ ok: false, code: "bump_rejected", step: 4 });
    expect((await ensureCalibration(dir)).rubric.version).toBe("v2");
    const memo = (await readLog<{ type: string; audit?: { reason: string } }>("rubric-memo", dir)).records.find((x) => x.type === "rejected_bump");
    expect(memo?.audit?.reason.length).toBeGreaterThanOrEqual(100);
  });
  it("审计线路没配 → 不自审代替，拒绝", async () => {
    await engine(false);
    await seedPool(5);
    expect(await proposeBump({ formula: ER_HEAVY, kind: "default-aligned" }, dir, { auditLoop: audit("PASS") })).toMatchObject({ code: "bump_rejected", step: 4 });
  });
  it("本地排序不过 → 第 3 步就拒，不调审计", async () => {
    await engine(true);
    await seedPool(5);
    const calls: unknown[] = [];
    const sr = { weights: { SR: 5, ER: 0.1 }, divisor: 5.1, multiplier: 2 };
    expect(await proposeBump({ formula: sr, kind: "default-aligned" }, dir, { auditLoop: audit("PASS", calls) })).toMatchObject({ step: 3 });
    expect(calls).toHaveLength(0);
  });
  it("新增维度：没有盲评分的样本补跑盲评通道", async () => {
    await engine(true);
    await seedPool(5, { skipBlindFirst: true });
    const withMs = { weights: { ...ER_HEAVY.weights, MS: 1 }, divisor: 11, multiplier: 2 };
    const r = await proposeBump({ formula: withMs, kind: "default-aligned" }, dir, { auditLoop: audit("PASS"), blindLoop: (await import("./test-fixtures.js")).fakeLoop({ ...SELF, MS: 0 }) });
    expect(r.ok).toBe(true);
    const re = (await readLog<{ type: string; backfilled?: boolean }>("predictions", dir)).records.filter((x) => x.type === "rescored");
    expect(re.filter((x) => x.backfilled)).toHaveLength(1);
    expect((await ensureCalibration(dir)).rubric.trial_dimensions).toEqual(["TS"]);
  });
});
