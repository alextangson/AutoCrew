// @vitest-environment happy-dom
/** 稿件页「现在轮到你 / AI 在做」卡（spec 2026-10-12 D、吸收 6/9/14/15）+ 平台标签纯函数 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { derivedModel, legacyModel } from "./stage-card-model";
import { chipText, showChips, targetDecision, sameTopicCards, type PublishTarget } from "./publish-targets";
import { createGuardedRunner } from "./guarded-action";

const decided: Array<[string, Record<string, unknown>]> = [];
const inboxCalls: Array<Record<string, unknown>> = [];
const confirms: string[] = [];
let card: Record<string, unknown> = {};
let decideReply: { ok: boolean; error?: string } = { ok: true };
vi.mock("../transport", () => ({ invoke: async () => ({ ok: true }) }));
vi.mock("../ui", () => ({ toast: () => {}, confirmDialog: async (d: { title: string }) => { confirms.push(d.title); return true; }, openDialog: async () => ({ url: "" }) }));
vi.mock("./board-api", () => ({
  loadCard: async () => ({ ok: true, data: card }),
  decide: async (_id: string, action: string, params: Record<string, unknown>) => { decided.push([action, params]); return decideReply; },
  reopenScript: async () => ({ ok: true }),
}));
vi.mock("./review/review-api", () => ({ decideItem: async (p: Record<string, unknown>) => { inboxCalls.push(p); return decideReply; }, inboxHref: () => "#inbox" }));

const T = (platform: string, state: PublishTarget["state"], actions: PublishTarget["actions"], extra: Partial<PublishTarget> = {}): PublishTarget => ({ platform, state, actions, ...extra });
const panel = (over: Record<string, unknown>) => ({ id: "content-1-a", title: "稿", platform: "douyin", status: "draft_ready", active: true, column: "写稿中", stage: null, missing: [], badges: [], candidates: [], arolls: [], round: 2, draft_item: { item_id: "draft:1", gen: "g1" }, ...over });

describe("卡片模型", () => {
  it("旧流转：写作中默认「完成初稿」而不是「返回修订」；其余合法流转进更多", () => {
    const m = legacyModel("drafting", [{ status: "revision" }, { status: "draft_ready" }, { status: "archived" }], false);
    expect(m.primary?.label).toBe("完成初稿");
    expect(m.more.map((x) => x.label)).toEqual(["返回修订", "归档稿件"]);
    expect(m.more.every((x) => x.confirm)).toBe(true);
  });
  it("本体视频稿 · 已发布：被驳回的平台给「重新提交」，红字写原因；只剩纠正时没有主按钮", () => {
    const bad = derivedModel(panel({ stage: "已发布", targets: [T("douyin", "已公开", ["correct_publish"]), T("bilibili", "被驳回", ["resubmit", "correct_publish"], { reason: "封面违规" })] }) as never, [], 0);
    expect(bad.primary?.label).toBe("重新提交：B站");
    expect(bad.text).toContain("B站没过审：封面违规");
    expect(derivedModel(panel({ stage: "已发布", alerts: ["B站被驳回：封面违规"], targets: [T("bilibili", "被驳回", ["resubmit"], { reason: "封面违规" })] }) as never, [], 0).notes).toEqual([]);
    const done = derivedModel(panel({ stage: "已发布", targets: [T("douyin", "已公开", ["correct_publish"])] }) as never, [], 0);
    expect(done).toMatchObject({ tone: "none", head: "没有要你做的", primary: null });
    expect(done.more.map((x) => x.label)).toContain("纠正：抖音其实没发");
  });
  it("「更多」逐个对应现有命令：撤回批准、纠正某平台、重开；退回修订只在制作前", () => {
    const m = derivedModel(panel({ stage: "剪辑中", approvals: { cut: { id: "d-cut" }, cover: null }, can_reopen: true, targets: [] }) as never, [{ status: "revision" }], 0);
    expect(m.more.map((x) => x.key)).toEqual(["revoke-cut", "reopen"]);
    expect(m.more[0].run).toEqual({ kind: "decide", action: "revoke_approval", params: { decision_id: "d-cut" } });
    const early = derivedModel(panel({ stage: "待录制", targets: [] }) as never, [{ status: "revision" }], 0);
    expect(early.more[0].label).toBe("退回修订");
  });
  it("AI 在做只在认领活着时说；否则说 N 小时没动静；没走认稿只提醒", () => {
    expect(derivedModel(panel({ stage: "剪辑中", claim: { host: "Codex", live: true, idle_hours: 0 }, targets: [] }) as never, [], 5).head).toBe("AI 在做 · Codex");
    expect(derivedModel(panel({ stage: "剪辑中", claim: { host: "Codex", live: false, idle_hours: 7 }, targets: [] }) as never, [], 5).head).toBe("AI 已 7 小时没动静");
    expect(derivedModel(panel({ stage: "已发布", no_script_approval: true, targets: [] }) as never, [], 0).notes[0]).toContain("没走认稿");
  });
  it("平台标签：按平台动作带平台和轮次；写稿中只有一个未发不显示；同主题互链", () => {
    const t = T("bilibili", "待核", ["confirm_receipt", "correct_publish"], { fact_id: "f1", slot_id: "slot:2:bilibili" });
    expect(targetDecision(t, "confirm_receipt", 2)).toEqual({ action: "confirm_receipt", params: { platform: "bilibili", round: 2, fact_id: "f1" } });
    expect(targetDecision(t, "correct_publish", 2)!.params).toMatchObject({ platform: "bilibili", round: 2, target_id: "slot:2:bilibili" });
    expect(chipText(T("douyin", "被驳回", [], { reason: "违规" }))).toBe("抖音 · 被驳回：违规");
    expect(showChips([T("douyin", "未发", [])], "写稿中")).toBe(false);
    expect(showChips([T("douyin", "未发", [])], "待发布")).toBe(true);
    const items = [{ id: "a", topicId: "t", platform: "douyin" }, { id: "b", topicId: "t", platform: "wechat_mp" }, { id: "c", topicId: null, platform: "douyin" }];
    expect(sameTopicCards(items, items[0]).map((x) => x.id)).toEqual(["b"]);
  });
  it("恢复动作当主按钮：文件不见了 → 重新核对；登记没写成 → 重试登记（盖过已发布 / 待发布的平台动作）", () => {
    const miss = derivedModel(panel({ stage: "待发布", recovery: { kind: "files_missing", reason: "x" }, targets: [T("douyin", "未发", ["i_published"])] }) as never, [], 0);
    expect(miss.primary).toMatchObject({ label: "文件找回来了，重新核对", run: { kind: "decide", action: "recheck_files" } });
    const reg = derivedModel(panel({ stage: "剪辑中", recovery: { kind: "registration_failed", reason: "字幕对不上" }, targets: [] }) as never, [], 0);
    expect(reg.primary?.run).toEqual({ kind: "decide", action: "retry_registration", params: {} });
    expect(reg.text).toContain("字幕对不上");
  });
  it("卡下面的面板只留卡上没有的：一样都没有就不占位", async () => {
    const { panelHasExtra } = await import("./CardPanel");
    expect(panelHasExtra(panel({ column: "已发布", missing: [] }) as never)).toBe(false);
    expect(panelHasExtra(panel({ column: "已发布", missing: [], past_receipts: [{ round: 1, platform: "douyin", label: "x", url: null, at: "" }] }) as never)).toBe(true);
  });
  it("防重复执行器：在飞时第二次不发；失败原因留着，重试再跑", async () => {
    const states: Array<{ busy: boolean; error: string | null }> = [];
    const r = createGuardedRunner((s) => states.push(s));
    let n = 0;
    const task = async () => { n++; return n === 1 ? { ok: false as const, error: "网络断了" } : { ok: true as const }; };
    const [a, b] = await Promise.all([r.run("x", task), r.run("x", task)]);
    expect(b).toBeNull();
    expect(a).toEqual({ ok: false, error: "网络断了" });
    expect(states.at(-1)).toMatchObject({ busy: false, error: "网络断了" });
    await r.retry();
    expect(n).toBe(2);
    expect(states.at(-1)).toMatchObject({ error: null });
  });
});

let el: HTMLDivElement;
let root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; decided.length = 0; inboxCalls.length = 0; confirms.length = 0; decideReply = { ok: true }; el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); });
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });
const tick = () => new Promise((r) => setTimeout(r, 10));
const click = async (b: Element) => { await act(async () => { (b as HTMLElement).click(); await tick(); }); };
const button = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === t);

async function render(over: Record<string, unknown>, dirty = false) {
  card = panel(over);
  const { StageCard } = await import("./StageCard");
  const content = { id: "content-1-a", title: "稿", status: String(card.status), platform: "douyin", body: "正文", updatedAt: new Date().toISOString() };
  await act(async () => { root.render(createElement(StageCard, { content, transitions: [], reload: async () => {}, isVideo: true, dirty })); await tick(); });
}

describe("StageCard 渲染", () => {
  it("写好的稿：一个主按钮「稿子没问题」，走「等你拍板」带代次；没保存时灰掉说原因", async () => {
    await render({ status: "draft_ready" }, true);
    expect(button("稿子没问题")!.hasAttribute("disabled")).toBe(true);
    expect(el.textContent).toContain("先保存修改");
    await render({ status: "draft_ready" });
    await click(button("稿子没问题")!);
    const { createHash } = await import("node:crypto");
    expect(inboxCalls).toEqual([{ content_id: "content-1-a", item_id: "draft:1", gen: "g1", action: "approve_script", expected_body_hash: createHash("sha256").update("正文").digest("hex") }]);
  });
  it("失败：原因常驻在卡里 + 重试，不静默", async () => {
    decideReply = { ok: false, error: "稿子刚改过" };
    await render({ status: "draft_ready" });
    await click(button("稿子没问题")!);
    expect(el.querySelector(".stage-card-error")?.textContent).toContain("稿子刚改过");
    decideReply = { ok: true };
    await click(button("重试")!);
    expect(inboxCalls).toHaveLength(2);
    expect(el.querySelector(".stage-card-error")).toBeNull();
  });
  it("待发布：平台标签上标已发，带平台和轮次；更多里的纠正先确认", async () => {
    await render({ status: "publish_ready", stage: "待发布", targets: [T("douyin", "已定时", ["correct_publish"], { slot_id: "slot:2:douyin" }), T("bilibili", "未发", ["prepare_publish", "i_published"])] });
    await click(button("标已发：B站")!);
    expect(decided[0]).toEqual(["i_published", { platform: "bilibili", round: 2 }]);
    await click(el.querySelector(".stage-card-more summary")!);
    await click([...el.querySelectorAll(".stage-card-menu button")].find((b) => b.textContent?.includes("纠正：抖音"))!);
    expect(confirms).toEqual(["纠正抖音的发布记录？"]);
    expect(decided[1]).toEqual(["correct_publish", { platform: "douyin", round: 2, target_id: "slot:2:douyin" }]);
  });
});
