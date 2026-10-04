// @vitest-environment happy-dom
/** 1b 验收：稿件页标题下那一行——写稿中 / 待审但已经有原片的稿也要显示；普通在写的稿不显示 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let card: Record<string, unknown> = {};
vi.mock("./board-api", () => ({ loadCard: async () => ({ ok: true, data: card }) }));

let el: HTMLDivElement;
let root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); });
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });

async function render(c: Record<string, unknown>) {
  card = { id: "content-1-a", active: true, column: "写稿中", stage: null, missing: [], badges: [], arolls: [], ...c };
  const { ProductionBanner } = await import("./ProductionBanner");
  await act(async () => { root.render(createElement(ProductionBanner, { contentId: "content-1-a", refreshKey: String(Math.random()) })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

describe("稿件页的阶段行", () => {
  it("写稿中 + 已有原片 → 说清已经有原片、点上面「稿子没问题，进入制作」，带「看这条的进度」（不再跳回看板）", async () => {
    await render({ status: "draft_ready", arolls: [{ fact_id: "f1" }, { fact_id: "f2" }] });
    expect(el.textContent).toContain("写稿中 · 已经有原片了，稿子没问题就点上面「稿子没问题，进入制作」");
    expect(el.querySelector("a")).toBeNull();
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "看这条的进度")).toBe(true);
  });

  it("待审 + 已有原片 → 同样显示，并标待审（面板数据没有原片行时认徽章）", async () => {
    await render({ status: "reviewing", active: false, arolls: undefined, badges: ["已有原片，等你认稿"] });
    expect(el.textContent).toContain("写稿中（待审） · 已经有原片了");
  });

  it("普通在写、没有原片 → 不显示", async () => {
    await render({ status: "drafting" });
    expect(el.textContent).toBe("");
  });
});
