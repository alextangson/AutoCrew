// @vitest-environment happy-dom
/** 进度栏补做 A / B：在访达打开这一条（原因 + 明说的「打开项目文件夹」）、交接详情（含还没交接）、窄屏「详情」里同样够得着 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Desk, DeskReply } from "./desk-api";

const calls: Array<[string, unknown]> = [];
let replies: Record<string, unknown> = {};
let deskReply: { ok: true; data: DeskReply } | { ok: false; error: string } = { ok: false, error: "x" };
vi.mock("../transport", () => ({
  subscribeEvents: () => () => {}, SESSION_EXPIRED: "s",
  authedFetch: async (url: string, init: { body: string }) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => replies[url] }; },
}));
vi.mock("./desk-api", () => ({ loadDesk: async () => deskReply }));

const { RailDetails } = await import("./RailDetails");
const { ProgressRail, RailLine } = await import("./ProgressRail");
const { DeskProvider } = await import("./use-desk");

const desk = (over: Partial<Desk> = {}): Desk => ({
  round: 1, rows: [], past: [], plan_error: null, headline: null, summary: null, refresh_at: null, cover: null, script: { final: true, label: "定稿" },
  rail: { steps: [{ key: "script", label: "写稿", state: "完成", at: null, current: false }], platforms: ["抖音"], chars: 100, wpm: 240 }, handoff: null, ...over,
});
const handoff = { generation: 3, at: "2026-10-11T02:00:00Z", session: "sess-9", fingerprint: "abcdef01", aroll: "原片.mov" };
const claim = { host: "Codex", live: false, lease_ok: false, idle_hours: 5 };

let root: Root; let el: HTMLElement;
beforeEach(() => { calls.length = 0; replies = {}; el = document.createElement("div"); document.body.append(el); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); el.remove(); });
const render = async (node: ReactNode) => { await act(async () => { root.render(node); }); await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const click = async (b: Element | null | undefined) => { await act(async () => { (b as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); };
const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

it("5：交接详情折叠，展开有代次 / 时间 / 会话 / 指纹 / 原片 / 认领租约", async () => {
  await render(createElement(RailDetails, { contentId: "content-1-a", desk: desk({ handoff }), claim }));
  const d = el.querySelector("details.desk-handoff") as HTMLDetailsElement;
  expect(d.open).toBe(false);
  expect(d.querySelector("summary")?.textContent).toBe("交接详情");
  for (const t of ["第 3 代", "sess-9", "abcdef01", "原片.mov", "Codex · 租约已过期 · 5 小时没动静"]) expect(d.textContent).toContain(t);
});

it("6：没交接 = 「还没交给剪辑」；没认领明说", async () => {
  await render(createElement(RailDetails, { contentId: "content-1-a", desk: desk(), claim: null }));
  expect(el.textContent).toContain("还没交给剪辑");
  expect(el.textContent).toContain("没有 AI 认领");
});

it("1/3：打开「我的内容」；视图里没有 → 原因 + 明说的「打开项目文件夹」才开项目根", async () => {
  replies["/api/my-content-reveal"] = { ok: false, code: "not_in_view", error: "「我的内容」还没同步到这条" };
  replies["/api/project-reveal"] = { ok: true, opened: true, path: "/p" };
  await render(createElement(RailDetails, { contentId: "content-1-a", desk: desk(), claim: null }));
  expect(button("打开项目文件夹")).toBeUndefined();
  await click(button("在访达打开这一条"));
  expect(calls).toEqual([["/api/my-content-reveal", { content_id: "content-1-a" }]]);
  expect(el.textContent).toContain("还没同步到这条");
  await click(button("打开项目文件夹"));
  expect(calls.at(-1)).toEqual(["/api/project-reveal", { content_id: "content-1-a", target: "project_root" }]);
});

it("4：打开失败（非 macOS / spawn 报错）原因写在按钮旁，不给项目文件夹兜底", async () => {
  replies["/api/my-content-reveal"] = { ok: false, code: "open_failed", error: "访达没打开：spawn open ENOENT" };
  await render(createElement(RailDetails, { contentId: "content-1-a", desk: desk(), claim: null }));
  await click(button("在访达打开这一条"));
  expect(el.querySelector("[role=alert]")?.textContent).toBe("访达没打开：spawn open ENOENT");
  expect(button("打开项目文件夹")).toBeUndefined();
});

it("Codex 审 P2：清单读不出 = 原因，不给项目文件夹兜底", async () => {
  replies["/api/my-content-reveal"] = { ok: false, code: "view_unreadable", error: "「我的内容」正在同步或读不出，稍后再点" };
  await render(createElement(RailDetails, { contentId: "content-1-a", desk: desk(), claim: null }));
  await click(button("在访达打开这一条"));
  expect(el.textContent).toContain("正在同步或读不出");
  expect(button("打开项目文件夹")).toBeUndefined();
});

it("7：宽屏进度栏和窄屏一行小字的「详情」里都有这两样", async () => {
  deskReply = { ok: true, data: { active: true, card: { id: "content-1-a", claim } as never, desk: desk({ handoff }) } };
  await render(createElement(DeskProvider, { contentId: "content-1-a", refreshKey: "k", children: null }, createElement(ProgressRail, {}), createElement(RailLine, { desk: desk({ handoff }) })));
  const rail = el.querySelector(".desk-rail")!;
  expect(rail.textContent).toContain("在访达打开这一条");
  expect(rail.querySelector("details.desk-handoff")).toBeTruthy();
  expect(el.querySelector(".desk-rail-line")?.textContent).toBe("写稿 ✓");
  const more = el.querySelector("details.desk-rail-more")!;
  expect(more.querySelector("summary")?.textContent).toBe("详情");
  expect(more.textContent).toContain("在访达打开这一条");
  expect(more.textContent).toContain("第 3 代");
});
