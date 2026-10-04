import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { saveContent } from "../../storage/local-store.js";
import { BLIND_SYSTEM_PROMPT, buildBlindRequest, parseBlindScores } from "./blind.js";
import { commitPrediction } from "./commit.js";
import { bucketOf, confidenceFor, deriveBaseline, deriveBuckets } from "./derive.js";
import { blindCheck, blindStep } from "./predict.js";
import { readPredictionBody } from "./predict-input.js";
import { BODY, fakeLoop, SELF } from "./test-fixtures.js";
import { ALL_DIMS } from "./rubric.js";
import { calibrationDir, ensureCalibration, readLog } from "./store.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";


const DEFAULT_NAMES = ["底部", "基础盘", "命中", "小爆", "大爆"];

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-p-")); });
const mk = (extra: Record<string, unknown> = {}) => saveContent({ _provenance: HUMAN_WRITE, title: "AI 写的周报被领导看出来了", body: "下班前领导一句明早给我……", platform: "douyin", status: "draft_ready", tags: [], ...extra } as never, dir);

describe("§二 派生表", () => {
  it("Confidence 只由样本数决定（0/1-2/3-5/6-10/11-20/21+）", () => {
    expect([0, 1, 2, 3, 5, 6, 10, 11, 20, 21, 99].map((n) => confidenceFor(n).label)).toEqual(
      ["🔴 极低", "🟠 低", "🟠 低", "🟡 偏低", "🟡 偏低", "🟢 中", "🟢 中", "🟢 较高", "🟢 较高", "🔵 高", "🔵 高"]);
  });
  it("bucket：无基线用平台默认；有基线按 ×0.3/1/3/10 切 5 档", () => {
    expect(deriveBuckets(null).buckets.map((b) => [b.min, b.max])).toEqual([[0, 100], [100, 1000], [1000, 10000], [10000, 100000], [100000, null]]);
    const r = deriveBuckets({ plays: 1000, source: "age_cohort_d3", n: 3, computed_at: "" });
    expect(r.scheme).toBe("ratio");
    expect(r.buckets.map((b) => b.min)).toEqual([0, 300, 1000, 3000, 10000]);
    expect(bucketOf(2999, r.buckets).name).toBe("命中");
    expect(bucketOf(50_000, r.buckets).name).toBe("大爆");
  });
  it("基线：池 ≥10 用池中位数；否则用同平台 D+3 同龄（剔待复核）", () => {
    expect(deriveBaseline("douyin", [], Array.from({ length: 10 }, (_, i) => (i + 1) * 100))?.source).toBe("calibration_pool");
    const row = (id: string, views: number, needsReview = false) => ({ contentId: id, platform: "douyin", platformTitle: id, publishedAt: "2026-09-01T00:00:00Z", metricDate: "2026-09-04", metrics: { views }, source: "auto", recordedAt: "", needsReview, reviewReasons: needsReview ? ["不认识的理由"] : [] });
    const b = deriveBaseline("douyin", [row("a", 100), row("b", 300), row("c", 9999, true)] as never, []);
    expect(b).toMatchObject({ plays: 200, source: "age_cohort_d3", n: 2 });
    expect(deriveBaseline("douyin", [], [])).toBeNull();
  });
  it("冷启动分布要更平、合计 100、headline=最高档、中枢在本档", () => {
    const bs = deriveBuckets(null).buckets;
    const ok = BODY(DEFAULT_NAMES).prediction;
    expect(readPredictionBody(ok, bs, 0).bucket).toBe("基础盘");
    expect(() => readPredictionBody({ ...ok, distribution: { ...ok.distribution, 底部: 31 } }, bs, 0)).toThrow(/100%/);
    expect(() => readPredictionBody({ ...ok, bucket: "底部" }, bs, 0)).toThrow(/不是概率最高/);
    expect(() => readPredictionBody({ ...ok, center: 5000 }, bs, 0)).toThrow(/不在/);
    const sharp = { ...ok, distribution: { 底部: 5, 基础盘: 80, 命中: 10, 小爆: 4, 大爆: 1 } };
    expect(() => readPredictionBody(sharp, bs, 0)).toThrow(/冷启动/);
    expect(readPredictionBody(sharp, bs, 5).bucket).toBe("基础盘");
  });
});

describe("§二 盲度检查", () => {
  it("≥3 天拒绝；<3 天必须明确没看过数据；看过数据一律拒绝", () => {
    expect(blindCheck(3.1, false)?.code).toBe("not_blind");
    expect(blindCheck(1, undefined)?.code).toBe("seen_data_unknown");
    expect(blindCheck(1, false)).toBeNull();
    expect(blindCheck(null, true)?.code).toBe("not_blind");
    expect(blindCheck(null, undefined)).toBeNull();
  });
});

describe("§二 盲评通道隔离", () => {
  it("B 的请求只含稿子全文 + rubric.json，走主线路快模型", async () => {
    const c = await mk();
    await ensureCalibration(dir);
    const captured: Array<{ config: unknown; opts: Record<string, unknown> }> = [];
    const r = await blindStep({ content_id: c.id, self_scores: SELF }, dir, { runLoopImpl: fakeLoop(SELF, captured) });
    expect(r.ok).toBe(true);
    const { rubric } = await ensureCalibration(dir);
    const expected = buildBlindRequest(`标题：${c.title}\n\n${c.body}`, rubric);
    expect(captured[0].opts.systemPrompt).toBe(BLIND_SYSTEM_PROMPT);
    expect(captured[0].opts.userMessage).toBe(expected.userMessage);
    expect(captured[0].opts.history).toBeUndefined();
    expect(String(captured[0].opts.userMessage)).not.toMatch(/calibration_samples|pending_retros|blind_run|prediction/);
    expect(captured[0].opts.model).toBe("deepseek-v4-flash");
  });
  it("坏的模型分数打回（不当成空分）；JSON 串照收", () => {
    expect(parseBlindScores("{\"ER\":1}").error).toMatch(/SR|ER/);
    const good = Object.fromEntries(ALL_DIMS.map((d) => [d, JSON.stringify({ score: "4", confidence: "high", reason: "x" })]));
    expect(parseBlindScores(good).scores?.ER.score).toBe(4);
  });
  it("B 失败 → 记 failed、ok:false 可见，不落预测、不静默改自评", async () => {
    const c = await mk();
    const r = await blindStep({ content_id: c.id, self_scores: SELF }, dir, { runLoopImpl: (async () => { throw new Error("relay 502"); }) as never });
    expect(r).toMatchObject({ ok: false, code: "blind_failed" });
    const runs = await readLog<{ status: string; error: string }>("blind-runs", dir);
    expect(runs.records[0]).toMatchObject({ status: "failed" });
    await expect(commitPrediction({ blind_run_id: r.blind_run_id, ...BODY(DEFAULT_NAMES) }, dir)).rejects.toThrow(/失败/);
  });
});

describe("§二 落预测", () => {
  async function blindThen(scores = SELF) {
    const c = await mk();
    const b = await blindStep({ content_id: c.id, self_scores: SELF }, dir, { runLoopImpl: fakeLoop(scores) });
    return { c, b };
  }
  it("分歧 ≥2 的维度必须裁定；所有维度都记 delta（含 0）", async () => {
    const { b } = await blindThen({ ...SELF, ER: 5 });
    expect(b.needs_decision).toEqual(["ER"]);
    await expect(commitPrediction({ blind_run_id: b.blind_run_id, ...BODY(DEFAULT_NAMES) }, dir)).rejects.toThrow(/ER/);
    const r = await commitPrediction({ blind_run_id: b.blind_run_id, decisions: { ER: "self" }, ...BODY(DEFAULT_NAMES) }, dir);
    expect(r.ok).toBe(true);
    const rec = (await readLog<{ header: { blind_score_disagreement: unknown[]; user_override: boolean } }>("predictions", dir)).records[0];
    expect(rec.header.blind_score_disagreement).toHaveLength(9);
    expect(rec.header.user_override).toBe(true);
  });
  it("不可改：同一盲评不能落第二次；同稿再预测只能 redo_of，原记录保留", async () => {
    const { c, b } = await blindThen();
    const first = await commitPrediction({ blind_run_id: b.blind_run_id, ...BODY(DEFAULT_NAMES) }, dir);
    await expect(commitPrediction({ blind_run_id: b.blind_run_id, ...BODY(DEFAULT_NAMES) }, dir)).rejects.toThrow(/不可改/);
    expect(await blindStep({ content_id: c.id, self_scores: SELF }, dir, { runLoopImpl: fakeLoop(SELF) })).toMatchObject({ ok: false, code: "prediction_exists" });
    const b2 = await blindStep({ content_id: c.id, self_scores: SELF, redo_of: first.prediction_id }, dir, { runLoopImpl: fakeLoop(SELF) });
    const second = await commitPrediction({ blind_run_id: b2.blind_run_id, ...BODY(DEFAULT_NAMES) }, dir);
    expect(second.prediction_id).toBe(`${String(first.prediction_id)}_redo`);
    expect((await readLog("predictions", dir)).records).toHaveLength(2);
  });
  it("skip_blind 记 self-scored，状态提醒；走盲评后清掉", async () => {
    const c = await mk();
    const b = await blindStep({ content_id: c.id, self_scores: SELF, skip_blind: true }, dir);
    await commitPrediction({ blind_run_id: b.blind_run_id, ...BODY(DEFAULT_NAMES) }, dir);
    const st = JSON.parse(await fs.readFile(path.join(calibrationDir(dir), "state.json"), "utf-8"));
    expect(st.last_prediction_self_scored).toBe(true);
    expect(st.pending_retros).toHaveLength(1);
  });
  it("已发布 ≥3 天只能 reconstructed，记录标明不是盲预测", async () => {
    const c = await mk({ publishedAt: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    expect(await blindStep({ content_id: c.id, self_scores: SELF, seen_data: false }, dir)).toMatchObject({ code: "not_blind" });
    const b = await blindStep({ content_id: c.id, self_scores: SELF, reconstructed: true }, dir);
    const r = await commitPrediction({ blind_run_id: b.blind_run_id, ...BODY(DEFAULT_NAMES) }, dir);
    expect(r.reconstructed).toBe(true);
  });
});
