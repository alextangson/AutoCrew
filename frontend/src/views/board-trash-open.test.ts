// @vitest-environment happy-dom
/** spec 2026-10-04：稿件卡「移入回收站」只给前三列、正在写就拒、确认取消不动；点卡标题直接进稿件页 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardItem } from "./board-columns";

const toasts: string[] = [];
const invoke = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
let confirmAnswer = true;
const confirms: string[] = [];
let boardItems: BoardItem[] = [];
vi.mock("../transport", () => ({ invoke: (...a: unknown[]) => invoke(...a), subscribeEvents: () => () => {}, authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "x" }));
vi.mock("../ui", () => ({
  toast: (m: string) => { toasts.push(m); },
  confirmDialog: async (d: { title: string }) => { confirms.push(d.title); return confirmAnswer; },
  openDialog: async () => null,
}));
vi.mock("./board-api", () => ({
  loadBoard: async () => ({ ok: true, data: { items: boardItems, topics: [], wordsPerMinute: null } }),
  markPublished: async () => ({ ok: true, data: {} }), unmarkPublished: async () => ({ ok: true, data: {} }), revokeHandoff: async () => ({ ok: true, data: {} }),
  decide: async () => ({ ok: true, data: {} }), loadCard: async () => ({ ok: false, error: "x" }), reopenScript: async () => ({ ok: true, data: {} }),
  startWriting: async () => ({ ok: true, data: {} }),
}));
vi.mock("./review/ReviewInbox", () => ({ ReviewInbox: () => null }));
vi.mock("./update/UpdateBanner", () => ({ UpdateBanner: () => null }));

const item = (column: BoardItem["column"], over: Partial<BoardItem> = {}): BoardItem => ({
  id: "content-1-a", title: "某稿", platform: "douyin", status: column === "写稿中" ? "draft_ready" : "approved", topicId: null, column,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", draftReadyAt: null, chars: 10, finalDurationMs: null,
  cover: null, publish: null, publishTime: null, lastError: null, blockedReason: null, writing: false, ...over,
});

beforeEach(() => { toasts.length = 0; confirms.length = 0; invoke.mockClear(); confirmAnswer = true; boardItems = []; });

describe("「移入回收站」菜单项", () => {
  it("只在 写稿中 / 待录制 的稿件卡上出现，剪辑中 / 待发布 / 已发布没有", async () => {
    const { ItemCard } = await import("./BoardCards");
    const html = (c: BoardItem["column"], status?: string) => renderToStaticMarkup(createElement(ItemCard, {
      item: item(c, status ? { status } : {}), wpm: null, busy: false, onOpen: () => {}, onMenu: () => {}, reload: async () => {}, onDragStart: () => {}, onDragEnd: () => {},
    }));
    expect(html("写稿中")).toContain("移入回收站");
    expect(html("待录制")).toContain("移入回收站");
    expect(html("剪辑中", "editing")).not.toContain("移入回收站");
    expect(html("待发布", "cover_pending")).not.toContain("移入回收站");
    expect(html("已发布", "published")).not.toContain("移入回收站");
  });
});

describe("trashItem", () => {
  it("正在写：照实拒绝，不弹确认、不删", async () => {
    const { trashItem } = await import("./BoardCards");
    boardItems = [item("写稿中", { status: "drafting", writing: true })];
    await trashItem(item("写稿中", { writing: false }), async () => {});
    expect(toasts).toEqual(["这篇正在写，先停掉再弃用"]);
    expect(confirms).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("确认框取消：什么都不做", async () => {
    const { trashItem } = await import("./BoardCards");
    boardItems = [item("待录制")];
    confirmAnswer = false;
    const reload = vi.fn(async () => {});
    await trashItem(item("待录制"), reload);
    expect(confirms).toEqual(["移入回收站？"]);
    expect(invoke).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
  it("确认后软删除、提示可恢复、刷新看板", async () => {
    const { trashItem } = await import("./BoardCards");
    boardItems = [item("写稿中")];
    const reload = vi.fn(async () => {});
    await trashItem(item("写稿中"), reload);
    expect(invoke).toHaveBeenCalledWith("content:delete", { id: "content-1-a", board_guard: true });
    expect(toasts).toEqual(["已移入回收站（可恢复）"]);
    expect(reload).toHaveBeenCalled();
  });
  it("看板重读时已进了后面的列：拒绝", async () => {
    const { trashItem } = await import("./BoardCards");
    boardItems = [item("剪辑中", { status: "editing" })];
    await trashItem(item("待录制"), async () => {});
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("回收站里的稿件能恢复", () => {
  it("列出稿件，点恢复走 content:restore", async () => {
    invoke.mockImplementation(async (ch: unknown) => (ch === "trash:list"
      ? { ok: true, data: { topics: [], contents: [{ id: "content-1-a", title: "弃用的稿", platform: "douyin" }] } } as never
      : { ok: true }));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { BoardTrash } = await import("./BoardTrash");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(createElement(BoardTrash, { back: () => {} })); });
    expect(el.textContent).toContain("弃用的稿");
    const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "恢复")!;
    await act(async () => { btn.click(); });
    expect(invoke).toHaveBeenCalledWith("content:restore", { id: "content-1-a" });
    expect(toasts).toContain("已恢复");
    root.unmount();
    invoke.mockImplementation(async () => ({ ok: true }));
  });
});

describe("点卡直接进稿件页", () => {
  it("本体启用的视频卡点标题也直接 openEditor，不弹卡片面板", async () => {
    boardItems = [item("待录制", { active: true })];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { Board } = await import("./Board");
    const openEditor = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(createElement(Board, { openTopic: () => {}, openEditor, openData: () => {} }));
    });
    const title = [...el.querySelectorAll("button.bcard-title")].find((b) => b.textContent?.includes("某稿"))!;
    await act(async () => { title.click(); });
    expect(openEditor).toHaveBeenCalledWith("content-1-a");
    expect(el.querySelector("[aria-label='卡片详情']")).toBeNull();
    root.unmount();
  });
});

describe("确认框开着期间状态变了", () => {
  it("确认后再重读一次：这时已经开始写了 → 拒绝，不删", async () => {
    const { trashItem } = await import("./BoardCards");
    boardItems = [item("写稿中")];
    const ui = await import("../ui");
    const spy = vi.spyOn(ui, "confirmDialog").mockImplementation(async () => { boardItems = [item("写稿中", { status: "drafting", writing: true })]; return true; });
    await trashItem(item("写稿中"), async () => {});
    expect(invoke).not.toHaveBeenCalled();
    expect(toasts).toContain("这篇正在写，先停掉再弃用");
    spy.mockRestore();
  });
  it("看板删除带上服务端校验标记", async () => {
    const { trashItem } = await import("./BoardCards");
    boardItems = [item("待录制")];
    await trashItem(item("待录制"), async () => {});
    expect(invoke).toHaveBeenCalledWith("content:delete", { id: "content-1-a", board_guard: true });
  });
});
