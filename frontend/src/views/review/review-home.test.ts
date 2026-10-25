// @vitest-environment happy-dom
/**
 * 首页「要你做的」（管线重规划第 3 期）：紧凑列表 = 动词 · 标题 · 一行说明；空了平静地说「没有要你定的」；
 * 点一行打开原来的面板，动作照旧按 item_id + gen 交到 /api/inbox/decide；读不出来照实说。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InboxItem } from "./review-model";

const decided: Array<Record<string, unknown>> = [];
let inbox: InboxItem[] = [];
let failWith: string | null = null;
vi.mock("./review-api", () => ({
  loadInbox: async () => (failWith ? { ok: false, error: failWith } : { ok: true, data: { items: inbox, count: inbox.length, agent_waiting: 0, generated_at: "" } }),
  decideItem: async (p: Record<string, unknown>) => { decided.push(p); return { ok: true, data: {} }; },
  undoDecision: async () => ({ ok: true, data: {} }),
  attachmentUrl: () => "/att",
  mediaUrl: (c: string, f: string) => `/media/${c}/${f}`,
  inboxHref: (id: string) => `#/board?inbox=${id}`,
  INBOX_OPEN_EVENT: "autocrew:inbox-open",
  openInboxItem: () => {},
}));
vi.mock("../../transport", () => ({ invoke: async () => ({ ok: true, content: { body: "正文" } }), authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "x" }));

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  decided.length = 0; inbox = []; failWith = null;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

const item = (over: Partial<InboxItem>): InboxItem => ({ item_id: "x", gen: "g", type: "draft", content_id: "content-1-a", title: "测试稿", summary: "", waiting: null, agent_waiting: false,
  since: new Date(Date.now() - 5 * 60_000).toISOString(), rank: 1, actions: [], detail: {}, ...over });

async function mount() {
  const { ReviewInbox } = await import("./ReviewInbox");
  await act(async () => { root.render(createElement(ReviewInbox, { variant: "home" })); });
  await tick();
}

describe("首页「要你做的」", () => {
  it("空了：平静地说没有要你定的，不出件数", async () => {
    await mount();
    expect(el.textContent).toContain("没有要你定的");
    expect(el.querySelector(".ri-home-count")).toBeNull();
  });

  it("读不出来：照实说原因", async () => {
    failWith = "连不上";
    await mount();
    expect(el.textContent).toContain("读不出来：连不上");
  });

  it("每行有动词；按主题分组；点开是原来的面板，动作按 item_id + gen 交出去", async () => {
    inbox = [
      item({ item_id: "draft:content-2-b", content_id: "content-2-b", type: "draft", rank: 3, summary: "稿子写好了，过一眼", theme_id: "content-1-a", theme_title: "主题甲",
        actions: [{ action: "approve_script", label: "稿子没问题", role: "primary" }], detail: { words: 300 } }),
      item({ item_id: "cut:r1", type: "cut_review", summary: "成片剪好了，看一遍", theme_id: "content-1-a", theme_title: "主题甲",
        actions: [{ action: "approve_cut", label: "就用这版", role: "primary", params: { fact_id: "f2", sha256: "s2" } }], detail: { review_fact_id: "f2", versions: [{ fact_id: "f2", sha256: "s2", at: new Date().toISOString(), label: "最新一版", ready: true }] } }),
    ];
    await mount();
    expect(el.querySelector(".ri-home-count")?.textContent).toBe("2 件");
    expect([...el.querySelectorAll(".ri-home-row .verb")].map((v) => v.textContent).sort()).toEqual(["看成片", "认稿"].sort());
    expect([...el.querySelectorAll(".ri-home-theme")].map((t) => t.textContent)).toEqual(["主题甲"]);
    const row = [...el.querySelectorAll<HTMLButtonElement>(".ri-home-row")].find((r) => r.querySelector(".verb")?.textContent === "认稿")!;
    await act(async () => { row.click(); }); await tick();
    const approve = [...el.querySelectorAll("button")].find((b) => b.textContent === "稿子没问题")!;
    expect(approve).toBeTruthy();
    await act(async () => { approve.click(); }); await tick();
    expect(decided[0]).toMatchObject({ item_id: "draft:content-2-b", gen: "g", action: "approve_script" });
  });
});
