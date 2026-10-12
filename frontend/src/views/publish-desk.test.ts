// @vitest-environment happy-dom
/** 发布台前端（spec 2026-10-12 发布台）：各平台表、复制、按平台动作带轮次、骨架 / 失败、卡在发布表模式下只显示状态、进度栏一行 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { copyText, dataText, lengthText, railLine, stepSub } from "./desk-model";
import type { Desk, DeskReply, DeskRow, RailStep } from "./desk-api";

const decided: Array<[string, Record<string, unknown>]> = [];
let dialog: Record<string, string> | null = null;
let deskReply: { ok: true; data: DeskReply } | { ok: false; error: string } = { ok: false, error: "x" };
vi.mock("../transport", () => ({ invoke: async () => ({ ok: true }), subscribeEvents: () => () => {}, authedFetch: async () => ({}) , SESSION_EXPIRED: "s" }));
vi.mock("../ui", () => ({ toast: () => {}, confirmDialog: async () => true, openDialog: async () => dialog }));
vi.mock("./board-api", () => ({
  loadCard: async () => ({ ok: true, data: {} }),
  decide: async (_id: string, action: string, params: Record<string, unknown>) => { decided.push([action, params]); return { ok: true }; },
  reopenScript: async () => ({ ok: true }),
}));
vi.mock("./desk-api", () => ({ loadDesk: async () => deskReply }));
vi.mock("./review/review-api", () => ({ decideItem: async () => ({ ok: true }), inboxHref: () => "#inbox" }));

const { PublishTable, CopyPanel } = await import("./PublishTable");
const { PublishDesk } = await import("./PublishDesk");
const { DeskProvider } = await import("./use-desk");
const { StageCard } = await import("./StageCard");

const row = (over: Partial<DeskRow> = {}): DeskRow => ({
  platform: "douyin", label: "抖音", state: "未发", status: "未发", tone: "todo", reason: null, url: null, slot_id: null, campaigns: [],
  times: { scheduled_at: null, submitted_at: null, observed_at: null, public_at: null }, when: null,
  data: { kind: "note", why: "not_public", text: "公开后回流" }, copy: { kind: "missing", text: "发布包还没备" }, action: null, more: [],
  backflow: { kind: "ok", auto: true, text: "" }, ...over,
});
const step = (key: string, label: string, state: RailStep["state"], extra: Partial<RailStep> = {}): RailStep => ({ key, label, state, at: null, current: false, ...extra });
const desk = (rows: DeskRow[], over: Partial<Desk> = {}): Desk => ({
  round: 2, rows, past: [], plan_error: null, headline: "1 个平台已投出", summary: null, refresh_at: null, cover: null, script: { final: true, label: "定稿" },
  rail: { steps: [step("script", "写稿", "完成", { at: "2026-10-01T02:00:00Z" }), step("aroll", "录制", "进行中", { current: true })], platforms: ["抖音"], chars: 1200, wpm: 240 }, ...over,
});

let root: Root; let el: HTMLElement;
beforeEach(() => { decided.length = 0; dialog = null; el = document.createElement("div"); document.body.append(el); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); el.remove(); });
const render = async (node: ReactNode) => { await act(async () => { root.render(node); }); await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const click = async (b: Element | null | undefined) => { await act(async () => { (b as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); };
const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("纯函数", () => {
  it("复制文案 = 标题 + 简介 + #标签；没备不给", () => {
    expect(copyText({ kind: "ready", source: "拟发", title: "T", caption: "简介", tags: ["AI", "效率"] })).toBe("T\n\n简介\n\n#AI #效率");
    expect(copyText({ kind: "missing", text: "发布包还没备" })).toBeNull();
  });
  it("数据列：数字或原因，不写 0", () => {
    expect(dataText(row({ data: { kind: "metrics", views: 12000, likes: 30, comments: null, metric_date: "", first_at: "", compare: { text: "", tone: "flat" } } }))).toBe("播放 1.2 万 · 点赞 30");
    expect(dataText(row({ data: { kind: "note", why: "login", text: "视频号登录过期，去 ego lite 登录后自动接上" } }))).toContain("登录过期");
  });
  it("进度栏：窄屏一行；没有记录 / 退回如实写；字数估时长", () => {
    expect(railLine([step("script", "写稿", "完成"), step("aroll", "录制", "完成"), step("cut", "剪辑", "进行中", { current: true }), step("cover", "封面", "未到")])).toBe("写稿 ✓ · 录制 ✓ · 剪辑 ● …");
    expect(stepSub(step("script", "写稿", "没有记录"))).toBe("没有记录");
    expect(stepSub(step("cut", "剪辑", "被退回", { note: "开头太慢" }))).toBe("退回 · 开头太慢");
    expect(stepSub(step("aroll", "录制", "完成", { at: "2026-09-27T04:00:00Z", note: "原片到" }))).toMatch(/^09-27 原片到$/);
    expect(lengthText(1200, 240)).toBe("约 1,200 字 · 约 5.0 分钟");
  });
});

describe("各平台表", () => {
  const props = (rows: DeskRow[], over: Partial<Desk> = {}) => ({ contentId: "content-1-a", title: "稿", desk: desk(rows, over), refresh: async () => {}, reload: async () => {} });
  it("边界 1：计划读不到 = 一行原因 + 重试；每行一个主动作", async () => {
    await render(createElement(PublishTable, props([row({ action: { kind: "prepare_publish", label: "让 Codex 发" } })], { plan_error: "发布记录不是合法 JSON" })));
    expect(el.textContent).toContain("发布计划读不到：发布记录不是合法 JSON");
    expect(button("重试")).toBeTruthy();
    expect(el.querySelectorAll(".desk-row button.primary")).toHaveLength(1);
  });
  it("确认发了带 fact_id + 本轮；更多里补链接 / 纠正都带平台和轮次（边界 12）", async () => {
    await render(createElement(PublishTable, props([row({ state: "应已公开", status: "应已公开 · 还没核到", action: { kind: "confirm_receipt", label: "确认发了", fact_id: "f-1" }, more: ["add_work_url", "correct_publish"], slot_id: "slot:2:douyin" })])));
    await click(button("确认发了"));
    expect(decided.at(-1)).toEqual(["confirm_receipt", { platform: "douyin", round: 2, fact_id: "f-1" }]);
    dialog = { url: "https://www.douyin.com/video/1" };
    await click(button("补作品链接"));
    expect(decided.at(-1)).toEqual(["add_work_url", { platform: "douyin", round: 2, url: "https://www.douyin.com/video/1" }]);
    await click(button("纠正"));
    expect(decided.at(-1)).toEqual(["correct_publish", { platform: "douyin", round: 2, target_id: "slot:2:douyin" }]);
  });
  it("手填数据：带日期、平台、轮次，只送填了的数", async () => {
    dialog = { metric_date: "2026-10-11", views: "900", likes: "", comments: "3" };
    await render(createElement(PublishTable, props([row({ platform: "bilibili", label: "B站", state: "已公开", status: "已公开", more: ["record_metrics"] })])));
    await click(button("手填数据"));
    expect(decided.at(-1)).toEqual(["record_metrics", { platform: "bilibili", round: 2, metric_date: "2026-10-11", metrics: { views: 900, comments: 3 } }]);
  });
  it("边界 8：上一轮的折叠在「以前的发布」", async () => {
    await render(createElement(PublishTable, props([row()], { past: [{ round: 1, platform: "douyin", label: "第 1 轮 · 发布计划里的记录", url: null, at: "" }] })));
    expect(el.querySelector(".desk-past summary")?.textContent).toBe("以前的发布 · 1 条");
  });
  it("边界 2 / 10：没备的不显示文案；复制失败写原因，文案留在框里可手动选", async () => {
    await render(createElement(CopyPanel, { r: row() }));
    expect(el.textContent).toContain("发布包还没备");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("没有剪贴板权限"); } } });
    await render(createElement(CopyPanel, { r: row({ copy: { kind: "ready", source: "实发", title: "T", caption: "C", tags: [] } }) }));
    await click(button("复制文案"));
    expect(el.textContent).toContain("复制没成功（没有剪贴板权限）");
    expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("T\n\nC");
  });
});

describe("发布台整页 + 卡", () => {
  const content = { id: "content-1-a", title: "稿", body: "正文", status: "published", platform: "douyin", updatedAt: "2026-10-12T00:00:00Z" } as never;
  const card = { id: "content-1-a", title: "稿", platform: "douyin", status: "published", active: true, column: "已发布", stage: "已发布", missing: [], badges: [], candidates: [], round: 2,
    targets: [{ platform: "douyin", state: "未发", actions: ["prepare_publish", "i_published"] }, { platform: "bilibili", state: "已公开", actions: ["correct_publish"] }] };
  const page = (cardNode: ReactNode) => createElement(DeskProvider, { contentId: "content-1-a", refreshKey: "k", children: createElement(PublishDesk, { content, versions: [], reload: async () => {}, stage: "已发布", stageCard: cardNode }) });
  it("边界 11：读取失败一行原因 + 重试，不显示空表", async () => {
    deskReply = { ok: false, error: "服务没响应（HTTP 500）" };
    await render(page(null));
    expect(el.textContent).toContain("发布台读不出来：服务没响应（HTTP 500）");
    expect(el.querySelector(".desk-table")).toBeNull();
  });
  it("吸收 14：发布表模式下卡上的平台标签只显示状态、不带动作；定稿标签；没事可做时写读模型的一句", async () => {
    deskReply = { ok: true, data: { active: true, card: { ...card, targets: [card.targets[1]] } as never, desk: desk([row({ platform: "bilibili", label: "B站", state: "已公开", status: "已公开" })], { summary: "B站 公开第 3 天：比你B站的中位数高 40%" }) } };
    const sc = createElement(StageCard, { content: { ...(content as object), body: "正文" } as never, transitions: [], isVideo: true, dirty: false, reload: async () => {}, showTitle: false, deskMode: true });
    await render(page(sc));
    expect(el.querySelector(".pchips .pchip-act")).toBeNull();
    expect(el.querySelector(".pchips")?.textContent).toContain("B站 · 已公开");
    expect(el.textContent).toContain("B站 公开第 3 天：比你B站的中位数高 40%");
    expect(el.textContent).toContain("口播稿 · 定稿");
    expect(el.textContent).toContain("已发布 · 1 个平台已投出");
    expect(el.querySelector(".desk-rail-line")?.textContent).toBe("写稿 ✓ · 录制 ●");
  });
});
