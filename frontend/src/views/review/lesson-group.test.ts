// @vitest-environment happy-dom
/**
 * 改稿经验组（spec 2026-10-15 §A）：按稿收成一行、逐条要 / 不要、同手册合并批、满 12 条变替换、stale 整组提示、双击去重。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { groupRows, type InboxItem } from "./review-model";

const rules: Array<Record<string, unknown>> = [];
const books: Array<Record<string, unknown>> = [];
let bookReply: { ok: boolean; error?: string; body?: Record<string, unknown> } = { ok: true };
vi.mock("./review-api", () => ({
  decideRule: async (b: Record<string, unknown>) => { rules.push(b); return { ok: true, data: {} }; },
  decidePlaybook: async (b: Record<string, unknown>) => { books.push(b); return bookReply.ok ? { ok: true, data: {} } : { ok: false, error: bookReply.error, body: bookReply.body }; },
}));
const { LessonPanel, STALE_NOTE } = await import("./LessonGroup");

const item = (over: Partial<InboxItem>): InboxItem => ({ item_id: "x", gen: "g", type: "writing_rule", content_id: "content-1-a", title: "写作规则提案", summary: "s", waiting: null, agent_waiting: false,
  since: "2026-10-15T00:00:00.000Z", rank: 4, actions: [], detail: {}, ...over });
const rule = (id: string, over: Record<string, unknown> = {}) => item({ item_id: `rule:${id}`, summary: `规则${id}`, detail: { rule_id: id, revision: 1, rule: `规则${id}`, question: "以后每篇都这样写？", words_text: "你选了 A：说人话版", content_title: "喊一定没用", active_rule_count: 3, rule_cap: 12, active_rules: [], ...over } });
const lesson = (id: string, text: string) => item({ item_id: `playbook:${id}`, gen: `gen-${id}`, type: "playbook_change", summary: text,
  detail: { playbook: "ganhuo", playbook_name: "干货方法", proposal_id: id, kind: "lesson", based_on: 1, lesson: text, merge_key: "ganhuo@1", question: "以后《干货方法》都这样写？", words_text: "（选卡时的回复，原卡没记下）", content_title: "喊一定没用" } });

let el: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rules.length = 0; books.length = 0; bookReply = { ok: true };
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });
const btn = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (t: string) => { const b = btn(t); expect(b, `按钮「${t}」在`).toBeTruthy(); await act(async () => { b!.click(); await new Promise((r) => setTimeout(r, 10)); }); };
const render = async (items: InboxItem[], gone = false) => {
  const [row] = groupRows(items);
  await act(async () => { root.render(createElement(LessonPanel, { row, gone, onClose: () => {}, reload: async () => {} })); });
  return row;
};

describe("改稿经验组", () => {
  it("同一稿的规则和手册提案收成一行，标题说清稿名、条数和要判断什么", () => {
    const rows = groupRows([rule("r1"), lesson("p1", "开头先亮名字"), rule("r2", { content_title: "喊一定没用" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("《喊一定没用》改稿攒下 3 条经验，要不要以后都照着写");
    expect(groupRows([item({ item_id: "rule:z", content_id: "c-x", detail: {} })])[0].title).toContain("《已删的稿》");
  });

  it("每条写出问题和补全的原话；不出孤零零的「A」", async () => {
    await render([rule("r1"), lesson("p1", "开头先亮名字")]);
    expect(el.textContent).toContain("以后每篇都这样写？");
    expect(el.textContent).toContain("以后《干货方法》都这样写？");
    expect(el.textContent).toContain("你选了 A：说人话版");
    expect(el.textContent).toContain("（选卡时的回复，原卡没记下）");
  });

  it("规则「要」带 eventId；双击同一个决定用同一个 eventId（服务端去重）", async () => {
    await render([rule("r1")]);
    await click("要");
    await click("要");
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ ruleId: "r1", decision: "active" });
    expect(rules[0].eventId).toBe(rules[1].eventId);
  });

  it("生效规则满了：按钮变「要，替换第 X 条」，带上要换掉的规则", async () => {
    await render([rule("r1", { active_rule_count: 12, active_rules: [{ id: "a1", rule: "旧一" }, { id: "a2", rule: "旧二" }] })]);
    expect(btn("要")).toBeUndefined();
    await click("要，替换第 1 条");
    expect(rules[0]).toMatchObject({ decision: "active", replaces: "a1" });
  });

  it("同一手册的几条：显示成一份改动，取消勾选的那条不要，一次交一批", async () => {
    await render([lesson("p1", "开头先亮名字"), lesson("p2", "结尾留金句")]);
    expect(el.textContent).toContain("这 2 条一起改成一个新版本");
    const boxes = el.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    await act(async () => { boxes[1].click(); });
    await click("要勾上的");
    expect(books).toEqual([expect.objectContaining({ op: "batch", id: "ganhuo", based_on: 1, items: [{ proposal_id: "p1", gen: "gen-p1", decision: "approve" }, { proposal_id: "p2", gen: "gen-p2", decision: "reject" }] })]);
  });

  it("手册已被别处改过：整组提示按新版重提", async () => {
    bookReply = { ok: false, error: "手册已经改过", body: { code: "stale" } };
    await render([lesson("p1", "开头先亮名字"), lesson("p2", "结尾留金句")]);
    await click("要勾上的");
    expect(el.textContent).toContain(STALE_NOTE);
  });

  it("组里都处理完：面板说这一组处理完了", async () => {
    await render([rule("r1")], true);
    expect(el.textContent).toContain("这一组都处理完了");
  });
});
