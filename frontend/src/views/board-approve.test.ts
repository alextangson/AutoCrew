/** 看板拖「写稿中 → 待录制」认稿（整分支审 4 P1）：走「等你拍板」入口、带看板载入时那一版稿的代次 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const decided: Array<Record<string, unknown>> = [];
const toasts: string[] = [];
const invoke = vi.fn(async () => ({ ok: true }));
vi.mock("./review/review-api", () => ({ decideItem: async (p: Record<string, unknown>) => { decided.push(p); return { ok: false, error: "稿子刚改过，重新看一眼" }; } }));
vi.mock("../transport", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])), subscribeEvents: () => () => {}, authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "x" }));
vi.mock("../ui", () => ({ toast: (m: string) => { toasts.push(m); }, confirmDialog: async () => true, openDialog: async () => null }));

beforeEach(() => { decided.length = 0; toasts.length = 0; invoke.mockClear(); });

describe("拖卡认稿", () => {
  it("带 draftRef 交到单一入口；服务端说稿子改过就照实说，不走旧的状态流转", async () => {
    const { approveDraft } = await import("./Board");
    await approveDraft({ id: "content-1-a", status: "draft_ready", draftRef: { item_id: "draft:content-1-a", gen: "g-board" } } as never, async () => {});
    expect(decided).toEqual([{ content_id: "content-1-a", item_id: "draft:content-1-a", gen: "g-board", action: "approve_script" }]);
    expect(invoke).not.toHaveBeenCalled();
    expect(toasts).toEqual(["稿子刚改过，重新看一眼"]);
  });
});
