// @vitest-environment happy-dom
/** 1b 前端：设置页「原片从哪里找」、待录制列头的收件箱提示、卡片上已挂原片的按钮 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const calls: Array<{ fn: string; args: unknown[] }> = [];
const log = (fn: string) => async (...args: unknown[]) => { calls.push({ fn, args }); return { ok: true, data: { path: "/Users/x/Downloads" } }; };
vi.mock("./board-api", () => ({
  loadSources: async () => ({ ok: true, data: {
    inbox: "/lib/我的内容/0 原片放这里", paused: false, asr: { ready: false, reason: "ASR 依赖环境还没装好" }, jianyingExportDir: null,
    folders: [{ path: "/Users/x/Downloads", scan: true, allow_move: false, problem: null, last: { at: "2026-09-30T00:00:00Z", error: "读不了：去 系统设置 → 隐私与安全性 → 文件与文件夹，给运行 AutoCrew 的程序打开这个文件夹", files: 0, suggested: 0 } }],
  } }),
  sourceOp: log("sourceOp"), chooseFolder: log("chooseFolder"), revealSource: log("revealSource"), decide: log("decide"),
}));
vi.mock("../lib", () => ({ videoAsrWarmup: log("warmup") }));
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

describe("设置页「原片从哪里找」", () => {
  it("列收件箱、监视文件夹与它读不了的授权提示、转写没就绪；添加文件夹走原生选择窗，暂停走浏览器会话写口", async () => {
    const { SettingsArollSources } = await import("./SettingsArollSources");
    await act(async () => { root.render(createElement(SettingsArollSources)); });
    await settle();
    expect(el.textContent).toContain("原片从哪里找");
    expect(el.textContent).toContain("/lib/我的内容/0 原片放这里");
    expect(el.textContent).toContain("隐私与安全性");
    expect(el.textContent).toContain("没就绪（ASR 依赖环境还没装好）");
    await click(button("添加文件夹…"));
    expect(calls.map((c) => c.fn)).toEqual(expect.arrayContaining(["chooseFolder", "sourceOp"]));
    expect(calls.find((c) => c.fn === "sourceOp")!.args).toEqual(["add_folder", { path: "/Users/x/Downloads", scan: true }]);
    const pause = [...el.querySelectorAll("label")].find((l) => l.textContent?.includes("暂停自动找原片"))!.querySelector("input")!;
    await click(pause);
    expect(calls.filter((c) => c.fn === "sourceOp").at(-1)!.args).toEqual(["set_paused", { paused: true }]);
  });
});

describe("待录制列头的收件箱提示", () => {
  it("「收件箱里有 N 个视频没对上」点开：猜测、指定给…（= 挂载决定）、在访达中显示；没核对成的单列原因", async () => {
    const { InboxHeader } = await import("./InboxHeader");
    const inbox = { checking: 0, failed: [{ name: "bad.mov", path: "/i/bad.mov", reason: "转写失败：sidecar 崩了" }],
      unmatched: [{ name: "IMG_1.mov", path: "/i/IMG_1.mov", sha256: "sh1", size: 2 * 1024 * 1024, mtime_ms: 0, guess: ["甲稿"] }, { name: "IMG_2.mov", path: "/i/IMG_2.mov", sha256: "sh2", size: 1, mtime_ms: 0, guess: [] }] };
    await act(async () => { root.render(createElement(InboxHeader, { inbox, targets: [{ id: "content-1-a", title: "甲稿" }], reload: async () => {} })); });
    expect(el.textContent).toContain("1 个视频没核对成：bad.mov（转写失败：sidecar 崩了）");
    await click(button("收件箱里有 2 个视频没对上"));
    expect(el.textContent).toContain("猜测：甲稿");
    const select = el.querySelector("select")!;
    await act(async () => { select.value = "content-1-a"; select.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((r) => setTimeout(r, 10)); });
    expect(calls.find((c) => c.fn === "decide")!.args).toEqual(["content-1-a", "attach_aroll", { path: "/i/IMG_1.mov", expect_sha: "sh1" }]);
    await click(button("在访达中显示"));
    expect(calls.find((c) => c.fn === "revealSource")!.args).toEqual(["/i/IMG_1.mov"]);
  });

  it("暂停了自动找原片：列头说已暂停，不说「正在核对」", async () => {
    const { InboxHeader } = await import("./InboxHeader");
    await act(async () => { root.render(createElement(InboxHeader, { inbox: { checking: 1, failed: [], unmatched: [], paused: true }, targets: [], reload: async () => {} })); });
    expect(el.textContent).toContain("已暂停自动找原片");
    expect(el.textContent).not.toContain("正在核对");
  });

  it("什么都没有就不占列头", async () => {
    const { InboxHeader } = await import("./InboxHeader");
    await act(async () => { root.render(createElement(InboxHeader, { inbox: { checking: 0, failed: [], unmatched: [] }, targets: [], reload: async () => {} })); });
    expect(el.textContent).toBe("");
  });
});

describe("卡片上已挂的原片", () => {
  const row = (over: Record<string, unknown>) => ({ fact_id: "fact-1", sha256: "s", path: "02-aroll/甲稿-原片.mov", auto_attached: false, source_path: "/i/IMG_1.mov", check: null, undo_blocked: null, reassign_blocked: null, ...over });
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

  it("「这段原片听起来更像《X》」+ 改挂 / 就是这条；已经在剪就把改挂换成说明", async () => {
    const acts = await render([row({ check: { status: "suggest", other_id: "content-2-b", other_title: "乙稿" } })]);
    expect(el.textContent).toContain("这段原片听起来更像《乙稿》");
    await click(button("改挂到《乙稿》"));
    await click(button("就是这条"));
    expect(acts.map((a) => a[0])).toEqual(["reassign_aroll", "keep_attach"]);
    expect(acts[0][1]).toMatchObject({ to: "content-2-b" });
    await act(async () => { root.unmount(); });
    root = createRoot(el);
    await render([row({ check: { status: "suggest", other_id: "content-2-b", other_title: "乙稿" }, reassign_blocked: "这条已经在剪了，要改挂请先重开文稿" })]);
    expect(el.textContent).toContain("这条已经在剪了，要改挂请先重开文稿");
    expect(el.textContent).not.toContain("改挂到《乙稿》");
  });

  it("转写没就绪 → 小字说没做内容核对", async () => {
    await render([row({ check: { status: "not_ready", reason: "没做内容核对：转写环境没装好（x）" } })]);
    expect(el.textContent).toContain("没做内容核对：转写环境没装好");
  });
});
