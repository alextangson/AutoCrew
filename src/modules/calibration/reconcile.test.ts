import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { saveContent } from "../../storage/local-store.js";
import { appendOutcomes } from "../flywheel/outcome-store.js";
import { commitPrediction } from "./commit.js";
import { readLedger } from "./ledger.js";
import { calibrationPool, readPredictions } from "./pool.js";
import { blindStep } from "./predict.js";
import { reconcileDue } from "./reconcile.js";
import { resetReconcileMemory } from "./reconcile-status.js";
import { retro } from "./retro.js";
import { calibrationReminders } from "./status.js";
import { appendLog, calibrationDir, ensureCalibration, serializeCalibration } from "./store.js";
import { BODY, predictPublished, SELF } from "./test-fixtures.js";

const DAY = 86_400_000;
const ok = () => {};
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-rec-")); resetReconcileMemory(); });

const pubOf = (c: { publishedAt?: string | null }) => Date.parse(c.publishedAt as string);
const dayStr = (pub: number, n: number) => new Date(pub + n * DAY).toISOString().slice(0, 10);
async function outcome(contentId: string, pub: number, day: number, metrics: Record<string, number>, platform = "douyin", reasons: string[] = []) {
  await appendOutcomes([{ contentId, platform, platformTitle: "t", publishedAt: new Date(pub).toISOString(), metricDate: dayStr(pub, day), metrics,
    source: "auto", recordedAt: "", needsReview: reasons.length > 0, reviewReasons: reasons }], dir);
}
const retroCount = async () => (await readPredictions(dir)).retros.length;
const samples = async () => (await ensureCalibration(dir)).state.calibration_samples;
const rowOf = async (id: string) => (await readLedger(dir, new Date(Date.now() + 3.5 * DAY))).rows.find((r) => r.id === id)!;

describe("自动数字对账（预测账本规格 §二）", () => {
  it("T+3 到期且有回流：追加数字对账、计 1 个样本、进校准池，账本显示已对账（待解读）", async () => {
    const { p, later } = await predictPublished(dir, 2000);
    const s = await reconcileDue(dir, { now: later, guard: ok });
    expect(s).toMatchObject({ ok: true, written: [{ prediction_id: p.prediction_id, kind: "t3" }] });
    expect(await samples()).toBe(1);
    expect(await calibrationPool(dir)).toHaveLength(1);
    const row = await rowOf(p.prediction_id as string);
    expect(row.status).toBe("reconciled");
    expect(row.actual).toMatchObject({ views: 2000, by: "auto", source: "回流" });
    expect(typeof row.actual!.hit).toBe("boolean");
    expect((await readPredictions(dir)).retros[0].hypothesis_conclusion).toBeUndefined();
  });

  it("再跑一轮不重复写、不重复计数", async () => {
    const { later } = await predictPublished(dir, 2000);
    await reconcileDue(dir, { now: later, guard: ok });
    expect((await reconcileDue(dir, { now: later, guard: ok })).written).toEqual([]);
    expect(await retroCount()).toBe(1);
    expect(await samples()).toBe(1);
  });

  it("没满 3 天不碰（永不提前）；账本显示待复盘与到期日", async () => {
    const { p, c } = await predictPublished(dir, 2000);
    expect((await reconcileDue(dir, { now: new Date(), guard: ok })).written).toEqual([]);
    expect(await retroCount()).toBe(0);
    const row = (await readLedger(dir)).rows[0];
    expect(row).toMatchObject({ id: p.prediction_id, status: "pending" });
    expect(Date.parse(row.due_date!)).toBe(pubOf(c) + 3 * DAY);
  });

  it("满 3 天但只有 D+2 的快照：不拿提前的读数冒充 T+3，留在等数据", async () => {
    const { c, p } = await predictPublished(dir, null);
    await outcome(c.id, pubOf(c), 2, { views: 900 });
    const s = await reconcileDue(dir, { now: new Date(pubOf(c) + 3.2 * DAY), guard: ok });
    expect(s.written).toEqual([]);
    expect(s.waiting).toEqual([p.prediction_id]);
  });

  it("到期但没有回流：不对账、不当 0，账本显示等数据，晨报提醒", async () => {
    const { p, later } = await predictPublished(dir, null);
    const s = await reconcileDue(dir, { now: later, guard: ok });
    expect(s).toMatchObject({ ok: true, written: [], waiting: [p.prediction_id] });
    expect(await samples()).toBe(0);
    expect((await rowOf(p.prediction_id as string)).status).toBe("awaiting_data");
    expect((await calibrationReminders(dir, later)).join()).toMatch(/等数据/);
  });

  it("播放被标待复核：剔除后没有可用播放 = 等数据", async () => {
    const { c, p, later } = await predictPublished(dir, null);
    await outcome(c.id, pubOf(c), 3, { views: 99999, likes: 3 }, "douyin", ["播放量 突增 50 倍，待复核"]);
    expect((await reconcileDue(dir, { now: later, guard: ok })).waiting).toEqual([p.prediction_id]);
    expect(await retroCount()).toBe(0);
  });

  it("待复核的是别的指标：剔掉它，播放照样对账", async () => {
    const { c, later } = await predictPublished(dir, null);
    await outcome(c.id, pubOf(c), 3, { views: 1500, completionRate: 90 }, "douyin", ["完播率 90% 偏高，待复核"]);
    expect((await reconcileDue(dir, { now: later, guard: ok })).written).toHaveLength(1);
    expect((await readPredictions(dir)).retros[0].actual.views).toBe(1500);
  });

  it("事后补记（reconstructed）：跳过、不进样本，账本标事后补记", async () => {
    const c = await saveContent({ title: "旧片", body: "b", platform: "douyin", status: "draft_ready", tags: [], publishedAt: new Date(Date.now() - 5 * DAY).toISOString() } as never, dir);
    const b = await blindStep({ content_id: c.id, self_scores: SELF, reconstructed: true }, dir);
    const p = await commitPrediction({ blind_run_id: b.blind_run_id, ...BODY(["底部", "基础盘", "命中", "小爆", "大爆"]) }, dir);
    await outcome(c.id, pubOf(c), 3, { views: 500 });
    expect((await reconcileDue(dir, { guard: ok })).written).toEqual([]);
    expect(await samples()).toBe(0);
    expect((await readLedger(dir)).rows.find((r) => r.id === p.prediction_id)!.status).toBe("reconstructed");
  });

  it("带完整性警告的预测：跳过、不进样本，账本标完整性警告", async () => {
    const { p, later } = await predictPublished(dir, 2000);
    await serializeCalibration(dir, () => appendLog("predictions", { type: "integrity_warning", prediction_id: p.prediction_id, at: "x", detail: "测试" }, dir));
    expect((await reconcileDue(dir, { now: later, guard: ok })).written).toEqual([]);
    expect(await samples()).toBe(0);
    expect((await rowOf(p.prediction_id as string)).status).toBe("integrity_warning");
  });

  it("已经手动复盘过：自动对账不重复写", async () => {
    const { p, later } = await predictPublished(dir, 2000);
    await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "钩子撑住了" }, dir, later);
    expect((await reconcileDue(dir, { now: later, guard: ok })).written).toEqual([]);
    expect(await retroCount()).toBe(1);
    expect(await samples()).toBe(1);
    expect((await rowOf(p.prediction_id as string)).status).toBe("interpreted");
  });

  it("丢写入锁：一行不写，账本汇总与晨报显示原因", async () => {
    const { later } = await predictPublished(dir, 2000);
    const lost = () => { throw new Error("library_writer_lost: 当前服务已失去资料库写入权；不会自动抢占。"); };
    const s = await reconcileDue(dir, { now: later, guard: lost });
    expect(s).toMatchObject({ ok: false, code: "library_writer_lost", written: [] });
    expect(await retroCount()).toBe(0);
    expect((await readLedger(dir)).summary.reconcile).toMatchObject({ ok: false, code: "library_writer_lost" });
    expect((await calibrationReminders(dir)).join()).toMatch(/自动对账没写成/);
  });

  it("日志完整性校验失败：不写，原因可见", async () => {
    const { later } = await predictPublished(dir, 2000);
    const file = path.join(calibrationDir(dir), "predictions.jsonl");
    await fs.writeFile(file, (await fs.readFile(file, "utf-8")).replace(/"center":\d+/, "\"center\":901"));
    const s = await reconcileDue(dir, { now: later, guard: ok });
    expect(s).toMatchObject({ ok: false, code: "integrity", written: [] });
    expect(s.error).toMatch(/完整性/);
    expect((await readLedger(dir, later)).summary.integrity_problems.length).toBeGreaterThan(0);
    expect((await calibrationReminders(dir)).join()).toMatch(/完整性/);
  });

  it("多平台：每条预测只读自己平台的回流，各自对账", async () => {
    const a = await predictPublished(dir, null, "片 A");
    await outcome(a.c.id, pubOf(a.c), 3, { views: 700 });
    await outcome(a.c.id, pubOf(a.c), 3, { views: 88888 }, "xiaohongshu");
    const b = await predictPublished(dir, null, "片 B");
    await outcome(b.c.id, pubOf(b.c), 3, { views: 40 });
    const s = await reconcileDue(dir, { now: a.later, guard: ok });
    expect(s.written).toHaveLength(2);
    const { retros } = await readPredictions(dir);
    expect(retros.find((r) => r.prediction_id === a.p.prediction_id)!.actual.views).toBe(700);
    expect(retros.find((r) => r.prediction_id === b.p.prediction_id)!.actual.views).toBe(40);
  });

  it("D+7 追加一次读数：不改样本数、只追加一次", async () => {
    const { c, p } = await predictPublished(dir, 2000);
    await outcome(c.id, pubOf(c), 7, { views: 5000 });
    const d7 = new Date(pubOf(c) + 7.2 * DAY);
    const s = await reconcileDue(dir, { now: d7, guard: ok });
    expect(s.written.map((w) => w.kind)).toEqual(["t3", "d7"]);
    await reconcileDue(dir, { now: d7, guard: ok });
    expect((await readPredictions(dir)).readings).toHaveLength(1);
    expect(await samples()).toBe(1);
    expect((await readLedger(dir, d7)).rows[0].d7).toMatchObject({ views: 5000 });
  });

  it("还没做过任何预测：不建校准目录", async () => {
    await reconcileDue(dir, { guard: ok });
    await expect(fs.stat(calibrationDir(dir))).rejects.toThrow();
  });
});

describe("解读另行追加（创始人裁定 1）", () => {
  it("自动对账后 calib_retro 只追加解读：样本不再 +1，账本变已解读；再补一次被拒", async () => {
    const { p, later } = await predictPublished(dir, 2000);
    await reconcileDue(dir, { now: later, guard: ok });
    const r = await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "钩子撑住了", observations: ["具体场景开头留人"] }, dir, later);
    expect(r).toMatchObject({ ok: true, appended: "interpretation", counted_as_calibration_sample: false });
    expect(await samples()).toBe(1);
    expect((await rowOf(p.prediction_id as string)).status).toBe("interpreted");
    expect(await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "再来" }, dir, later)).toMatchObject({ code: "retro_exists" });
    expect(await samples()).toBe(1);
  });

  it("解读缺结论：拒绝，不写", async () => {
    const { p, later } = await predictPublished(dir, 2000);
    await reconcileDue(dir, { now: later, guard: ok });
    await expect(retro({ prediction_id: p.prediction_id }, dir, later)).rejects.toThrow();
    expect((await readPredictions(dir)).interpretations).toHaveLength(0);
  });
});
