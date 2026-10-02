// @vitest-environment happy-dom
/** 版本提醒横幅、更新后说明、设置页「更新」一栏的渲染与按钮（self-update §2/§3）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UpdateView } from "./update-api";

const calls: string[] = [];
let loaded: unknown = { running: false };
let startReply: { ok: true; data: unknown } | { ok: false; error: string } = { ok: true, data: {} };
vi.mock("./update-api", () => ({
  loadUpdate: async () => ({ ok: true, data: loaded }),
  checkNow: async () => { calls.push("check"); return { ok: true, data: VIEW({ status: { checkedAt: new Date().toISOString(), current: "0.4.0", available: false, error: "连不上 GitHub（超时）" } }) }; },
  saveUpdateSettings: async (p: Record<string, unknown>) => { calls.push(`settings:${JSON.stringify(p)}`); return { ok: true, data: VIEW({ banner: null }) }; },
  ackResult: async () => { calls.push("ack"); return { ok: true, data: {} }; },
  startUpdate: async () => { calls.push("start"); return startReply; },
  waitBack: async () => { calls.push("wait"); return true; },
}));

const NOTES = [{ version: "0.5.0", date: "2026-10-01", news: ["新功能"], fixes: ["修好一处"], todo: ["重启后重新登录一次"] }];
function VIEW(over: Partial<UpdateView> = {}): UpdateView {
  return { current: "0.4.0", currentDate: "9月1日", settings: { autoCheck: true }, running: false, result: null,
    status: { checkedAt: new Date().toISOString(), current: "0.4.0", latest: "0.5.0", available: true },
    banner: { version: "0.5.0", notes: NOTES }, ...over };
}

let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0; loaded = { running: false }; startReply = { ok: true, data: {} };
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const btn = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (t: string) => { const b = btn(t); expect(b, t).toBeTruthy(); await act(async () => b!.click()); await tick(); };
async function mount(mod: string, name: string, props: Record<string, unknown>) {
  const m = await import(mod) as Record<string, (p: unknown) => JSX.Element>;
  await act(async () => root.render(createElement(m[name], props))); await tick();
}

describe("看板横幅", () => {
  it("一行提示：有新版本 + 看看更新了什么 + 更新（主按钮）", async () => {
    await mount("./UpdateBanner", "UpdateBanner", { initial: VIEW() });
    expect(el.textContent).toContain("有新版本 0.5.0");
    expect(btn("更新")?.className).toContain("primary");
    expect(btn("看看更新了什么")?.className).toContain("btn-ghost");
  });

  it("没有可提示的更新：什么都不显示", async () => {
    await mount("./UpdateBanner", "UpdateBanner", { initial: VIEW({ banner: null }) });
    expect(el.textContent).toBe("");
  });

  it("展开说明：「需要你做的」突出；可以选这个版本先不更新", async () => {
    await mount("./UpdateBanner", "UpdateBanner", { initial: VIEW() });
    await click("看看更新了什么");
    expect(el.querySelector(".upd-todo")?.textContent).toContain("重启后重新登录一次");
    await click("这个版本先不更新");
    expect(calls).toContain('settings:{"skip_version":"0.5.0"}');
    expect(el.textContent).toBe("");
  });

  it("更新：先写明后果再确认；确认后盖上「正在更新」并在回来后刷新", async () => {
    const reload = vi.fn();
    await mount("./UpdateBanner", "UpdateBanner", { initial: VIEW(), reload });
    await click("更新");
    expect(el.textContent).toContain("会重启，大约 1 分钟");
    expect(calls).not.toContain("start");
    await click("开始更新");
    expect(calls).toEqual(["start", "wait"]);
    expect(reload).toHaveBeenCalled();
  });

  it("预检拒绝：原因写在横幅上，不盖层", async () => {
    startReply = { ok: false, error: "程序文件有本地改动，自动更新会覆盖它们；先提交或撤掉这些改动再更新" };
    await mount("./UpdateBanner", "UpdateBanner", { initial: VIEW() });
    await click("更新"); await click("开始更新");
    expect(el.querySelector("[role=alert]")?.textContent).toContain("本地改动");
    expect(el.querySelector(".upd-overlay")).toBeNull();
  });

  it("后台检查后来才查到新版本：切回标签页时横幅自己冒出来，不用手动刷新", async () => {
    await mount("./UpdateBanner", "UpdateBanner", { initial: VIEW({ banner: null }) });
    expect(el.textContent).toBe("");
    loaded = VIEW();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await tick();
    expect(el.textContent).toContain("有新版本 0.5.0");
  });

  it("别处已在更新：直接显示更新中", async () => {
    await mount("./UpdateBanner", "UpdateBanner", { initial: VIEW({ running: true }), reload: () => {} });
    expect(calls).toContain("wait");
  });
});

describe("更新后的说明", () => {
  it("成功：「需要你做的」突出，点知道了不再弹", async () => {
    await mount("./UpdateResultDialog", "UpdateResultDialog", { initial: { ok: true, outcome: "updated", from: "0.4.0", to: "0.5.0", message: "", log: "/l", notes: NOTES } });
    expect(el.textContent).toContain("已更新到 0.5.0");
    expect(el.querySelector(".upd-todo")?.textContent).toContain("重启后重新登录一次");
    await click("知道了");
    expect(calls).toContain("ack");
    expect(el.textContent).toBe("");
  });

  it("失败退回 / 退回也失败：原因、日志和手动命令都看得见", async () => {
    await mount("./UpdateResultDialog", "UpdateResultDialog", { initial: { ok: false, outcome: "stuck", from: "0.4.0", to: "0.5.0",
      message: "更新失败，自动退回也失败了（npm 坏了）。完整记录在 /l", log: "/l", manualCommands: ["git reset --hard abc", "npm run restart"] } });
    expect(el.textContent).toContain("需要你手动恢复");
    expect(el.textContent).toContain("完整记录在 /l");
    expect(el.querySelector(".upd-cmds")?.textContent).toContain("git reset --hard abc");
  });
});

describe("更新没能开始", () => {
  it("结果弹窗写明「更新没能开始」和原因", async () => {
    await mount("./UpdateResultDialog", "UpdateResultDialog", { initial: { ok: false, outcome: "not_started", from: "0.4.0", to: "0.5.0", message: "更新没能开始：spawn ENOENT", log: "/l" } });
    expect(el.textContent).toContain("更新没能开始");
    expect(el.querySelector("[role=alert]")?.textContent).toContain("spawn ENOENT");
  });
});

describe("结果标题", () => {
  it("有任务在跑而取消：标题是「更新取消了」，不是「更新失败」；中止：说中止", async () => {
    await mount("./UpdateResultDialog", "UpdateResultDialog", { initial: { ok: false, outcome: "cancelled", from: "0.4.0", to: "0.5.0", message: "更新取消了：有 1 个任务正在跑。没有重启，仍是 0.4.0", log: "/l" } });
    expect(el.querySelector("h3")?.textContent).toBe("更新取消了");
    const { resultTitle } = await import("./UpdateResultDialog");
    expect(resultTitle({ ok: false, outcome: "aborted", from: "0.4.0", to: "0.5.0", message: "", log: "" })).toBe("更新中止了，已退回 0.4.0");
  });
});

describe("设置页「更新」一栏：分叉", () => {
  it("本地和发布版分叉：说分叉、说手动更新，不说「比最新发布版还新」", async () => {
    await mount("../SettingsUpdate", "SettingsUpdate", { initial: VIEW({ banner: null, status: { checkedAt: new Date().toISOString(), current: "0.4.9", latest: "0.5.0", available: false, reason: "diverged" } }) });
    expect(el.textContent).toContain("分叉");
    expect(el.textContent).toContain("手动更新");
    expect(el.textContent).not.toContain("还新");
  });
});

describe("设置页「更新」一栏", () => {
  it("版本带日期、上次检查、检查更新、自动检查开关；检查失败原因只写在这里", async () => {
    await mount("../SettingsUpdate", "SettingsUpdate", { initial: VIEW() });
    expect(el.textContent).toContain("版本 0.4.0 · 9月1日");
    expect(el.textContent).toContain("有新版本 0.5.0");
    const box = el.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(true);
    await click("检查更新");
    expect(el.querySelector("[role=alert]")?.textContent).toContain("连不上 GitHub");
    await act(async () => box.click()); await tick();
    expect(calls).toContain('settings:{"auto_check":false}');
  });
});
