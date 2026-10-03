import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { saveContent } from "../../storage/local-store.js";
import { appendOutcomes } from "../flywheel/outcome-store.js";
import { commitPrediction } from "./commit.js";
import { calibrationPool } from "./pool.js";
import { blindStep } from "./predict.js";
import { BODY, fakeLoop, SELF } from "./test-fixtures.js";
import { retro } from "./retro.js";
import { bumpSuggestion, directionOf, retroStateUpdate } from "./retro-state.js";
import { calibrationDir, ensureCalibration, readLog } from "./store.js";

const NAMES = ["底部", "基础盘", "命中", "小爆", "大爆"];
const DAY = 86_400_000;
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-r-")); });

export async function predictPublished(d: string, views: number | null, title = "AI 周报") {
  const published = new Date(Date.now() - 1 * DAY);
  const c = await saveContent({ title, body: "下班前领导一句明早给我……", platform: "douyin", status: "draft_ready", tags: [], publishedAt: published.toISOString() } as never, d);
  const b = await blindStep({ content_id: c.id, self_scores: SELF, seen_data: false }, d, { runLoopImpl: fakeLoop(SELF) });
  const p = await commitPrediction({ blind_run_id: b.blind_run_id, ...BODY(NAMES) }, d);
  if (views !== null) {
    await appendOutcomes([{ contentId: c.id, platform: "douyin", platformTitle: title, publishedAt: published.toISOString(), metricDate: new Date(published.getTime() + 3 * DAY).toISOString().slice(0, 10), metrics: { views, likes: 3 }, source: "auto", recordedAt: "", needsReview: false, reviewReasons: [] }], d);
  }
  return { c, p, later: new Date(Date.now() + 3 * DAY) };
}

describe("§三 复盘", () => {
  it("T+3 复盘：数据取回流、算落档与偏差、样本 +1、观察进 memo 不进 rubric.json", async () => {
    const { p, later } = await predictPublished(dir, 2000);
    const r = await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "钩子撑住了", observations: ["具体场景开头比概念开头留人"] }, dir, later);
    expect(r).toMatchObject({ ok: true, landed_bucket: "命中", counted_as_calibration_sample: true, integrity_warning: false });
    const { state, rubric } = await ensureCalibration(dir);
    expect(state.calibration_samples).toBe(1);
    expect(state.pending_retros).toEqual([]);
    expect(rubric.observations).toEqual([]);
    expect((await readLog<{ type: string }>("rubric-memo", dir)).records.map((x) => x.type)).toEqual(["observation"]);
    expect(await calibrationPool(dir)).toHaveLength(1);
  });
  it("只追加一次；D+7 追加读数；修正只追加", async () => {
    const { p, later } = await predictPublished(dir, 800);
    await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x" }, dir, later);
    expect(await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "y" }, dir, later)).toMatchObject({ code: "retro_exists" });
    expect(await retro({ prediction_id: p.prediction_id, correction: "因素表里「钩子」应为「标题」" }, dir, later)).toMatchObject({ ok: true, appended: "correction" });
  });
  it("缺数据如实报、不编；手填可用并标手填", async () => {
    const { p, later } = await predictPublished(dir, null);
    expect(await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x" }, dir, later)).toMatchObject({ ok: false, code: "no_data" });
    const r = await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", manual_metrics: "{\"views\": 300}" }, dir, later);
    expect(r).toMatchObject({ ok: true, actual: { views: 300, source: "手填" } });
  });
  it("不到 3 天：拒绝；force_early 标 early_retro、不计样本、不进池", async () => {
    const { p } = await predictPublished(dir, 800);
    const now = new Date();
    expect(await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", manual_metrics: { views: 1 } }, dir, now)).toMatchObject({ code: "too_early" });
    const r = await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", force_early: true, manual_metrics: { views: 100 } }, dir, now);
    expect(r).toMatchObject({ ok: true, early_retro: true, counted_as_calibration_sample: false });
    expect(await calibrationPool(dir)).toHaveLength(0);
  });
  it("预测主体被改过 → 追加 Integrity warning，不计样本、不进池", async () => {
    const { p, later } = await predictPublished(dir, 800);
    const file = path.join(calibrationDir(dir), "predictions.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    await fs.writeFile(file, raw.replace("\"center\":500", "\"center\":900"));
    const r = await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x" }, dir, later);
    expect(r).toMatchObject({ integrity_warning: true, counted_as_calibration_sample: false });
    expect(await calibrationPool(dir)).toHaveLength(0);
  });
  it("Reconstructed 不进池", async () => {
    const c = await saveContent({ title: "旧片", body: "b", platform: "douyin", status: "draft_ready", tags: [], publishedAt: new Date(Date.now() - 5 * DAY).toISOString() } as never, dir);
    const b = await blindStep({ content_id: c.id, self_scores: SELF, reconstructed: true }, dir);
    const p = await commitPrediction({ blind_run_id: b.blind_run_id, ...BODY(NAMES) }, dir);
    const r = await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", manual_metrics: { views: 50 } }, dir);
    expect(r).toMatchObject({ counted_as_calibration_sample: false });
    expect(await calibrationPool(dir)).toHaveLength(0);
  });
});

describe("§三 偏差与提示", () => {
  it("±25% 内不算方向偏差；低于中枢 = 高估", () => {
    expect(directionOf(0.8)).toBeNull();
    expect(directionOf(0.5)).toBe("high");
    expect(directionOf(1.5)).toBe("low");
  });
  it("连续 3 次同向 / 单次 ≥10 倍 → 提示升级", () => {
    const e = (dir: "high" | "low") => ({ dir, ratio: 0.5, prediction_id: "x" });
    expect(bumpSuggestion([e("high"), e("high"), e("high")], 0.5)).toMatch(/default-aligned/);
    expect(bumpSuggestion([e("high"), e("low"), e("high")], 0.5)).toBeNull();
    expect(bumpSuggestion([], 12)).toMatch(/judgment-driven/);
  });
  it("每 10 条新样本提示清算", async () => {
    const { state } = await ensureCalibration(dir);
    const r = retroStateUpdate({ ...state, calibration_samples: 9 }, "p", 1, true, new Date());
    expect(r.prompts.join()).toMatch(/清算/);
  });
});
