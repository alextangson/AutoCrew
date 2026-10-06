// @vitest-environment happy-dom
/** 1b 预演反馈：卡片「发现的候选」不再是调试输出；收件箱列表同样处理；写稿中卡片提示有疑似原片 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const calls: Array<[string, unknown[]]> = [];
vi.mock("./board-api", () => ({
  revealFact: async (...a: unknown[]) => { calls.push(["revealFact", a]); return { ok: true, data: {} }; },
  revealSource: async (...a: unknown[]) => { calls.push(["revealSource", a]); return { ok: true, data: {} }; },
  decide: async () => ({ ok: true, data: {} }),
}));
vi.mock("../ui", () => ({ toast: () => {}, confirmDialog: async () => true, openDialog: async () => null }));

let el: HTMLDivElement;
let root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; calls.length = 0; el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); });
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });
const click = async (b: Element) => { await act(async () => { (b as HTMLElement).click(); await new Promise((r) => setTimeout(r, 10)); }); };
const button = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === t)!;

const ROW = { fact_id: "fact-1", kind: "aroll", state: "candidate", sha256: "s", name: "原片 · IMG_0421.MOV", origin: "收件箱",
  reason: "开头说的话和这条稿对上了", detail: "/Users/x/inbox/IMG_0421.MOV\n开头转写对上（0.576，领先 0.501）\n前三名：《甲稿》 0.576", path: "/Users/x/inbox/IMG_0421.MOV" };

describe("卡片「发现的候选」", () => {
  it("第一行文件名 + 来源，第二行一句原因；完整路径和分数只在「依据」与悬停里；三个按钮", async () => {
    const acts: string[] = [];
    const { CardCandidates } = await import("./CardCandidates");
    const act2 = async (a: string) => { acts.push(a); };
    await act(async () => { root.render(createElement(CardCandidates, { contentId: "content-1-a", rows: [ROW], busy: false, act: act2, confirm: act2 })); });
    const visible = [...el.querySelectorAll(".card-panel-row, .card-panel-note")].filter((n) => !n.closest("details")).map((n) => n.textContent).join("|");
    expect(visible).toContain("原片 · IMG_0421.MOV");
    expect(visible).toContain("收件箱");
    expect(visible).toContain("开头说的话和这条稿对上了");
    expect(visible).not.toContain("/Users/x/");
    expect(visible).not.toContain("0.576");
    expect(el.querySelector("details pre")!.textContent).toContain("0.576");
    expect(el.querySelector("strong")!.getAttribute("title")).toBe(ROW.path);
    await click(button("是这条"));
    await click(button("不是这条"));
    await click(button("在访达中显示"));
    expect(acts).toEqual(["confirm_candidate", "reject_candidate"]);
    expect(calls).toEqual([["revealFact", ["content-1-a", "fact-1"]]]);
  });
});
