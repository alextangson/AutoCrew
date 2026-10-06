// @vitest-environment happy-dom
/** 手动收件（spec 2026-10-06）前端：设置页「原片放哪里」只剩收件箱；看板不再有「没对上」列头；卡片上已挂原片只给「不是」 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const calls: Array<{ fn: string; args: unknown[] }> = [];
const log = (fn: string) => async (...args: unknown[]) => { calls.push({ fn, args }); return { ok: true, data: {} }; };
vi.mock("./board-api", () => ({
  loadSources: async () => ({ ok: true, data: { inbox: "/lib/我的内容/0 原片放这里" } }),
  revealSource: log("revealSource"), revealFact: log("revealFact"),
}));
vi.mock("../ui", () => ({ toast: () => {}, confirmDialog: async () => true }));

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text)!;
const click = async (b: Element) => { await act(async () => { (b as HTMLElement).click(); await new Promise((r) => setTimeout(r, 10)); }); };

describe("设置页「原片放哪里」", () => {
  it("只给收件箱路径和「在访达中显示」，说清在对话里告诉 agent；没有监视文件夹、暂停、转写环境", async () => {
    const { SettingsArollSources } = await import("./SettingsArollSources");
    await act(async () => { root.render(createElement(SettingsArollSources)); });
    await settle();
    expect(el.textContent).toContain("原片放哪里");
    expect(el.textContent).toContain("/lib/我的内容/0 原片放这里");
    expect(el.textContent).toContain("在对话里告诉 agent");
    for (const gone of ["监视文件夹", "添加文件夹", "暂停自动找原片", "转写环境"]) expect(el.textContent).not.toContain(gone);
    await click(button("在访达中显示"));
    expect(calls).toEqual([{ fn: "revealSource", args: ["/lib/我的内容/0 原片放这里"] }]);
  });
});

describe("卡片上已挂的原片", () => {
  const row = (over: Record<string, unknown>) => ({ fact_id: "fact-1", sha256: "s", path: "02-aroll/甲稿-原片.mov", auto_attached: false, source_path: "/i/IMG_1.mov", undo_blocked: null, ...over });
  async function render(rows: unknown[]) {
    const acts: Array<[string, Record<string, unknown>]> = [];
    const { CardArolls } = await import("./CardArolls");
    await act(async () => { root.render(createElement(CardArolls, { contentId: "content-1-a", rows: rows as never, busy: false, act: async (a: string, p: Record<string, unknown>) => { acts.push([a, p]); } })); });
    return acts;
  }

  it("能撤的给「不是」（确认后撤）；推导回不去的只给原因", async () => {
    const acts = await render([row({ auto_attached: true }), row({ fact_id: "fact-2", auto_attached: true, undo_blocked: "这条已经在剪了，要换原片请重开文稿" })]);
    expect(el.textContent).toContain("这条已经在剪了，要换原片请重开文稿");
    expect([...el.querySelectorAll("button")].filter((b) => b.textContent === "不是")).toHaveLength(1);
    await click(button("不是"));
    expect(acts).toEqual([["undo_auto_attach", { fact_id: "fact-1", sha256: "s" }]]);
  });

  it("旧数据里还带着挂载核对结果：不再显示「更像别条」「改挂」", async () => {
    await render([row({ check: { status: "suggest", other_id: "content-2-b", other_title: "乙稿" }, reassign_blocked: null })]);
    expect(el.textContent).not.toContain("更像");
    expect(el.textContent).not.toContain("改挂");
  });
});
