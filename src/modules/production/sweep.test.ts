/** Codex 审 manual-intake：巡检只同步默认工作区的「我的内容」视图；资料库断开时定时巡检不崩、看得见 */
import { afterEach, describe, expect, it, vi } from "vitest";

const view = vi.fn(async (..._args: unknown[]) => ({ created: 0, updated: 0, removed: 0, preservedEdits: 0, errors: [] as string[] }));
vi.mock("../../storage/my-content-view.js", () => ({ syncMyContentView: (...a: unknown[]) => view(...a) }));
vi.mock("./reconcile.js", () => ({ reconcileAll: async () => ({ at: "", enabled: true, errors: [], moves: [], warnings: [] }) }));

const { runSweep, setSweepRunner, startSweepLoop, sweepHealth } = await import("./sweep.js");
const { executeReviewInbox } = await import("../../tools/review-inbox.js");

afterEach(() => { setSweepRunner(null); view.mockClear(); });

describe("巡检的视图归属", () => {
  it("从非默认工作区触发：对账用这个工作区，「我的内容」视图只按默认工作区同步（不传工作区）", async () => {
    await runSweep("/lib/workspaces/other");
    expect(view).toHaveBeenCalledTimes(1);
    expect(view.mock.calls[0]).toEqual([]);
  });
});

describe("资料库断开时的定时巡检", () => {
  it("解析工作区抛错：tick 不抛、记日志、sweepHealth 记下，对话 sync 带出来", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const setIntervalSpy = vi.fn(() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout);
    expect(() => startSweepLoop(() => { throw new Error("资料库没连上"); }, { setInterval: setIntervalSpy as unknown as typeof setInterval })).not.toThrow();
    const tick = (setIntervalSpy.mock.calls[0] as unknown as [() => void])[0];
    expect(() => tick()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(sweepHealth()).toMatchObject({ error: "资料库没连上" });
    expect(err).toHaveBeenCalled();
    setSweepRunner(async () => ({ errors: [], warnings: [], view_errors: [] }));
    expect(await executeReviewInbox({ _dataDir: "/tmp/x", action: "sync" })).toMatchObject({ ok: true, scheduled_error: { error: "资料库没连上" } });
    err.mockRestore();
  });
});
