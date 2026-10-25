// @vitest-environment happy-dom
/**
 * 派生稿认稿面板（2026-10-25「认稿要做的简单一点」）：英文版就地显示中英对照、两个按钮带 item_id + gen 交到同一个入口；
 * 读不出来说原因；还差东西 / 稿子刚改过时不给「稿子没问题」；首页动词说「认英文稿」；卡片按钮打开的是这一件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InboxItem } from "./review-model";

const decided: Array<Record<string, unknown>> = [];
let inbox: InboxItem[] = [];
let derived: Record<string, unknown> = {};
vi.mock("./review-api", () => ({
  loadInbox: async () => ({ ok: true, data: { items: inbox, count: inbox.length, agent_waiting: 0, generated_at: "" } }),
  decideItem: async (p: Record<string, unknown>) => { decided.push(p); return { ok: true, data: { ok: true } }; },
  undoDecision: async () => ({ ok: true, data: {} }),
  loadDerived: async () => (derived.ok === false ? { ok: false, error: String(derived.error) } : { ok: true, data: derived }),
  attachmentUrl: () => "/att", mediaUrl: () => "/media", inboxHref: () => "#",
  INBOX_OPEN_EVENT: "autocrew:inbox-open",
  openInboxItem: (content_id: string, types?: string[]) => window.dispatchEvent(new CustomEvent("autocrew:inbox-open", { detail: { content_id, types } })),
}));
vi.mock("../../transport", () => ({ invoke: async () => ({ ok: true }), authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "x" }));

const EN: Record<string, unknown> = {
  ok: true, kind: "en_edition", title: "安克", hash: "h1", approval: "还没批", problems: [],
  segments: [
    { index: 1, startMs: 0, endMs: 4000, zh: "说实话，任务越难越想开最大", en: "Be honest. The harder the task, the more you crank it up.", keyword: null, changed: null, slotS: 4, estimatedS: 3.5, words: 11, over: false, swaps: [] },
    { index: 2, startMs: 4000, endMs: 8000, zh: "腾讯的同事刚发了一个测试", en: "Tariq just published a test.", keyword: "a test", changed: null, slotS: 4, estimatedS: 2, words: 5, over: false,
      swaps: [{ from: "腾讯的同事", to: "Tariq at Anthropic", reason: "西方观众不熟", factual: true, verified: false, evidenceId: null }] },
  ],
};
const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  item_id: "draft:content-9-en", gen: "g1", type: "draft", content_id: "content-9-en", title: "安克（英文版）", summary: "稿子写好了，过一眼", waiting: null, agent_waiting: false,
  since: new Date().toISOString(), rank: 3, detail: { derived: "en_edition", package_hash: "h1" },
  actions: [{ action: "approve_script", label: "稿子没问题", role: "primary" }, { action: "revise_script", label: "还要改…", role: "secondary", note: "required" }], ...over,
});

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  decided.length = 0; inbox = [item()]; derived = EN;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const btn = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (b: Element | undefined) => { expect(b, "按钮在").toBeTruthy(); await act(async () => { (b as HTMLElement).click(); }); await tick(); };

async function mountPanelOnly() {
  const { ReviewInbox } = await import("./ReviewInbox");
  await act(async () => { root.render(createElement(ReviewInbox, { variant: "panel" })); });
  await tick();
  // 卡片上的「认英文稿 →」走的就是这一下
  const { openInboxItem } = await import("./review-api");
  await act(async () => { openInboxItem("content-9-en", ["draft"]); });
  await tick();
}

describe("英文稿认稿面板", () => {
  it("卡片打开的是这一件：中英对照就地显示，不用另开页面；「稿子没问题」带 item_id + gen", async () => {
    await mountPanelOnly();
    const table = el.querySelector(".ri-bi");
    expect(table?.textContent).toContain("腾讯的同事刚发了一个测试");
    expect(table?.textContent).toContain("Tariq just published");
    expect(el.querySelector(".ri-bi mark")?.textContent).toBe("a test");
    expect(table?.textContent).toContain("带事实但出处没核过");
    await click(btn("稿子没问题"));
    expect(decided).toEqual([expect.objectContaining({ item_id: "draft:content-9-en", gen: "g1", action: "approve_script", content_id: "content-9-en" })]);
  });

  it("「还要改…」写一句再发", async () => {
    await mountPanelOnly();
    await click(btn("还要改…"));
    const ta = el.querySelector("textarea")!;
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!; set.call(ta, "第二段换个例子"); ta.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(btn("发送"));
    expect(decided).toEqual([expect.objectContaining({ action: "revise_script", note: "第二段换个例子", gen: "g1" })]);
  });

  it("脚本读不出来：照实说原因，不给「稿子没问题」", async () => {
    derived = { ok: false, error: "还没有英文脚本" };
    await mountPanelOnly();
    expect(el.textContent).toContain("中英对照读不出来：还没有英文脚本");
    expect(btn("稿子没问题")).toBeUndefined();
    expect(btn("还要改…")).toBeTruthy();
  });

  it("还差东西：列出来、不给批；稿子在出示之后被改过：提示刷新、不给批", async () => {
    derived = { ...EN, problems: ["第 2 段换例带事实但没有核过的出处"] };
    await mountPanelOnly();
    expect(el.textContent).toContain("还不能批");
    expect(btn("稿子没问题")).toBeUndefined();
    await act(async () => { root.unmount(); });
    root = createRoot(el);
    derived = { ...EN, hash: "h2" };
    await mountPanelOnly();
    expect(el.textContent).toContain("稿子刚改过，列表刷新后再批");
    expect(btn("稿子没问题")).toBeUndefined();
  });

  it("首页「要你做的」：动词是「认英文稿」/「认公众号稿」，不是笼统的「认稿」", async () => {
    const { rowVerb } = await import("./review-model");
    expect(rowVerb({ key: "a", items: [item()] })).toBe("认英文稿");
    expect(rowVerb({ key: "b", items: [item({ detail: { derived: "wechat_article" } })] })).toBe("认公众号稿");
    expect(rowVerb({ key: "c", items: [item({ detail: {} })] })).toBe("认稿");
  });

  it("公众号文章：标题、正文、还差什么就地显示", async () => {
    inbox = [item({ detail: { derived: "wechat_article", package_hash: "a1" } })];
    derived = { ok: true, kind: "wechat_article", title: "安克", chosenTitle: "充电宝的秘密", titleOptions: [], body: "正文第一段。", chars: 6, images: 2, problems: ["还没选创作来源"], approval: "还没批", sourceNote: null, hash: "a1" };
    await mountPanelOnly();
    expect(el.textContent).toContain("充电宝的秘密");
    expect(el.querySelector(".ri-body")?.textContent).toBe("正文第一段。");
    expect(el.textContent).toContain("还没选创作来源");
  });
});
