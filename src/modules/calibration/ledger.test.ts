import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countsOf, hitRate, readLedger, type LedgerRow } from "./ledger.js";
import { ledgerAlerts } from "./ledger-alerts.js";
import type { PoolSample } from "./pool.js";
import { calibrationDir, type CalibrationState } from "./store.js";

const row = (status: LedgerRow["status"], due: string | null = null) => ({ status, due_date: due }) as LedgerRow;
const state = (over: Partial<CalibrationState>) => ({ consecutive_directional_errors: [], calibration_samples: 0, samples_at_last_cleanup: 0, last_bump_at: null, ...over }) as CalibrationState;
const sample = (center: number, actual: number, at = "2026-10-01T00:00:00Z") =>
  ({ prediction: { title: "片", body: { center } }, retro: { at }, actual }) as unknown as PoolSample;

describe("账本读模型", () => {
  it("一条预测都没有：空列表、样本 0、不建目录", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-"));
    const l = await readLedger(dir);
    expect(l.rows).toEqual([]);
    expect(l.summary).toMatchObject({ samples: 0, rubric_version: null, alerts: [], reconcile: null });
    await expect(fs.stat(calibrationDir(dir))).rejects.toThrow();
  });
  it("命中率按平台分开算", () => {
    const r = hitRate([{ platform: "douyin", hit: true }, { platform: "douyin", hit: false }, { platform: "xiaohongshu", hit: true }]);
    expect(r.find((x) => x.platform === "douyin")).toEqual({ platform: "douyin", n: 2, hits: 1 });
    expect(r.find((x) => x.platform === "xiaohongshu")).toMatchObject({ n: 1, hits: 1 });
  });
  it("计数：已到期的待复盘、等数据、待解读分开数", () => {
    const now = new Date("2026-10-04T00:00:00Z");
    const c = countsOf([row("pending", "2026-10-03T00:00:00Z"), row("pending", "2026-10-06T00:00:00Z"), row("awaiting_data"), row("reconciled"), row("interpreted")], now);
    expect(c).toEqual({ pending: 2, due: 1, awaiting_data: 1, awaiting_interpretation: 1 });
  });
  it("提醒：连续 3 次同向 / 上次升级后单次 ≥10 倍 / 满 10 条新样本", () => {
    const e = (dir: "high" | "low") => ({ dir, ratio: 0.5, prediction_id: "x" });
    expect(ledgerAlerts(state({ consecutive_directional_errors: [e("low"), e("low"), e("low")] }), []).join()).toMatch(/连续 3 次低估/);
    expect(ledgerAlerts(state({}), [sample(100, 1500)]).join()).toMatch(/≥10 倍/);
    expect(ledgerAlerts(state({ last_bump_at: "2026-10-02T00:00:00Z" }), [sample(100, 1500)])).toEqual([]);
    expect(ledgerAlerts(state({ calibration_samples: 12, samples_at_last_cleanup: 2 }), []).join()).toMatch(/清算/);
    expect(ledgerAlerts(state({ calibration_samples: 5 }), [sample(100, 120)])).toEqual([]);
  });
});
