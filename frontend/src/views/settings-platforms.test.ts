// @vitest-environment happy-dom
/** 设置 → 运营平台（全媒体 spec §9.2–9.3）：分组复选框、即存即回读、保留旧 twitter、至少留一个；校准页只留跳转链接 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let stored: string[] = [];
let ignoreWrites = false;
const updates: string[][] = [];
const toasts: string[] = [];
vi.mock("../transport", () => ({
  authedFetch: async () => new Response("{}"),
  invoke: async (cmd: string, args?: { platforms?: string[] }) => {
    if (cmd === "onboarding:status") return { ok: true, data: { platforms: [...stored] } };
    if (cmd === "profile:update") { updates.push(args!.platforms!); if (!ignoreWrites) stored = [...args!.platforms!]; return { ok: true }; }
    return { ok: true, data: {} };
  },
}));
vi.mock("../ui", () => ({ toast: (m: string) => { toasts.push(m); }, openDialog: async () => null, confirmDialog: async () => true }));

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  updates.length = 0; toasts.length = 0; ignoreWrites = false;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const box = (label: string) => el.querySelector<HTMLInputElement>(`input[role="switch"][aria-label="${label}"]`)!;
async function render() {
  const { SettingsPlatforms } = await import("./SettingsPlatforms");
  await act(async () => { root.render(createElement(SettingsPlatforms)); });
  await settle();
}
const click = async (i: HTMLInputElement) => { await act(async () => { i.click(); }); await settle(); };

describe("运营平台标签", () => {
  it("三组都在，每组说清勾了开什么", async () => {
    stored = ["douyin"];
    await render();
    for (const t of ["中文视频", "图文", "英文版", "视频发布包出这些平台", "自动派生一篇公众号长文", "出英文配音版"]) expect(el.textContent).toContain(t);
    for (const l of ["抖音", "视频号", "小红书", "B站", "公众号", "头条", "YouTube", "X（推特）"]) expect(box(l)).toBeTruthy();
    expect(box("抖音").checked).toBe(true);
    expect(box("公众号").checked).toBe(false);
  });

  it("勾选即存，旧 twitter 原样保留并提示", async () => {
    stored = ["douyin", "twitter"];
    await render();
    expect(el.textContent).toContain("档案里的 twitter 只管写推文；要出英文版，请勾 X 或 YouTube");
    await click(box("YouTube"));
    expect(updates).toEqual([["douyin", "twitter", "youtube"]]);
    expect(box("YouTube").checked).toBe(true);
    expect(el.textContent).not.toContain("档案里的 twitter 只管写推文");
    await click(box("抖音"));
    expect(updates[1]).toEqual(["twitter", "youtube"]);
  });

  it("回读不一致就报错，不假装存上", async () => {
    stored = ["douyin"]; ignoreWrites = true;
    await render();
    await click(box("公众号"));
    expect(toasts.at(-1)).toContain("保存未生效");
    expect(box("公众号").checked).toBe(false);
  });

  it("不能取消最后一个", async () => {
    stored = ["douyin"];
    await render();
    await click(box("抖音"));
    expect(updates).toEqual([]);
    expect(toasts.at(-1)).toContain("至少保留一个");
  });
});

describe("设置默认标签与校准页链接", () => {
  it("不带标签进设置默认落在运营平台", async () => {
    stored = ["douyin"];
    const { Settings } = await import("./Settings");
    await act(async () => { root.render(createElement(Settings)); });
    await settle();
    expect(el.querySelector(".set-tabs .nav-on")?.textContent).toBe("运营平台");
    expect(el.textContent).toContain("中文视频");
  });

  it("校准页不再放席位 chip，只给跳去设置的链接", async () => {
    stored = ["douyin"];
    vi.doMock("../chat/ChatDock", () => ({ useChatSend: () => async () => ({ ok: true }) }));
    const { Calibration } = await import("./Calibration");
    await act(async () => { root.render(createElement(Calibration)); });
    await settle();
    expect(el.textContent).toContain("运营平台在 设置 → 运营平台 里选");
    expect(el.textContent).not.toContain("席位：");
    expect(el.querySelector('a[href="#/settings?tab=platforms"]')).toBeTruthy();
  });
});
