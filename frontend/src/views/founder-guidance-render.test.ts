// @vitest-environment happy-dom
/** 1b 验收：卡片面板「下一步」、原片行、稿件页一步到位的阶段按钮 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const invokes: Array<Record<string, unknown>> = [];
const confirms: string[] = [];
vi.mock("../transport", () => ({ invoke: async (channel: string, payload: Record<string, unknown>) => { invokes.push({ channel, ...payload }); return { ok: true }; } }));
vi.mock("../ui", () => ({ toast: () => {}, confirmDialog: async (d: { title: string }) => { confirms.push(d.title); return true; }, openDialog: async () => null }));
vi.mock("./board-api", () => ({ revealFact: async () => ({ ok: true, data: {} }) }));
const decided: Array<Record<string, unknown>> = [];
vi.mock("./review/review-api", () => ({ decideItem: async (p: Record<string, unknown>) => { decided.push(p); return { ok: true, data: {} }; } }));

let el: HTMLDivElement;
let root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; invokes.length = 0; confirms.length = 0; decided.length = 0; el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); });
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });
const click = async (b: Element) => { await act(async () => { (b as HTMLElement).click(); await new Promise((r) => setTimeout(r, 10)); }); };
const button = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === t);

const card = (over: Record<string, unknown>) => ({ id: "content-1-a", title: "稿", platform: "douyin", status: "draft_ready", active: true, column: "写稿中", stage: null, missing: [], badges: [], candidates: [], arolls: [], ...over });

describe("卡片面板「下一步」", () => {
  async function render(d: Record<string, unknown>) {
    const acts: Array<[string, Record<string, unknown>]> = [];
    let opened = 0;
    const { CardNext } = await import("./CardNext");
    await act(async () => { root.render(createElement(CardNext, { d: d as never, busy: false, act: async (a: string, p: Record<string, unknown>) => { acts.push([a, p]); }, openEditor: () => { opened += 1; }, refresh: async () => {} })); });
    return { acts, opened: () => opened };
  }

  it("写稿中、稿写好了、还没原片 →「稿子没问题」+ 点了进待录制；点了走「等你拍板」的认稿，带卡片载入时那一版的代次", async () => {
    await render(card({ draft_item: { item_id: "draft:content-1-a", gen: "g-loaded" } }));
    expect(el.textContent).toContain("点了进待录制，等你录");
    await click(button("稿子没问题")!);
    expect(invokes).toEqual([]);
    expect(decided).toEqual([{ content_id: "content-1-a", item_id: "draft:content-1-a", gen: "g-loaded", action: "approve_script" }]);
  });
  it("卡片没有那一版的代次（稿子刚改过）：不认稿", async () => {
    await render(card({}));
    await click(button("稿子没问题")!);
    expect(decided).toEqual([]);
    expect(invokes).toEqual([]);
  });

  it("写稿中、已经有原片 → 说点了就进剪辑中", async () => {
    await render(card({ status: "reviewing", arolls: [{ fact_id: "f1" }] }));
    expect(button("稿子没问题")).toBeTruthy();
    expect(el.textContent).toContain("已经有原片了，点了就进剪辑中");
  });

  it("AI 还在写 → 不给按钮，说暂时不用你操作", async () => {
    await render(card({ status: "drafting" }));
    expect(el.textContent).toContain("AI 在写稿");
    expect(el.querySelector("button")).toBeNull();
  });

  it("待录制 → 说怎么挂原片", async () => {
    await render(card({ status: "approved", column: "待录制", stage: "待录制", missing: ["A-roll"] }));
    expect(el.textContent).toContain("录好放进收件箱会自动挂上");
  });

  it("剪辑中：成片待你审 →「去看成片」；封面待你选 →「去挑封面」；都不缺 → AI 在剪", async () => {
    const a = await render(card({ status: "editing", column: "剪辑中", stage: "剪辑中", missing: ["成片待你审"] }));
    await click(button("去看成片")!);
    expect(a.opened()).toBe(1);
    await render(card({ status: "editing", column: "剪辑中", stage: "剪辑中", missing: ["封面待你选"] }));
    expect(button("去挑封面")).toBeTruthy();
    await render(card({ status: "editing", column: "剪辑中", stage: "剪辑中", missing: ["字幕"] }));
    expect(el.textContent).toContain("AI 在剪，暂时不用你操作");
  });

  it("待发布 →「已经发出去了」走我发了", async () => {
    const r = await render(card({ status: "publish_ready", column: "待发布", stage: "待发布" }));
    await click(button("已经发出去了")!);
    expect(r.acts).toEqual([["i_published", { platform: "douyin" }]]);
  });
});

describe("已挂的原片行", () => {
  it("文件名、怎么来的、时长、时间、在访达中显示 +「不是」；两段以上先说清", async () => {
    const { CardArolls } = await import("./CardArolls");
    const rows = [
      { fact_id: "f1", sha256: "s1", path: "02-aroll/稿-原片.mov", name: "IMG_0421.MOV", origin: "你确认的", duration_ms: 95_000, at: "2026-09-30T00:34:00Z", auto_attached: false, source_path: "/u/downloads/IMG_0421.MOV", undo_blocked: null },
      { fact_id: "f2", sha256: "s2", path: "02-aroll/稿-原片-2.mov", name: "稿-原片.mov", origin: "收件箱自动挂上", duration_ms: 30_000, at: "2026-09-30T00:10:00Z", auto_attached: true, source_path: "/lib/inbox/稿-原片.mov", check: null, undo_blocked: "这条已经在剪了，要换原片请重开文稿", reassign_blocked: null },
    ];
    await act(async () => { root.render(createElement(CardArolls, { contentId: "content-1-a", rows: rows as never, busy: false, act: async () => {} })); });
    expect(el.textContent).toContain("这条有 2 段原片，剪辑时都会用到；多余的点「不是」");
    expect(el.textContent).toContain("IMG_0421.MOV");
    expect(el.textContent).toContain("你确认的");
    expect(el.textContent).toContain("1 分 35 秒");
    expect(el.textContent).toContain("收件箱自动挂上");
    expect([...el.querySelectorAll("button")].filter((b) => b.textContent === "不是")).toHaveLength(1);
    expect([...el.querySelectorAll("button")].filter((b) => b.textContent === "在访达中显示")).toHaveLength(2);
    expect(el.textContent).toContain("这条已经在剪了，要换原片请重开文稿");
    expect(el.textContent).not.toMatch(/fact|sha|版本/);
  });
});

describe("稿件页的阶段按钮一步到位", () => {
  const T = [{ status: "reviewing" }, { status: "approved" }, { status: "archived" }];
  async function render(currentStatus = "draft_ready") {
    const { StageAdvance } = await import("./StageAdvance");
    await act(async () => { root.render(createElement(StageAdvance, { contentId: "content-1-a", currentStatus, transitions: T as never, reload: async () => {}, isVideo: true, landedStage: async () => "剪辑中", loadedBody: "载入时的正文" })); });
  }

  it("写好 / 审过的稿默认就是「稿子没问题，进入制作」，一点就认稿", async () => {
    await render("reviewing");
    await click(button("稿子没问题，进入制作")!);
    // 认稿带页面载入那一版正文的哈希：别的会话改过就被服务端拒（整分支审 4 P1）
    const { createHash } = await import("node:crypto");
    expect(invokes).toEqual([{ channel: "content:transition", id: "content-1-a", target_status: "approved", from_status: "reviewing", expected_body_hash: createHash("sha256").update("载入时的正文").digest("hex") }]);
  });

  it("菜单里点哪项就执行哪项（不用再点顶部按钮）；「让 AI 再审一遍」是审稿；归档仍要确认", async () => {
    await render();
    await click(el.querySelector("button[aria-label='选择下一阶段动作']")!);
    await click([...el.querySelectorAll(".ed-stage-menu button")].find((b) => b.textContent?.includes("让 AI 再审一遍"))!);
    expect(invokes.at(-1)).toMatchObject({ target_status: "reviewing" });
    expect(confirms).toEqual([]);
    await click(el.querySelector("button[aria-label='选择下一阶段动作']")!);
    await click([...el.querySelectorAll(".ed-stage-menu button")].find((b) => b.textContent?.includes("归档"))!);
    expect(confirms).toEqual(["归档稿件？"]);
  });
});
