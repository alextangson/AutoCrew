// @vitest-environment happy-dom
/**
 * 写稿交给谁（spec 2026-10-15 §B）前端：交出去之后怎么说、剪贴板失败给原文、没接 AI / 默认断开不假装开工、
 * 卡上「等它接手 / 在写 / 没接上？」、顶栏「交给 X 写 / 看」+ 换一个。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const dialogs: Array<{ title: string; body: string; confirmLabel?: string }> = [];
const toasts: string[] = [];
let confirmAnswer = true;
vi.mock("../ui", () => ({
  toast: (m: string) => { toasts.push(m); },
  confirmDialog: async (spec: { title: string; body: string; confirmLabel?: string }) => { dialogs.push(spec); return confirmAnswer; },
}));
const handOffs: Array<[string, string, string | null | undefined]> = [];
vi.mock("./board-api", () => ({
  handOffContent: async (id: string, mode: string, host?: string | null) => {
    handOffs.push([id, mode, host]);
    return { ok: true, data: { content_id: id, host: host ?? "codex", label: host === "workbuddy" ? "WorkBuddy" : "Codex", prompt: "开工指令", opened: host !== "workbuddy", paste: true } };
  },
}));
vi.mock("./onboarding/connect-api", () => ({ loadConnect: async () => ({ ok: true, data: { hosts: [], skipped: false, writingHost: "codex", writers: ["codex", "workbuddy"] } }) }));

const { announce, deliveryText, effectiveWriter, explainFailure, handoffLine, PICKUP_STALE_MS } = await import("./hand-off");
const { HandOffButton } = await import("./HandOffButton");
const { nextStep } = await import("./card-next");
const { itemMeta } = await import("./board-columns");

const D = (over: Record<string, unknown> = {}) => ({ host: "codex", label: "Codex", prompt: "开工指令", opened: true, paste: true, ...over });
let clip: string[] = [];
beforeEach(() => {
  dialogs.length = 0; toasts.length = 0; handOffs.length = 0; confirmAnswer = true; clip = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { clip.push(t); } } });
  window.location.hash = "";
});

describe("交出去之后那一句", () => {
  it("Claude 深链 / Codex 打开要粘贴 / WorkBuddy 粘过去 / 打不开说清是哪个、为什么", () => {
    expect(deliveryText(D({ host: "claude", label: "Claude Code", paste: false }), "write", true)).toBe("已交给 Claude Code：新会话里填好了指令，按发送开始写");
    expect(deliveryText(D(), "write", true)).toBe("Codex 已打开，粘贴发送");
    expect(deliveryText(D({ host: "workbuddy", label: "WorkBuddy", opened: false }), "write", true)).toBe("指令已复制，粘到 WorkBuddy 里发出去");
    expect(deliveryText(D({ opened: false, open_error: "这台机器不是 macOS，打不开 Codex 桌面版" }), "write", true)).toContain("Codex 没打开（这台机器不是 macOS");
  });

  it("剪贴板写不进去：照实说，把指令原文摆出来让人手动复制", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    await announce(D() as never, "write");
    expect(dialogs[0]).toMatchObject({ title: "没能写进剪贴板" });
    expect(dialogs[0].body).toContain("开工指令");
    expect(toasts).toHaveLength(0);
  });

  it("写进剪贴板：指令原样进去，一句 toast", async () => {
    await announce(D() as never, "write", "已建稿。");
    expect(clip).toEqual(["开工指令"]);
    expect(toasts).toEqual(["已建稿。Codex 已打开，粘贴发送"]);
  });
});

describe("交不出去", () => {
  it("一个 AI 都没接：弹「先接一个 AI」，去设置", async () => {
    await explainFailure({ error: "x", body: { code: "no_writer" } }, async () => {});
    expect(dialogs[0]).toMatchObject({ title: "先接一个 AI", confirmLabel: "去设置" });
    expect(window.location.hash).toBe("#/settings?tab=integrations");
  });

  it("默认的断开了：说「默认的 Codex 连不上了」，给换一个", async () => {
    const retried: string[] = [];
    await explainFailure({ error: "默认的 Codex 连不上了", body: { code: "default_gone", alternatives: [{ host: "workbuddy", label: "WorkBuddy" }] } }, async (h) => { retried.push(h); });
    expect(dialogs[0]).toMatchObject({ title: "默认的 Codex 连不上了", confirmLabel: "换 WorkBuddy" });
    expect(retried).toEqual(["workbuddy"]);
  });

  it("别的会话认领着：照实说谁在写", async () => {
    await explainFailure({ error: "Claude Code 正在写这篇，不用再交", body: { code: "claim_held", holder: "Claude Code" } }, async () => {});
    expect(toasts).toEqual(["Claude Code 正在写这篇，不用再交"]);
  });
});

describe("卡上那一句", () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const h = { host: "codex", label: "Codex", at, pickedUp: false, holder: null };
  it("没人接手 →「已交给 Codex，等它接手」；30 分钟还没人接 →「Codex 没接上？」；接手 / 认领 →「X 在写」", () => {
    expect(handoffLine(h)).toEqual({ text: "已交给 Codex，等它接手", stale: false });
    expect(handoffLine({ ...h, at: new Date(Date.now() - PICKUP_STALE_MS - 1000).toISOString() })).toEqual({ text: "Codex 没接上？", stale: true });
    expect(handoffLine({ ...h, pickedUp: true })?.text).toBe("Codex 在写");
    expect(handoffLine({ ...h, holder: "Claude Code" })?.text).toBe("Claude Code 在写");
    expect(handoffLine(undefined)).toBeNull();
  });
  it("看板卡和卡片面板都不再在没人接手时说「AI 在写」", () => {
    const item = { column: "写稿中", status: "drafting", updatedAt: at, handoff: h } as never;
    expect(itemMeta(item, null)).toContain("已交给 Codex，等它接手");
    expect(nextStep({ column: "写稿中", stage: null, status: "drafting", missing: [], active: true, handoff: h })?.text).toContain("已交给 Codex，等它接手");
    expect(nextStep({ column: "写稿中", stage: null, status: "drafting", missing: [], active: true })?.text).toContain("AI 在写稿");
  });
  it("默认写稿 AI：存下的还接着就是它，否则第一个接上的", () => {
    expect(effectiveWriter(["codex", "workbuddy"], "workbuddy")).toBe("workbuddy");
    expect(effectiveWriter(["codex"], "claude")).toBe("codex");
    expect(effectiveWriter([], null)).toBeNull();
  });
});

describe("顶栏按钮", () => {
  let el: HTMLDivElement, root: Root;
  beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); });
  afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
  const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

  it("写稿阶段「交给 Codex 写」，下拉列其他接上的；其他阶段「交给 Codex 看」", async () => {
    await act(async () => root.render(createElement(HandOffButton, { contentId: "content-1-a", mode: "write" })));
    await tick();
    expect(el.querySelector("button")?.textContent).toBe("交给 Codex 写");
    expect([...el.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["换一个", "交给 WorkBuddy 写"]);
    await act(async () => { el.querySelector("button")!.click(); });
    await tick();
    expect(handOffs).toEqual([["content-1-a", "write", null]]);
    const sel = el.querySelector("select")!;
    await act(async () => { sel.value = "workbuddy"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await tick();
    expect(handOffs[1]).toEqual(["content-1-a", "write", "workbuddy"]);
    await act(async () => root.render(createElement(HandOffButton, { contentId: "content-1-a", mode: "look" })));
    await tick();
    expect(el.querySelector("button")?.textContent).toBe("交给 Codex 看");
  });
});
