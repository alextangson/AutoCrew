// @vitest-environment happy-dom
/** 新引导每个状态的渲染（onboarding-connect §2 / §6）。服务端调用全部替身。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConnectResult, ConnectView, HostStatus, ProbeResult } from "./connect-api";

const store: { view: ConnectView; probe: ProbeResult; connect: (h: string) => ConnectResult; calls: string[] } = {
  view: { hosts: [], skipped: false }, probe: { ok: true, detail: "已登录，能用" }, connect: () => ({ ok: true, host: "claude", registered: true, verified: true, message: "已接上" }), calls: [],
};
vi.mock("./connect-api", async (orig) => {
  const real = await orig<typeof import("./connect-api")>();
  return {
    ...real,
    loadConnect: async () => ({ ok: true, data: store.view }),
    probeHost: async (h: string) => { store.calls.push(`probe:${h}`); return { ok: true, data: store.probe }; },
    connectHost: async (h: string) => { store.calls.push(`connect:${h}`); return { ok: true, data: store.connect(h) }; },
    disconnectHost: async (h: string) => { store.calls.push(`disconnect:${h}`); return { ok: true, data: { ok: true, host: h, registered: false, verified: false, message: "已断开" } }; },
    skipOnboarding: async () => { store.calls.push("skip"); store.view = { ...store.view, skipped: true }; return { ok: true, data: { skipped: true } }; },
  };
});
vi.mock("../../transport", () => ({ invoke: async () => ({ ok: true, data: { configured: false } }), authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "x" }));

const H = (host: HostStatus["host"], over: Partial<HostStatus> = {}): HostStatus => ({
  host, label: { claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy" }[host], found: false, loggedIn: null,
  detail: "没找到，装好后回来点一下", connected: false, ...over,
});

let el: HTMLDivElement, root: Root, done: number;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  store.calls = []; store.probe = { ok: true, detail: "已登录，能用" }; done = 0;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const btn = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement | undefined;
const click = async (t: string) => { const b = btn(t); expect(b, t).toBeTruthy(); await act(async () => b!.click()); await tick(); };
const card = (h: string) => el.querySelector(`[data-host="${h}"]`) as HTMLElement;
async function mount() {
  const { Onboarding } = await import("../Onboarding");
  await act(async () => root.render(createElement(Onboarding, { onDone: () => { done++; } }))); await tick();
}

describe("第 1 步", () => {
  it("什么都没找到：每张卡写「装好后回来点一下」，主按钮位置写原因，不出现术语", async () => {
    store.view = { hosts: [H("claude"), H("codex"), H("workbuddy")], skipped: false };
    await mount();
    expect(el.textContent).toContain("你想让哪个 AI 来写稿？");
    expect(card("claude").textContent).toContain("装好后回来点一下");
    expect(card("claude").getAttribute("role")).toBeNull();
    expect(el.querySelector("button.primary")).toBeNull();
    expect(el.textContent).toContain("先在上面选一个本机 AI");
    expect(btn("装好了，再找一次")).toBeTruthy();
    expect(el.textContent).not.toMatch(/MCP|token|令牌|API Key/);
  });

  it("Claude 找到但没登录：点「检测登录」才真调，给人话原因，卡片不能再选", async () => {
    store.view = { hosts: [H("claude", { found: true, detail: "找到了 Claude Code" }), H("codex"), H("workbuddy")], skipped: false };
    store.probe = { ok: false, code: "not_logged_in", error: "Claude 还没登录：在终端运行 claude 并按提示登录，再回来点一次" };
    await mount();
    expect(store.calls).toEqual([]);
    expect(card("claude").textContent).toContain("推荐");
    await click("检测登录");
    expect(store.calls).toEqual(["probe:claude"]);
    expect(card("claude").textContent).toContain("Claude 还没登录");
    expect(card("claude").getAttribute("role")).toBeNull();
  });

  it("找到好几个：Claude 默认勾上，可以多选；没登录的 Codex 写原因、不可选", async () => {
    store.view = { hosts: [
      H("claude", { found: true, detail: "找到了 Claude Code" }), H("workbuddy", { found: true, detail: "找到了 WorkBuddy" }),
      H("codex", { found: true, loggedIn: false, detail: "Codex 还没登录：在终端运行 codex login，再回来点一下" }),
    ], skipped: false };
    await mount();
    expect(el.querySelector("input[type=checkbox]")).toBeNull(); // 不用原生蓝色勾选框
    expect(card("claude").getAttribute("role")).toBe("checkbox");
    expect(card("claude").getAttribute("aria-checked")).toBe("true");
    expect(card("codex").getAttribute("role")).toBeNull();
    expect(card("codex").textContent).toContain("codex login");
    await act(async () => card("workbuddy").click()); await tick();
    expect(card("workbuddy").getAttribute("aria-checked")).toBe("true");
    expect(btn("下一步：接上 2 个")?.className).toContain("primary");
    // 键盘：空格 / 回车切换
    await act(async () => card("workbuddy").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))); await tick();
    expect(card("workbuddy").getAttribute("aria-checked")).toBe("false");
    await act(async () => card("workbuddy").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))); await tick();
    expect(card("workbuddy").getAttribute("aria-checked")).toBe("true");
  });
});

describe("第 2 步与完成页", () => {
  beforeEach(() => {
    store.view = { hosts: [H("claude", { found: true, detail: "找到了 Claude Code" }), H("codex", { found: true, loggedIn: true, detail: "已登录" }), H("workbuddy")], skipped: false };
  });

  it("接上成功：打勾，完成页说去 Claude Code 里开工，并说清哪几样还要 DeepSeek 钥匙", async () => {
    store.connect = (h) => ({ ok: true, host: h as "claude", registered: true, verified: true, message: "已接上 Claude Code，核对过能连上。新开一个会话就能用" });
    await mount();
    await click("下一步：接上 1 个");
    expect(el.textContent).toContain("接上");
    await click("一键接上");
    expect(store.calls).toEqual(["connect:claude"]);
    expect(card("claude").textContent).toContain("已接上");
    await click("好了，进去看看");
    expect(el.textContent).toContain("去 Claude Code 里说「帮我写一条……」就能开工");
    expect(el.textContent).toContain("深调研、选题雷达、复盘、人设、每日摘要这几样要用你自己的模型钥匙（DeepSeek 最省事）");
    expect(el.textContent).not.toContain("在做");
    expect(btn("去设置里填钥匙")).toBeTruthy();
    await click("进入 AutoCrew");
    expect(done).toBe(1);
  });

  it("接上失败：写原因，按钮变成「再试一次」，不打勾", async () => {
    store.connect = (h) => ({ ok: false, host: h as "claude", registered: false, verified: false, code: "cli_failed", error: "claude 命令失败（退出码 1）：权限不够", message: "x" });
    await mount();
    await click("下一步");
    await click("一键接上");
    expect(card("claude").textContent).toContain("权限不够");
    expect(card("claude").textContent).not.toContain("已接上");
    expect(btn("再试一次")?.className).not.toContain("primary");
    // 失败也算有了结果：底部主按钮变成「好了，进去看看」
    expect(btn("好了，进去看看")?.className).toContain("primary");
  });

  it("替换了原来的 autocrew 配置：结果里说备份在哪", async () => {
    store.connect = (h) => ({ ok: true, host: h as "claude", registered: true, verified: true, replaced: true, backup: "/Users/x/.claude.json.autocrew-bak",
      message: "已替换原来的 autocrew 配置（备份在 /Users/x/.claude.json.autocrew-bak）。已接上 Claude Code，核对过能连上" });
    await mount();
    await click("下一步");
    await click("一键接上");
    expect(card("claude").textContent).toContain("已替换原来的 autocrew 配置（备份在 /Users/x/.claude.json.autocrew-bak）");
  });
});

describe("第 2 步的主按钮（review-inbox §4.2）", () => {
  const primaries = () => [...el.querySelectorAll("button.primary")].map((b) => b.textContent);

  it("选了一个：那一行的「一键接上」是唯一的主按钮，「先跳过，进去看看」是灰的", async () => {
    store.view = { hosts: [H("claude", { found: true, detail: "找到了" }), H("codex"), H("workbuddy")], skipped: false };
    store.connect = (h) => ({ ok: true, host: h as "claude", registered: true, verified: true, message: "已接上" });
    await mount();
    await click("下一步");
    expect(primaries()).toEqual(["一键接上"]);
    expect(btn("先跳过，进去看看")?.className).toContain("btn-ghost");
    await click("一键接上");
    expect(primaries()).toEqual(["好了，进去看看"]);
    expect(btn("先跳过")).toBeUndefined();
  });

  it("选了几个：顶部「全部接上」是唯一的主按钮，行内次按钮；全部有结果后底部变「好了，进去看看」", async () => {
    store.view = { hosts: [H("claude", { found: true, detail: "找到了" }), H("workbuddy", { found: true, detail: "找到了" }), H("codex")], skipped: false };
    store.connect = (h) => h === "claude"
      ? { ok: true, host: "claude", registered: true, verified: true, message: "已接上" }
      : { ok: false, host: h as "workbuddy", registered: false, verified: false, error: "写不了 mcp.json", message: "x" };
    await mount();
    await act(async () => card("workbuddy").click()); await tick();
    await click("下一步：接上 2 个");
    expect(primaries()).toEqual(["全部接上"]);
    expect(card("claude").querySelector("button")?.className ?? "").not.toContain("primary");
    await click("全部接上");
    expect(store.calls.filter((c) => c.startsWith("connect:"))).toEqual(["connect:claude", "connect:workbuddy"]);
    expect(card("workbuddy").textContent).toContain("写不了 mcp.json");
    expect(primaries()).toEqual(["好了，进去看看"]);
  });
});

describe("先不配", () => {
  it("点了存到本机，下次打开（重新判断）不再弹", async () => {
    const { shouldOnboard, loadConnect } = await import("./connect-api");
    store.view = { hosts: [H("claude"), H("codex"), H("workbuddy")], skipped: false };
    expect(shouldOnboard(false, await loadConnect())).toBe(true);
    await mount();
    await click("先不配");
    expect(store.calls).toContain("skip");
    expect(done).toBe(1);
    expect(shouldOnboard(false, await loadConnect())).toBe(false);
    // 配了引擎、或接过任何宿主，也不弹
    expect(shouldOnboard(true, { ok: true, data: { hosts: [], skipped: false } })).toBe(false);
    expect(shouldOnboard(false, { ok: true, data: { hosts: [H("codex", { connected: true })], skipped: false } })).toBe(false);
  });
});

describe("Codex 评审 P2-3：写进去但没核对上", () => {
  it("设置页那一行写原因，按钮是「再试一次」；引导不把它当接好了", async () => {
    store.view = { hosts: [H("claude", { found: true, detail: "找到了", unverified: "Claude 说连不上 autocrew" }), H("codex"), H("workbuddy")], skipped: false };
    const { HostsCard } = await import("./HostsCard");
    await act(async () => root.render(createElement(HostsCard))); await tick();
    expect(card("claude").textContent).toContain("写进去了但没连上：Claude 说连不上 autocrew");
    expect(btn("再试一次")).toBeTruthy();
    const { shouldOnboard } = await import("./connect-api");
    expect(shouldOnboard(false, { ok: true, data: { hosts: [H("claude", { unverified: "x", lastUsedAt: "2026-10-01T00:00:00Z" })], skipped: false } })).toBe(true);
  });
});
