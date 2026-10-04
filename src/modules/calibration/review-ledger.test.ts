/** Codex 审 feature/prediction-ledger：丢写入锁时校准追加不得先写行；state.json 坏了要报错 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lock = vi.hoisted(() => ({ lost: false }));
vi.mock("../../storage/storage-roots.js", async (orig) => {
  const real = await orig<typeof import("../../storage/storage-roots.js")>();
  const check = () => { if (lock.lost) throw new Error("library_writer_lost: 测试丢锁"); };
  return { ...real, assertManagedPathAvailable: (p: string) => { check(); real.assertManagedPathAvailable(p); },
    assertDataDirWritable: (d?: string) => { check(); real.assertDataDirWritable(d); } };
});

const { readLedger } = await import("./ledger.js");
const { reconcileDue } = await import("./reconcile.js");
const { resetReconcileMemory } = await import("./reconcile-status.js");
const { retro } = await import("./retro.js");
const { calibrationReminders } = await import("./status.js");
const { calibrationDir } = await import("./store.js");
const { predictPublished } = await import("./test-fixtures.js");

let dir: string;
beforeEach(async () => { lock.lost = false; resetReconcileMemory(); dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-rv-")); });
const lines = async () => (await fs.readFile(path.join(calibrationDir(dir), "predictions.jsonl"), "utf-8")).trim().split("\n").length;

describe("P1 丢写入锁：校准追加在第一次写之前就拒绝", () => {
  it("补解读时丢锁：一行不写；拿回锁后重试能补上", async () => {
    const { p, later } = await predictPublished(dir, 2000);
    await reconcileDue(dir, { now: later, guard: () => {} });
    const before = await lines();
    lock.lost = true;
    await expect(retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "钩子撑住了" }, dir, later)).rejects.toThrow(/library_writer_lost/);
    expect(await lines()).toBe(before);
    lock.lost = false;
    expect(await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "钩子撑住了" }, dir, later)).toMatchObject({ ok: true, appended: "interpretation" });
  });
  it("修正（correction）时丢锁：一行不写", async () => {
    const { p, later } = await predictPublished(dir, 2000);
    const before = await lines();
    lock.lost = true;
    await expect(retro({ prediction_id: p.prediction_id, correction: "笔误" }, dir, later)).rejects.toThrow(/library_writer_lost/);
    expect(await lines()).toBe(before);
  });
});

describe("P2 state.json 坏了：不是「还没初始化」", () => {
  it("自动对账报错，账本与晨报可见", async () => {
    const { later } = await predictPublished(dir, 2000);
    await fs.writeFile(path.join(calibrationDir(dir), "state.json"), "{坏");
    const s = await reconcileDue(dir, { now: later, guard: () => {} });
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/state\.json|损坏/);
    const l = await readLedger(dir, later);
    expect(l.summary.reconcile?.ok).toBe(false);
    expect(l.summary.integrity_problems.join()).toMatch(/损坏/);
    expect((await calibrationReminders(dir, later)).join()).toMatch(/损坏/);
  });
});
