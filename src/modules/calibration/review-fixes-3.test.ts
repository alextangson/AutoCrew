/** Codex 第三轮（99dcdcb6）失败路径的回归测试 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { proposeBump } from "./bump.js";
import { retro } from "./retro.js";
import { acknowledgeLogDamage, appendLog, calibrationDir, ensureCalibration, readLog, serializeCalibration, snapshotSizes as snapshotLogs, truncateTo } from "./store.js";
import { audit, engine, predictPublished, SELF } from "./test-fixtures.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-fix3-")); });
const ER_HEAVY = { weights: { ER: 3, SR: 1.5, HP: 1.5, QL: 1, NA: 1, AB: 1, SAT: 1 }, divisor: 10, multiplier: 2 };

async function damageMemoTail() {
  await serializeCalibration(dir, async () => { for (const n of [1, 2]) await appendLog("rubric-memo", { type: "note", n }, dir); });
  const f = path.join(calibrationDir(dir), "rubric-memo.jsonl");
  const lines = (await fs.readFile(f, "utf-8")).trim().split("\n");
  await fs.writeFile(f, `${lines.slice(0, -1).join("\n")}\n`);
}
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe("第三轮", () => {
  it("P1 memo 末尾被删：升级在清算前整体拒绝，损坏照旧可见，不被回滚洗白", async () => {
    await engine(dir, true);
    for (let i = 0; i < 5; i++) {
      const { p, later } = await predictPublished(dir, 100 * (i + 1) ** 2, `样本${i}`, { ...SELF, ER: i });
      await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x" }, dir, later);
    }
    await damageMemoTail();
    const r = await proposeBump({ formula: ER_HEAVY, kind: "default-aligned" }, dir, { auditLoop: audit("PASS") });
    expect(r).toMatchObject({ ok: false, code: "logs_damaged" });
    expect((await readLog("rubric-memo", dir)).integrity.ok).toBe(false);
    expect((await ensureCalibration(dir)).rubric.version).toBe("v2");
    expect((await readLog<{ type: string }>("predictions", dir)).records.some((x) => x.type === "rescored")).toBe(false);
    expect(await exists(path.join(calibrationDir(dir), "repairs.jsonl"))).toBe(false);
  });
  it("P1 回滚还原保存的链头，不按（可能已坏的）文件重算", async () => {
    await serializeCalibration(dir, () => appendLog("predictions", { type: "t", n: 1 }, dir));
    const snap = await snapshotLogs(dir);
    await serializeCalibration(dir, () => appendLog("predictions", { type: "t", n: 2 }, dir));
    // 回滚前文件被外部截坏：按文件重算会把损坏洗成「完好」
    const f = path.join(calibrationDir(dir), "predictions.jsonl");
    await fs.writeFile(f, "");
    await truncateTo(snap, dir);
    expect((await readLog("predictions", dir)).integrity.ok).toBe(false);
  });
  it("P2 memo 坏了时复盘带观察：一行都不写（全有或全无），修好后重试能正常计数", async () => {
    const { p, later } = await predictPublished(dir, 800);
    await damageMemoTail();
    await expect(retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", observations: ["具体场景开头更留人"] }, dir, later)).rejects.toThrow(/完整性/);
    expect((await readLog<{ type: string }>("predictions", dir)).records.some((x) => x.type === "retro")).toBe(false);
    await acknowledgeLogDamage("rubric-memo", "测试", dir);
    const r = await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", observations: ["具体场景开头更留人"] }, dir, later);
    expect(r).toMatchObject({ ok: true, counted_as_calibration_sample: true });
    expect((await ensureCalibration(dir)).state).toMatchObject({ calibration_samples: 1, pending_retros: [] });
  });
  it("P2 恢复记录写不进去 → 链头不动，损坏照旧可见", async () => {
    await damageMemoTail();
    await fs.mkdir(path.join(calibrationDir(dir), "repairs.jsonl")); // 让追加恢复记录失败
    await expect(acknowledgeLogDamage("rubric-memo", "测试", dir)).rejects.toThrow();
    expect((await readLog("rubric-memo", dir)).integrity.ok).toBe(false);
  });
});
