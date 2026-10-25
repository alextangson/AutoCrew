// @vitest-environment happy-dom
/** 首页「今天」：叠着刷新时慢回来的旧结果不覆盖新状态；回流读不了的提醒不被吞掉（Codex 审 P2×2） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

type Pending = { channel: string; resolve: (v: unknown) => void };
let pending: Pending[] = [];
let platforms: string[] = [];
let pullReply: unknown = { ok: true, data: { platforms: [] } };
let pipelineReplies: unknown[] = [];
vi.mock("../transport", () => ({
  invoke: (channel: string) => {
    if (channel === "onboarding:status") return new Promise((resolve) => pending.push({ channel, resolve }));
    if (channel === "flywheel:pull_status") return Promise.resolve(pullReply);
    return Promise.resolve({ ok: true, data: { configured: true } });
  },
  subscribeEvents: () => () => {}, authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "x",
}));
vi.mock("./board-api", () => ({
  loadDataPage: async () => ({ ok: true, data: { columns: [], rows: [], contents: [], asOf: null, sources: [], covers: {}, upcoming: null } }),
  loadPipeline: async () => pipelineReplies.shift() ?? { ok: true, data: { items: [], topics: [], themes: [], planErrors: [], wordsPerMinute: null, pullLogin: [] } },
  askAI: async () => ({ ok: false, error: "x" }),
}));
vi.mock("./hand-off", () => ({ useWriters: () => ({ writers: ["claude"], defaultHost: "claude", chief: false }), CHIEF_PREFILL_EVENT: "x", SETTINGS_HREF: "#/settings" }));
vi.mock("./review/ReviewInbox", () => ({ ReviewInbox: () => null }));
vi.mock("./update/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("./PersonaReminder", () => ({ PersonaReminder: () => null }));
vi.mock("./LegacyTwitterReminder", () => ({ LegacyTwitterReminder: () => null }));
vi.mock("./OntologyBanner", () => ({ OntologyBanner: () => null }));

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  pending = []; platforms = []; pullReply = { ok: true, data: { platforms: [] } }; pipelineReplies = [];
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const answer = async (i: number, p: string[]) => { await act(async () => { pending[i].resolve({ ok: true, platforms: p }); }); await tick(); };

async function mount() {
  const { Home } = await import("./Home");
  await act(async () => { root.render(createElement(Home, { openPipeline: () => {}, openEditor: () => {}, openData: () => {} })); });
  await tick();
}

describe("首页刷新与回流提醒", () => {
  it("叠着刷新：新的先回、旧的后回，旧结果不覆盖", async () => {
    await mount();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await tick();
    expect(pending).toHaveLength(2);
    await answer(1, ["douyin"]);           // 新的先回
    expect(el.querySelectorAll(".acct > div")).toHaveLength(1);
    await answer(0, []);                   // 旧的后回：丢掉
    expect(el.querySelectorAll(".acct > div")).toHaveLength(1);
    expect(el.textContent).not.toContain("还没勾运营平台");
  });

  it("pullLogin 为 null：照样出「回流状态读不了」，不被可选链吞成没事", async () => {
    pipelineReplies = [{ ok: true, data: { items: [], topics: [], themes: [], planErrors: [], wordsPerMinute: null, pullLogin: null } }];
    await mount();
    await answer(0, ["douyin"]);
    expect(el.textContent).toContain("数据回流状态读不了");
  });

  it("一个平台都没勾、回流读失败：仍单独写出回流错误", async () => {
    pullReply = { ok: false, error: "metrics-pull.json 坏了" };
    await mount();
    await answer(0, platforms);
    expect(el.textContent).toContain("还没勾运营平台");
    expect(el.textContent).toContain("数据回流状态读不出来：metrics-pull.json 坏了");
  });
});
