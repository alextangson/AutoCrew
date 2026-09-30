// @vitest-environment happy-dom
/**
 * 「等你拍板」前端（review-inbox 2a-2）：每类面板、三种按钮、空 / 收起、键盘、提示与撤回、版本切换、B7、提醒合并，
 * 以及「每类条目的每个按钮都按后端给的 params 原样交到 /api/inbox/decide」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InboxItem } from "./review-model";

const decided: Array<Record<string, unknown>> = [];
const undone: Array<[string, string, Record<string, unknown>]> = [];
let inbox: InboxItem[] = [];
let decideReply: Record<string, unknown> = { ok: true };
let failWith: string | null = null;
vi.mock("./review-api", () => ({
  loadInbox: async () => (failWith ? { ok: false, error: failWith } : { ok: true, data: { items: inbox, count: inbox.length, agent_waiting: 0, generated_at: "" } }),
  decideItem: async (p: Record<string, unknown>) => { decided.push(p); return decideReply.ok === false ? { ok: false, error: String(decideReply.error) } : { ok: true, data: decideReply }; },
  undoDecision: async (c: string, a: string, p: Record<string, unknown>) => { undone.push([c, a, p]); return { ok: true, data: {} }; },
  attachmentUrl: () => "/att",
  mediaUrl: (c: string, f: string) => `/media/${c}/${f}`,
  inboxHref: (id: string) => `#/board?inbox=${id}`,
  INBOX_OPEN_EVENT: "autocrew:inbox-open",
  openInboxItem: () => {},
}));
let draftBody = "正文第一段。";
vi.mock("../../transport", () => ({ invoke: async () => ({ ok: true, content: { body: draftBody } }), authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "x" }));

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  decided.length = 0; undone.length = 0; decideReply = { ok: true }; inbox = []; failWith = null; draftBody = "正文第一段。";
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
  window.localStorage?.clear?.();
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); vi.unstubAllGlobals(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const btn = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (b: Element | undefined) => { expect(b, "按钮在").toBeTruthy(); await act(async () => { (b as HTMLElement).click(); }); await tick(); };
const key = async (k: string) => { await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); }); await tick(); };

const base = (over: Partial<InboxItem>): InboxItem => ({ item_id: "x", gen: "g", type: "draft", content_id: "content-1-a", title: "测试稿", summary: "", waiting: null, agent_waiting: false,
  since: new Date(Date.now() - 5 * 60_000).toISOString(), rank: 1, actions: [], detail: {}, ...over });

export const ITEMS: InboxItem[] = [
  base({ item_id: "ask:ask-1", type: "ask", rank: 0, agent_waiting: true, waiting: { host: "claude-code", label: "Claude" }, summary: "Claude想问你：粗剪这样行吗？",
    actions: [{ action: "answer_ask", label: "可以", role: "secondary", params: { ask_id: "ask-1", option_id: "ok" }, note: "optional" }, { action: "answer_ask", label: "再改改", role: "secondary", params: { ask_id: "ask-1", option_id: "redo" }, note: "optional" }],
    detail: { ask_id: "ask-1", kind: "粗剪", question: "粗剪这样行吗？", options: [], attachments: [], attachments_changed: false } }),
  base({ item_id: "cut:r1", type: "cut_review", summary: "成片剪好了，看一遍", waiting: { host: "codex", label: "Codex" },
    actions: [{ action: "approve_cut", label: "就用这版", role: "primary", params: { fact_id: "f2", sha256: "s2" } }, { action: "reject_cut", label: "还要改…", role: "secondary", params: { fact_id: "f2", sha256: "s2" }, note: "required", placeholder: "比如：开头有点拖，前 10 秒再紧一点" }],
    detail: { review_fact_id: "f2", editor_label: "Codex", versions: [{ fact_id: "f2", sha256: "s2", at: new Date().toISOString(), label: "最新一版", ready: true, has_srt: true }, { fact_id: "f1", sha256: "s1", at: new Date(Date.now() - 3600_000).toISOString(), label: "上一版", ready: true }] } }),
  base({ item_id: "cover:r1", type: "cover_pick", summary: "封面做好了，挑一张",
    actions: [{ action: "pick_cover", label: "用这组", role: "primary", params: { group_id: "cg-2", cover_text: "字" } }, { action: "reject_cover", label: "还要改…", role: "secondary", note: "required" }, { action: "retire_cover_group", label: "这组不要了", role: "quiet", params: { group_id: "cg-2" } }],
    detail: { groups: [{ group_id: "cg-2", label: "最新一组", at: new Date().toISOString(), text: "字", approved: false, "3:4": { fact_id: "fc1", sha256: "c1" }, "4:3": { fact_id: "fc2", sha256: "c2" } }], incomplete: [] } }),
  base({ item_id: "cand:f9", type: "candidate", summary: "找到一段成片，是这条的吗", actions: [{ action: "confirm_candidate", label: "对，就是它", role: "primary", params: { fact_id: "f9", sha256: "s9" } }, { action: "reject_candidate", label: "不是", role: "secondary", params: { fact_id: "f9", sha256: "s9" } }], detail: { fact_id: "f9", kind: "cut", name: "x.mp4", reason: "文件名和标题对上了", preview: true } }),
  base({ item_id: "sliver:f2", type: "sliver", summary: "画面有闪帧（1 处）", actions: [{ action: "reject_cut", label: "去剪辑里改", role: "primary", params: { fact_id: "f2", sha256: "s2" }, note: "optional" }],
    detail: { status: "slivers", items: [{ key: "k1", start_tc: "00:00:03", frames: 5, prev_name: "空镜", next_name: "动效", suggestion: null, waived: false, action: { action: "waive_sliver", label: "这处是故意的", role: "secondary", params: { cut_sha: "s2", fingerprint: "fp", sliver_key: "k1" } } }] } }),
  base({ item_id: "register:r1", type: "register_blocked", summary: "还差一步才能发：缺这版成片的字幕", actions: [{ action: "nudge", label: "让 Codex 补", role: "primary" }], detail: { reason: "缺这版成片的字幕" } }),
  base({ item_id: "pubcheck:r1:douyin", type: "publish_check", rank: 2, summary: "发之前再看一眼（抖音）", actions: [{ action: "publish_check_confirm", label: "没问题", role: "primary", params: { check_id: "chk-1" } }, { action: "publish_check_revise", label: "有几处要改…", role: "secondary", params: { check_id: "chk-1" }, note: "required" }], detail: { platform: "douyin", verdict: "pass", items: [] } }),
  base({ item_id: "published:content-1-a:r1:douyin", type: "published_ask", rank: 2, summary: "发了吗（抖音）", actions: [{ action: "i_published", label: "已经发出去了", role: "primary", params: { platform: "douyin" }, note: "optional" }], detail: { platform: "douyin" } }),
  base({ item_id: "claim:content-1-a:r1:douyin", type: "publish_claim", rank: 2, summary: "Claude说已经发了（抖音）", actions: [{ action: "confirm_receipt", label: "对，发了", role: "primary", params: { fact_id: "p1" } }, { action: "correct_publish", label: "没发", role: "secondary", params: { target_id: "slot:1:douyin" } }], detail: { platform: "douyin" } }),
  base({ item_id: "draft:content-2-b", content_id: "content-2-b", type: "draft", rank: 3, summary: "稿子写好了，过一眼", actions: [{ action: "approve_script", label: "稿子没问题", role: "primary" }, { action: "revise_script", label: "还要改…", role: "secondary", note: "required" }], detail: { words: 300 } }),
];

async function mountInbox(items: InboxItem[]) {
  inbox = items;
  const { ReviewInbox } = await import("./ReviewInbox");
  await act(async () => { root.render(createElement(ReviewInbox)); });
  await tick();
}
const openRow = async (label: string) => click([...el.querySelectorAll(".ri-row")].find((r) => r.getAttribute("aria-label") === label));

describe("三种按钮（§4.2）", () => {
  it("primary / secondary / quiet 各有一个样子；旧名 ghost / danger 不是第四种", async () => {
    const { btnClass } = await import("../../components/Button");
    expect(btnClass("primary")).toBe("primary");
    expect(btnClass("secondary")).toBe("");
    expect(btnClass("quiet")).toBe("btn-ghost");
    expect(btnClass("ghost")).toBe("btn-ghost");
  });
});

describe("列表：空 / 收起 / 展开（§2）", () => {
  it("没事时收成一行「没有等你拍板的事」", async () => {
    await mountInbox([]);
    expect(el.textContent).toContain("没有等你拍板的事");
    expect(el.querySelector(".ri-list")).toBeNull();
  });
  it("有事自动展开；可以收起；有 agent 在等的行首有小蓝点", async () => {
    await mountInbox(ITEMS);
    expect(el.querySelectorAll(".ri-row").length).toBe(ITEMS.length);
    expect(el.querySelectorAll(".ri-dot").length).toBe(1);
    expect(el.querySelector(".ri-row")!.textContent).toContain("测试稿 · Claude在等");
    expect(el.querySelector(".ri-row")!.textContent).toContain("5 分钟前");
    await click(btn("收起"));
    expect(el.querySelector(".ri-list")).toBeNull();
    expect(document.title).toBe(`(${ITEMS.length}) AutoCrew`);
  });
});

describe("每类面板（§3.1）", () => {
  it.each(ITEMS.map((i) => [i.type, i] as const))("%s：标题、属性行和后端给的按钮", async (_t, item) => {
    await mountInbox([item]);
    await openRow(item.summary);
    const peek = el.querySelector(".ri-peek")!;
    expect(peek.querySelector("h2")!.textContent).toBe(item.summary);
    if (item.type !== "sliver" && item.type !== "register_blocked") expect(peek.querySelector(".ri-props")).toBeTruthy();
    for (const a of item.actions) expect([...peek.querySelectorAll("button")].some((b) => b.textContent === a.label)).toBe(true);
    const primaries = [...peek.querySelectorAll("button.primary")].filter((b) => b.textContent !== "发送");
    expect(primaries.length).toBeLessThanOrEqual(1);
    expect(peek.textContent).not.toMatch(/sha|fact|B-roll|A-roll|LUFS/);
  });
  it("成片：视频播放器；封面：3:4 + 4:3 并排；稿子：只读正文", async () => {
    await mountInbox([ITEMS[1], ITEMS[2], ITEMS[9]]);
    await openRow("成片剪好了，看一遍");
    expect(el.querySelector(".ri-peek video")).toBeTruthy();
    await openRow("封面做好了，挑一张");
    expect(el.querySelectorAll(".ri-peek .ri-covers img").length).toBe(2);
    await openRow("稿子写好了，过一眼");
    expect(el.querySelector(".ri-peek .ri-body")!.textContent).toContain("正文第一段");
  });
});

describe("版本切换（安静的分段胶囊）", () => {
  it("按时间标「最新一版 / 上一版」，切到上一版后「就用这版」交的是那一版", async () => {
    await mountInbox([ITEMS[1]]);
    await openRow("成片剪好了，看一遍");
    const tabs = [...el.querySelectorAll(".ri-pill span")].map((s) => s.textContent);
    expect(tabs).toEqual(["最新一版", "上一版"]);
    await click([...el.querySelectorAll(".ri-pill span")][1]);
    await click(btn("就用这版"));
    expect(decided.at(-1)).toMatchObject({ item_id: "cut:r1", gen: "g", action: "approve_cut", fact_id: "f1" });
  });
});

describe("「…」动作就地展开输入框，回车发送", () => {
  it("还要改… → 输入框（真实例子做提示）→ 回车发", async () => {
    await mountInbox([ITEMS[1]]);
    await openRow("成片剪好了，看一遍");
    await click(btn("还要改…"));
    const ta = el.querySelector(".ri-inline textarea") as HTMLTextAreaElement;
    expect(ta.placeholder).toBe("比如：开头有点拖，前 10 秒再紧一点");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, "前 10 秒再紧一点");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await tick();
    expect(decided.at(-1)).toMatchObject({ action: "reject_cut", note: "前 10 秒再紧一点", fact_id: "f2" });
  });
});

describe("做完之后：提示 · 撤回 · 还有 N 件，自动打开下一件；键盘", () => {
  it("就用这版 → 「这版定了 · 撤回 · 还有 N 件」，点撤回 = 撤销这条批准；下一件自动打开", async () => {
    decideReply = { ok: true, decision: { id: "dec-9" } };
    await mountInbox([ITEMS[1], ITEMS[2]]);
    await openRow("成片剪好了，看一遍");
    inbox = [ITEMS[2]];
    await click(btn("就用这版"));
    const t = el.querySelector(".ri-toast")!;
    expect(t.textContent).toContain("这版定了");
    expect(t.textContent).toContain("还有 1 件");
    expect(el.querySelector(".ri-peek h2")!.textContent).toBe("封面做好了，挑一张");
    await click(btn("撤回"));
    expect(undone).toEqual([["content-1-a", "revoke_approval", { decision_id: "dec-9" }]]);
  });
  it("撤不回的（候选确认）不给「撤回」", async () => {
    await mountInbox([ITEMS[3]]);
    await openRow("找到一段成片，是这条的吗");
    inbox = [];
    await click(btn("对，就是它"));
    expect(el.querySelector(".ri-toast")!.textContent).toContain("都处理完了");
    expect(btn("撤回")).toBeUndefined();
  });
  it("↓ / ↑ 切换条目，回车 = 主按钮", async () => {
    await mountInbox([ITEMS[1], ITEMS[6]]);
    await key("ArrowDown");
    expect(el.querySelector(".ri-peek h2")!.textContent).toBe("成片剪好了，看一遍");
    await key("ArrowDown");
    expect(el.querySelector(".ri-peek h2")!.textContent).toBe("发之前再看一眼（抖音）");
    await key("ArrowUp");
    await key("ArrowDown");
    await key("Enter");
    expect(decided.at(-1)).toMatchObject({ action: "publish_check_confirm", check_id: "chk-1", item_id: "pubcheck:r1:douyin" });
  });
  it("别处处理掉了：面板提示「已在别处处理」，不再给按钮", async () => {
    await mountInbox([ITEMS[3]]);
    await openRow("找到一段成片，是这条的吗");
    inbox = [];
    const { POLL_MS } = await import("./ReviewInbox");
    await act(async () => { await new Promise((r) => setTimeout(r, POLL_MS + 100)); });
    expect(el.querySelector(".ri-peek")!.textContent).toContain("已在别处处理");
    expect(btn("对，就是它")).toBeUndefined();
  }, 10_000);
});

describe("每类条目的每个按钮：原样交到 /api/inbox/decide", () => {
  it.each(ITEMS.flatMap((i) => i.actions.map((a, n) => [`${i.type}·${a.label}`, i, n] as const)))("%s", async (_n, item, n) => {
    await mountInbox([item]);
    await openRow(item.summary);
    const a = item.actions[n];
    const b = [...el.querySelectorAll(".ri-peek button")].filter((x) => x.textContent === a.label)[a.params?.option_id === "redo" ? 0 : 0];
    await click(b);
    if (a.note === "required") {
      const ta = el.querySelector(".ri-inline textarea") as HTMLTextAreaElement;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "改一下"); ta.dispatchEvent(new Event("input", { bubbles: true })); });
      await click(btn("发送"));
    }
    const sent = decided.at(-1)!;
    expect(sent).toMatchObject({ content_id: item.content_id, item_id: item.item_id, gen: item.gen, action: a.action, ...(a.params ?? {}) });
    if (a.note === "required") expect(sent.note).toBe("改一下");
  });
  it("闪帧的「这处是故意的」交的是那一处的 params", async () => {
    await mountInbox([ITEMS[4]]);
    await openRow("画面有闪帧（1 处）");
    await click(btn("这处是故意的"));
    expect(decided.at(-1)).toMatchObject({ action: "waive_sliver", cut_sha: "s2", fingerprint: "fp", sliver_key: "k1", item_id: "sliver:f2" });
  });
});

describe("B7：agent 没说可以审，创始人要审", () => {
  it("卡上写「有 N 个导出，X 还没说可以审了」；「我现在就要审」= review_now，然后打开列表里那件", async () => {
    const acts: string[] = [];
    let went = false;
    const { UnreviewedCut } = await import("../CardPanel");
    await act(async () => { root.render(createElement(UnreviewedCut, { u: { count: 2, editor_label: "Claude" }, busy: false, act: async (a: string) => { acts.push(a); }, goInbox: () => { went = true; } })); });
    expect(el.textContent).toContain("有 2 个导出，Claude还没说可以审了");
    const b = btn("我现在就要审")!;
    expect(b.className).toBe("btn-ghost");
    await click(b);
    expect(acts).toEqual(["review_now"]);
    expect(went).toBe(true);
  });
});

describe("网页提醒（§9）", () => {
  it("只提醒 agent 在等 / 挡住推进的；同一条稿 10 分钟内合并；同一件不重复", async () => {
    const { newNotifyState, toNotify, COALESCE_MS } = await import("./review-model");
    const s = newNotifyState();
    const a = ITEMS[0], b = ITEMS[1], draft = ITEMS[9];
    expect(toNotify([a, b, draft], s, 0).map((i) => i.item_id)).toEqual([a.item_id]);
    expect(toNotify([a, b], s, 1000)).toEqual([]);
    const later = { ...ITEMS[2], gen: "g2" };
    expect(toNotify([later], s, 2000)).toEqual([]);
    const other = { ...ITEMS[2], item_id: "cover:r2", gen: "g3" };
    expect(toNotify([other], s, COALESCE_MS + 5000).map((i) => i.item_id)).toEqual(["cover:r2"]);
  });
  function fakeNotification(permission: NotificationPermission, answer: NotificationPermission = "granted") {
    const created: Array<{ title: string; onclick: (() => void) | null; close: () => void }> = [];
    const N = Object.assign(function (this: { title: string; onclick: (() => void) | null; close: () => void }, title: string) { this.title = title; this.onclick = null; this.close = () => {}; created.push(this); },
      { permission, requestPermission: vi.fn(async () => { N.permission = answer; return answer; }) });
    vi.stubGlobal("Notification", N);
    return { N, created };
  }
  const nextPoll = async () => { const { POLL_MS } = await import("./ReviewInbox"); await act(async () => { await new Promise((r) => setTimeout(r, POLL_MS + 100)); }); };

  it("加载时不问授权；有值得提醒的事时列表头给「打开提醒」，点了才问", async () => {
    const { N } = fakeNotification("default");
    await mountInbox([ITEMS[0]]);
    expect(N.requestPermission).not.toHaveBeenCalled();
    await click(btn("打开提醒"));
    expect(N.requestPermission).toHaveBeenCalledTimes(1);
    expect(btn("打开提醒")).toBeUndefined();
  });
  it("没有值得提醒的事（只有稿子）：不给「打开提醒」", async () => {
    fakeNotification("default");
    await mountInbox([ITEMS[9]]);
    expect(btn("打开提醒")).toBeUndefined();
  });
  it("拒了：不给按钮、不再问，只在标签页标题显示件数", async () => {
    const { N, created } = fakeNotification("denied");
    await mountInbox([ITEMS[0], ITEMS[1]]);
    expect(btn("打开提醒")).toBeUndefined();
    expect(N.requestPermission).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(document.title).toBe("(2) AutoCrew");
  });
  it("已授权：页面打开时已有的事不弹；之后新来的才弹，点了打开那一件", async () => {
    const { created } = fakeNotification("granted");
    await mountInbox([ITEMS[0], ITEMS[1]]);
    expect(created).toHaveLength(0);
    const fresh = { ...ITEMS[2], content_id: "content-9-z", item_id: "cover:r9" };
    inbox = [ITEMS[0], ITEMS[1], fresh];
    await nextPoll();
    expect(created.map((c) => c.title)).toEqual([fresh.summary]);
    await act(async () => { created[0].onclick!(); });
    await tick();
    expect(el.querySelector(".ri-peek h2")!.textContent).toBe(fresh.summary);
  }, 15_000);
});

const candCover = (n: number): InboxItem => base({ item_id: `cand:c${n}`, gen: `g${n}`, type: "candidate", summary: "找到一张封面，是这条的吗",
  actions: [{ action: "confirm_candidate", label: "对，就是它", role: "primary", params: { fact_id: `c${n}`, sha256: `s${n}` } }, { action: "reject_candidate", label: "不是", role: "secondary", params: { fact_id: `c${n}`, sha256: `s${n}` } }],
  detail: { fact_id: `c${n}`, kind: "cover", name: `${n}.png`, reason: "放在 AutoCrew 不会自动收的文件夹里，要你确认", preview: true } });
const draftOf = (n: number): InboxItem => base({ item_id: `draft:content-${n}-d`, content_id: `content-${n}-d`, gen: `d${n}`, title: `稿子${n}`, type: "draft", rank: 3, summary: "稿子写好了，过一眼",
  actions: [{ action: "approve_script", label: "稿子没问题", role: "primary" }, { action: "revise_script", label: "还要改…", role: "secondary", note: "required" }], detail: { words: 100 } });

describe("合成的行（2a 真实数据验收）", () => {
  it("同一条稿的 3 张候选封面 = 一行「找到 3 张封面，看看是不是这条的」；面板里逐张有图、对 / 不是，另有「都不是」", async () => {
    await mountInbox([candCover(1), candCover(2), candCover(3)]);
    expect(el.querySelectorAll(".ri-row").length).toBe(1);
    await openRow("找到 3 张封面，看看是不是这条的");
    expect(el.querySelectorAll(".ri-peek img").length).toBe(3);
    inbox = [candCover(1), candCover(3)];
    await click([...el.querySelectorAll(".ri-peek button")].filter((b) => b.textContent === "不是")[1]);
    expect(decided.at(-1)).toMatchObject({ item_id: "cand:c2", gen: "g2", action: "reject_candidate", fact_id: "c2" });
    decided.length = 0;
    await click(btn("都不是"));
    expect(decided.map((d) => d.item_id)).toEqual(["cand:c1", "cand:c3"]);
  });
  it("9 篇稿子 = 一行「9 篇稿子写好了，过一眼」；面板一篇一篇过，「下一篇」换一篇", async () => {
    await mountInbox(Array.from({ length: 9 }, (_, i) => draftOf(i + 1)));
    expect(el.querySelectorAll(".ri-row").length).toBe(1);
    await openRow("9 篇稿子写好了，过一眼");
    expect(el.querySelector(".ri-peek")!.textContent).toContain("第 1 篇，共 9 篇：稿子1");
    await click(btn("下一篇"));
    expect(el.querySelector(".ri-peek")!.textContent).toContain("第 2 篇，共 9 篇：稿子2");
    await click(btn("稿子没问题"));
    expect(decided.at(-1)).toMatchObject({ item_id: "draft:content-2-d", gen: "d2", action: "approve_script" });
  });
  it("缩略图：候选封面是图、候选成片是视频帧、稿子才是「稿」", async () => {
    await mountInbox([candCover(1), ITEMS[3], ITEMS[9]]);
    const thumb = (label: string) => [...el.querySelectorAll(".ri-row")].find((r) => r.getAttribute("aria-label") === label)!.querySelector(".ri-thumb")!;
    expect(thumb("找到一张封面，是这条的吗").querySelector("img")).toBeTruthy();
    expect(thumb("找到一段成片，是这条的吗").querySelector("video")).toBeTruthy();
    expect(thumb("稿子写好了，过一眼").textContent).toBe("稿");
    await openRow("找到一段成片，是这条的吗");
    expect(el.querySelector(".ri-peek video")).toBeTruthy();
    expect(el.querySelector(".ri-peek")!.textContent).toContain("文件名和标题对上了");
  });
});

describe("回车（整分支审 P1）", () => {
  it("回车交的是面板上正在看的那一版（切到上一版后回车 = 就用上一版）", async () => {
    await mountInbox([ITEMS[1]]);
    await openRow("成片剪好了，看一遍");
    await click([...el.querySelectorAll(".ri-pill span")][1]);
    await key("Enter");
    expect(decided.at(-1)).toMatchObject({ action: "approve_cut", fact_id: "f1" });
  });
  it("回车交的是改过的封面字", async () => {
    await mountInbox([ITEMS[2]]);
    await openRow("封面做好了，挑一张");
    const input = el.querySelector(".ri-peek input") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "新的字"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await key("Enter");
    expect(decided.at(-1)).toMatchObject({ action: "pick_cover", group_id: "cg-2", cover_text: "新的字" });
  });
  it("焦点在次按钮（「没发」）上按回车：不跑主按钮；那个按钮自己的动作照常", async () => {
    await mountInbox([ITEMS[8]]);
    await openRow("Claude说已经发了（抖音）");
    const no = btn("没发")!;
    no.focus();
    await act(async () => { no.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await tick();
    expect(decided).toEqual([]);
    await click(no);
    expect(decided.at(-1)).toMatchObject({ action: "correct_publish", target_id: "slot:1:douyin" });
  });
  it("焦点在版本切换上按回车：不跑主按钮", async () => {
    await mountInbox([ITEMS[1]]);
    await openRow("成片剪好了，看一遍");
    const tab = el.querySelector(".ri-pill span") as HTMLElement;
    await act(async () => { tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await tick();
    expect(decided).toEqual([]);
  });
});

describe("卡片：以前的封面文件", () => {
  it("收成一行「以前的封面文件 N 张（不在正式封面文件夹里）」，「都不要」一次否掉", async () => {
    const acts: string[] = [];
    const { StrayCovers } = await import("../CardPanel");
    await act(async () => { root.render(createElement(StrayCovers, { n: 39, busy: false, act: async (a: string) => { acts.push(a); } })); });
    expect(el.textContent).toContain("以前的封面文件 39 张（不在正式封面文件夹里）");
    await click(btn("都不要"));
    expect(acts).toEqual(["reject_stray_covers"]);
  });
});

describe("件数 = 看到的行数", () => {
  it("一段成片候选 + 9 篇稿子 = 2 行：列表头「2 件」，标签页「(2) AutoCrew」", async () => {
    await mountInbox([ITEMS[3], ...Array.from({ length: 9 }, (_, i) => draftOf(i + 1))]);
    expect(el.querySelectorAll(".ri-row").length).toBe(2);
    expect(el.querySelector(".ri-count")!.textContent).toBe("2 件");
    expect(document.title).toBe("(2) AutoCrew");
  });
});

describe("两条稿同一轮的成片、封面（整分支审 2）", () => {
  it("4 件 = 4 行；每个面板的预览、决定都是自己那条稿的", async () => {
    const cutOf = (cid: string, t: string): InboxItem => ({ ...ITEMS[1], item_id: `cut:${cid}:r1`, content_id: cid, title: t, detail: { ...ITEMS[1].detail, review_fact_id: `f-${cid}`, versions: [{ fact_id: `f-${cid}`, sha256: "s", at: new Date().toISOString(), label: "最新一版" }] },
      actions: [{ action: "approve_cut", label: "就用这版", role: "primary", params: { fact_id: `f-${cid}`, sha256: "s" } }] });
    const coverOf = (cid: string, t: string): InboxItem => ({ ...ITEMS[2], item_id: `cover:${cid}:r1`, content_id: cid, title: t });
    await mountInbox([cutOf("content-1-a", "甲"), cutOf("content-2-b", "乙"), coverOf("content-1-a", "甲"), coverOf("content-2-b", "乙")]);
    expect(el.querySelectorAll(".ri-row").length).toBe(4);
    const rowsOf = [...el.querySelectorAll(".ri-row")].filter((r) => r.getAttribute("aria-label") === "成片剪好了，看一遍");
    await click(rowsOf[1]);
    const title = el.querySelector(".ri-peek .ri-props dd")!.textContent;
    const cid = title === "甲" ? "content-1-a" : "content-2-b";
    expect(el.querySelector(".ri-peek video")!.getAttribute("src")).toBe(`/media/${cid}/f-${cid}`);
    await click(btn("就用这版"));
    expect(decided.at(-1)).toMatchObject({ content_id: cid, item_id: `cut:${cid}:r1`, fact_id: `f-${cid}` });
  });
});

describe("列表读不成（整分支审 3 P2）", () => {
  const poll = async () => { const { POLL_MS } = await import("./ReviewInbox"); await act(async () => { await new Promise((r) => setTimeout(r, POLL_MS + 100)); }); };
  it("连不上：旧列表留着，列表头写「连不上 AutoCrew，列表停在 HH:MM」，标题「(N?) AutoCrew」；主按钮明说没记上；下一次读成就恢复", async () => {
    await mountInbox([ITEMS[6]]);
    failWith = "连不上 AutoCrew 服务：fetch failed";
    await poll();
    expect(el.querySelectorAll(".ri-row").length).toBe(1);
    expect(el.querySelector(".ri-warn")!.textContent).toMatch(/^连不上 AutoCrew，列表停在 \d\d:\d\d$/);
    expect(document.title).toBe("(1?) AutoCrew");
    await openRow("发之前再看一眼（抖音）");
    await click(btn("没问题"));
    expect(decided).toEqual([]);
    expect(el.querySelector(".ri-toast")!.textContent).toContain("这次没记上");
    failWith = null;
    await poll();
    expect(el.querySelector(".ri-warn")).toBeNull();
    expect(document.title).toBe("(1) AutoCrew");
  }, 15_000);
  it("登录过期：列表头写「登录过期，刷新页面」", async () => {
    await mountInbox([ITEMS[6]]);
    failWith = "x";
    await poll();
    expect(el.querySelector(".ri-warn")!.textContent).toBe("登录过期，刷新页面");
  }, 10_000);
});

describe("整分支审 5", () => {
  const sha = async (t: string) => (await import("node:crypto")).createHash("sha256").update(t).digest("hex");
  it("稿子那一行：轮询换了代次就重读正文；认稿交的是新代次 + 屏幕上这份正文的哈希", async () => {
    await mountInbox([draftOf(1), draftOf(2)]);
    await openRow("2 篇稿子写好了，过一眼");
    await tick();
    expect(el.querySelector(".ri-body")!.textContent).toBe("正文第一段。");
    draftBody = "别的会话改过的正文。";
    inbox = [{ ...draftOf(1), gen: "d1-new" }, draftOf(2)];
    const { POLL_MS } = await import("./ReviewInbox");
    await act(async () => { await new Promise((r) => setTimeout(r, POLL_MS + 100)); });
    await tick();
    expect(el.querySelector(".ri-body")!.textContent).toBe("别的会话改过的正文。");
    await click(btn("稿子没问题"));
    expect(decided.at(-1)).toMatchObject({ item_id: "draft:content-1-d", gen: "d1-new", action: "approve_script", expected_body_hash: await sha("别的会话改过的正文。") });
  }, 15_000);
  it("标签页在后台：照样慢慢轮询，新来的事照样弹提醒、标题件数更新", async () => {
    const created: string[] = [];
    const N = Object.assign(function (this: { onclick: null; close: () => void }, title: string) { created.push(title); this.onclick = null; this.close = () => {}; }, { permission: "granted", requestPermission: vi.fn() });
    vi.stubGlobal("Notification", N);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      inbox = [ITEMS[0]];
      const { ReviewInbox } = await import("./ReviewInbox");
      await act(async () => { root.render(createElement(ReviewInbox, { hiddenPollMs: 300 })); });
      await tick();
      expect(created).toEqual([]);
      const other = { ...ITEMS[1], item_id: "cut:content-9-z:r1", content_id: "content-9-z" };
      inbox = [ITEMS[0], other];
      await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
      expect(document.title).toBe("(2) AutoCrew");
      expect(created).toEqual([ITEMS[1].summary]);
    } finally { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); }
  }, 10_000);
});
