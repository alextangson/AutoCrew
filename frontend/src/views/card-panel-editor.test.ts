// @vitest-environment happy-dom
/** Codex 审 fix/board-trash-direct-open：稿件页里的进度区——没保存不许认稿、被拒后重读、读失败折叠着也看得见 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

let loads = 0;
let loadFails = false;
const decided: unknown[] = [];
const draft = { ok: true, id: "content-1-a", title: "新稿", status: "draft_ready", active: true, column: "写稿中", stage: null, reason: "", missing: [], badges: [], alerts: [], candidates: [], candidate_rows: [], published: [], pending_receipts: [], round: 1, can_reopen: false, arolls: [], draft_item: { item_id: "draft:content-1-a", gen: "g1" } };
vi.mock("./board-api", () => ({
  loadCard: async () => { loads += 1; return loadFails ? { ok: false, error: "服务端炸了" } : { ok: true, data: draft }; },
  decide: async () => ({ ok: true, data: {} }), chooseFile: async () => ({ ok: false, error: "x" }), reopenScript: async () => ({ ok: true, data: {} }),
  revealFact: async () => ({ ok: true, data: {} }), openStoryboard: async () => ({ ok: true, data: {} }),
}));
vi.mock("./review/review-api", () => ({
  decideItem: async (p: unknown) => { decided.push(p); return { ok: false, error: "稿子刚改过，重新看一眼" }; },
  inboxHref: (id: string, types?: string[]) => `#/board?inbox=${id}${types?.length ? `&types=${types.join(",")}` : ""}`,
}));
vi.mock("../ui", () => ({ toast: () => {}, confirmDialog: async () => true, openDialog: async () => null }));

beforeEach(() => { loads = 0; loadFails = false; decided.length = 0; });

async function mount(props: Record<string, unknown>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { CardPanel } = await import("./CardPanel");
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(createElement(CardPanel as never, { contentId: "content-1-a", ...props })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return el;
}
const approveBtn = (el: HTMLElement) => [...el.querySelectorAll("button")].find((b) => b.textContent === "稿子没问题")!;

describe("稿件页进度区", () => {
  it("编辑器里有没保存的修改：「稿子没问题」禁用，点了也不认", async () => {
    const el = await mount({ approveBlocked: "先保存修改，再进入下一阶段" });
    const btn = approveBtn(el);
    expect(btn.disabled).toBe(true);
    expect(el.textContent).toContain("先保存修改，再进入下一阶段");
    await act(async () => { btn.click(); });
    expect(decided).toEqual([]);
  });
  it("认稿被拒（稿子刚改过）：重读进度，拿新代次", async () => {
    const el = await mount({});
    const before = loads;
    await act(async () => { approveBtn(el).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(decided.length).toBe(1);
    expect(loads).toBeGreaterThan(before);
  });
  it("收起状态下读失败：自动展开，错误和重试看得见", async () => {
    loadFails = true;
    const el = await mount({ open: false });
    const details = el.querySelector("details")!;
    expect(details.open).toBe(true);
    expect(el.querySelector("[role=alert]")?.textContent).toContain("服务端炸了");
  });
});
