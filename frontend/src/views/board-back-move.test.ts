import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
const revokeHandoff = vi.fn(async (..._a: unknown[]) => ({ ok: true, data: { ok: true, aroll_restored_to: "/Users/x/Downloads/a.mp4" } }));
const toast = vi.fn();
vi.mock("../transport", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../ui", () => ({ confirmDialog: async () => true, openDialog: async () => null, toast: (m: string) => toast(m) }));
vi.mock("./board-api", () => ({ revokeHandoff: (...a: unknown[]) => revokeHandoff(...a), markPublished: vi.fn(), unmarkPublished: vi.fn() }));

import { confirmBackMove, revokeText } from "./BoardCards";
import { backMoves, type BoardItem } from "./board-columns";

const item = (over: Partial<BoardItem>): BoardItem => ({
  id: "content-1-a", title: "t", platform: "douyin", status: "editing", topicId: null, column: "剪辑中",
  createdAt: "", updatedAt: "", draftReadyAt: null, chars: 0, finalDurationMs: null,
  cover: null, publish: null, publishTime: null, lastError: null, blockedReason: null, ...over,
});

describe("往回退的调用", () => {
  beforeEach(() => { invoke.mockClear(); revokeHandoff.mockClear(); toast.mockClear(); });

  it("剪辑中「撤回交接」走真正的撤回，不做普通状态流转；回执说原片放回哪", async () => {
    const it0 = item({ handoffHash: "h1" });
    const reload = vi.fn(async () => {});
    await confirmBackMove(it0, backMoves(it0)[0], reload);
    expect(revokeHandoff).toHaveBeenCalledWith("content-1-a", "h1");
    expect(invoke).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("已撤回交接，原片放回 /Users/x/Downloads/a.mp4");
    expect(reload).toHaveBeenCalled();
  });

  it("看板没拿到交接代次：不发撤回，提示刷新", async () => {
    const it0 = item({ handoffHash: null });
    const reload = vi.fn(async () => {});
    await confirmBackMove(it0, backMoves(it0)[0], reload);
    expect(revokeHandoff).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("看板上没有这条的交接代次，刷新一下再撤");
    expect(reload).toHaveBeenCalled();
  });

  it("其它退路仍是带 from_status 的状态流转", async () => {
    const it0 = item({ status: "approved", column: "待录制" });
    await confirmBackMove(it0, backMoves(it0)[0], async () => {});
    expect(invoke).toHaveBeenCalledWith("content:transition", { id: "content-1-a", from_status: "approved", target_status: "reviewing" });
    expect(revokeHandoff).not.toHaveBeenCalled();
  });

  it("原片没挪回、撤回失败都说出来", () => {
    expect(revokeText({ ok: true, data: { aroll_restore_failed: "被占用" } })).toContain("原片没挪回：被占用");
    expect(revokeText({ ok: false, error: "稿件现在是「封面设计」" })).toBe("稿件现在是「封面设计」");
  });
});
