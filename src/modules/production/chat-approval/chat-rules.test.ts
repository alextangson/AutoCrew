/**
 * 写作规则在对话里批（docs/2026-10-10-chat-feedback-learning-spec.md §C）：边界 5、6、7、8、11（收件箱其他类型不变）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type http from "node:http";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { loadProfile, ruleStatus, decideWritingRule } from "../../profile/creator-profile.js";
import { addWritingRule, RULE_CAP } from "../../profile/writing-rules.js";
import { addApprovedRuleForTest } from "../../profile/rule-fixtures.js";
import { createRuleApprovalHandler } from "../../../desktop/rule-approval.js";
import { readInbox } from "../inbox-read.js";
import { proposePreference } from "../../publish/review-gate/preferences.js";
import { makeEnv, type Env } from "../testkit.js";
import { DELEGATION_PHRASES, isDelegation } from "./rule-decide.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); setPullDeps({ benchPort: 4317 }); });
afterEach(async () => { setPullDeps(null); await env.cleanup(); });

type Item = { item_id: string; gen: string; type: string; content_id: string | null; chat_decidable: boolean; brief: string; facts: Record<string, unknown>; decisions: Array<{ decision: string }> };
const tool = (p: Record<string, unknown>) => executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "sess-1234abcd", ...p });
let rid = 0;
const decide = (it: Item, decision: string, extra: Record<string, unknown> = {}) =>
  tool({ action: "decide", item_id: it.item_id, gen: it.gen, decision, founder_words: "1 要", request_id: `rq-${++rid}`, ...extra });
const ruleItems = async () => ((await tool({ action: "list" })).items as Item[]).filter((i) => i.type === "writing_rule");
const ruleById = async (id: string) => (await loadProfile(env.dir))!.writingRules.find((r) => r.id === id)!;

async function pending(rule: string, extra: Record<string, unknown> = {}) {
  const p = await addWritingRule({ rule, source: "user_explicit", confidence: 1, ...extra }, env.dir, { promote: false });
  return p.writingRules.find((r) => r.rule === rule)!;
}
async function fillActive(n: number) {
  for (let i = 0; i < n; i++) await addApprovedRuleForTest({ rule: `生效规则 ${i}`, source: "manual", confidence: 1 }, env.dir);
}

describe("writing_rule in chat", () => {
  it("待批规则以 writing_rule 出现在 list：可对话定，有 origin 的带 content_id，brief 带原话与冲突规则", async () => {
    await addApprovedRuleForTest({ rule: "开头先说结论", source: "manual", confidence: 1 }, env.dir);
    const old = (await loadProfile(env.dir))!.writingRules[0];
    const r = await pending("开头先抛问题", { origin: { content_id: "c-1234567890", version: 3, founder_words: "别一上来就下结论" }, conflictsWith: old.id });
    const [it] = await ruleItems();
    expect(it).toMatchObject({ item_id: `rule:${r.id}`, content_id: "c-1234567890", chat_decidable: true, facts: { rule: "开头先抛问题", founder_words: "别一上来就下结论", conflicts_with: { id: old.id, rule: "开头先说结论" }, active_rule_count: 1, rule_cap: RULE_CAP } });
    expect(it.decisions.map((d) => d.decision)).toEqual(["approve_rule", "reject_rule", "replace_rule"]);
    expect(it.brief).toContain("别一上来就下结论");
    expect(it.brief).toContain("开头先说结论");
    const noOrigin = await pending("少用术语");
    expect((await ruleItems()).find((i) => i.item_id === `rule:${noOrigin.id}`)).toMatchObject({ content_id: null, chat_decidable: true });
  });

  it("approve_rule：生效，ruleDecisions 记 chat 来源、原话、发起方、请求号", async () => {
    const r = await pending("口语化");
    const [it] = await ruleItems();
    const res = await decide(it, "approve_rule", { founder_words: "1 要", request_id: "rq-approve-1" });
    expect(res).toMatchObject({ ok: true, recorded_as: "chat" });
    const p = (await loadProfile(env.dir))!;
    expect(ruleStatus(p.writingRules.find((x) => x.id === r.id)!)).toBe("active");
    expect(p.ruleDecisions!.at(-1)).toMatchObject({ ruleId: r.id, decision: "active", eventId: "chat-rq-approve-1", source: "chat", founder_words: "1 要", request_id: "rq-approve-1", requested_by: expect.stringContaining("sess-123") });
  });

  it("边界 5：「你定 / 都行」类回答不算批准", async () => {
    await pending("口语化");
    const [it] = await ruleItems();
    for (const w of ["你定", "你看着办吧", "都行。", "随便"]) {
      expect(await decide(it, "approve_rule", { founder_words: w })).toMatchObject({ ok: false, code: "founder_words_not_approval" });
    }
    expect(isDelegation("1 要，2 不要")).toBe(false);
    expect((await ruleItems())).toHaveLength(1);
  });

  it("边界 6：同一请求重发只生效一次；网页先批 → 对话后到说已处理", async () => {
    const r = await pending("口语化");
    const [it] = await ruleItems();
    const first = await decide(it, "approve_rule", { request_id: "rq-same" });
    const again = await decide(it, "approve_rule", { request_id: "rq-same" });
    expect(first.ok).toBe(true);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect((await loadProfile(env.dir))!.ruleDecisions!.filter((d) => d.ruleId === r.id)).toHaveLength(1);

    const r2 = await pending("少用术语");
    const it2 = (await ruleItems()).find((i) => i.item_id === `rule:${r2.id}`)!;
    await decideWritingRule({ ruleId: r2.id!, revision: r2.revision!, decision: "active", eventId: "web-evt-123" }, env.dir);
    expect(await decide(it2, "approve_rule")).toMatchObject({ ok: false, code: "already_handled" });
    expect((await loadProfile(env.dir))!.ruleDecisions!.filter((d) => d.ruleId === r2.id)).toHaveLength(1);
  });

  it("边界 7：reject_rule 留墓碑，同一句再提被挡", async () => {
    const r = await pending("结尾都要短");
    const [it] = await ruleItems();
    expect(await decide(it, "reject_rule", { founder_words: "不要，那只是这篇" })).toMatchObject({ ok: true });
    expect(ruleStatus(await ruleById(r.id!))).toBe("rejected");
    expect((await addWritingRule({ rule: "结尾都要短", source: "user_explicit", confidence: 1 }, env.dir)).lastRuleOutcome).toBe("blocked_by_tombstone");
  });

  it("边界 8：满 12 条只能替换；replace 一次写入新生效 + 旧停用（disabledReason）", async () => {
    await fillActive(RULE_CAP);
    const r = await pending("开头先抛问题");
    const [it] = await ruleItems();
    const capped = await decide(it, "approve_rule");
    expect(capped).toMatchObject({ ok: false, code: "rule_cap_reached", rule_cap: RULE_CAP });
    expect((capped.active as unknown[]).length).toBe(RULE_CAP);
    expect(ruleStatus(await ruleById(r.id!))).toBe("pending");
    expect(await decide(it, "replace_rule")).toMatchObject({ ok: false, code: "selector_required" });
    const target = (await loadProfile(env.dir))!.writingRules.find((x) => x.rule === "生效规则 0")!;
    expect(await decide(it, "replace_rule", { target_rule_id: target.id, founder_words: "要，替换第 1 条" })).toMatchObject({ ok: true });
    const p = (await loadProfile(env.dir))!;
    expect(ruleStatus(p.writingRules.find((x) => x.id === r.id)!)).toBe("active");
    expect(p.writingRules.find((x) => x.id === target.id)).toMatchObject({ status: "disabled", disabledReason: `被 ${r.id} 替换` });
    expect(p.writingRules.filter((x) => ruleStatus(x) === "active")).toHaveLength(RULE_CAP);
  });

  it("边界 8：工作台 /api/rules/decision 同样受上限约束，回 code 给页面显示人话", async () => {
    await fillActive(RULE_CAP);
    const r = await pending("开头先抛问题");
    const handler = createRuleApprovalHandler({ authorize: () => "session", originAllowed: () => true, resolveDataDir: async () => env.dir,
      readBody: async () => JSON.stringify({ ruleId: r.id, revision: r.revision, decision: "active", eventId: "web-evt-cap-1" }) });
    let status = 0, body = "";
    const res = { writeHead(s: number) { status = s; return this; }, end(b: string) { body = b; } } as unknown as http.ServerResponse;
    const req = { method: "POST", headers: { "content-type": "application/json" } } as unknown as http.IncomingMessage;
    await handler(req, res, new URL("http://127.0.0.1/api/rules/decision"));
    expect(status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({ ok: false, code: "rule_cap_reached", rule_cap: RULE_CAP });
    expect(ruleStatus(await ruleById(r.id!))).toBe("pending");
  });

  it("边界 11：发布偏好提案仍是 other、对话里定不了", async () => {
    expect((await proposePreference({ kind: "rule", value: "B 站只传 4:3", founder_quote: "B站只要横版" }, "claude-code", env.dir)).ok).toBe(true);
    await pending("口语化");
    const all = (await readInbox(env.dir)).items;
    const pref = all.find((i) => i.item_id.startsWith("pref:"))!;
    expect(pref.type).toBe("other");
    expect(all.find((i) => i.item_id.startsWith("rule:"))!.type).toBe("writing_rule");
    const listed = ((await tool({ action: "list" })).items as Item[]).find((i) => i.item_id === pref.item_id)!;
    expect(listed.chat_decidable).toBe(false);
    expect(await tool({ action: "decide", item_id: pref.item_id, gen: pref.gen, decision: "approve_rule", founder_words: "要", request_id: "rq-pref" })).toMatchObject({ ok: false, code: "not_chat_decidable" });
  });

  it("Codex P2：词表里每个授权式说法加常见语气词 / 标点都不算批准（含「听你的」）", () => {
    for (const d of DELEGATION_PHRASES) for (const tail of ["", "的", "吧", "啊", "。", "的吧", "！"]) expect(isDelegation(d + tail), d + tail).toBe(true);
    expect(isDelegation("听你的")).toBe(true);
    expect(isDelegation("1、3 要")).toBe(false);
  });

  it("Codex P2：档案已写、请求结果没存（崩溃）→ 同一 request_id 重试回放成功，不报已处理", async () => {
    const r = await pending("口语化");
    const [it] = await ruleItems();
    // 模拟崩溃：决定已进档案（同一 chat-<request_id> 事件），但请求记录没落结果
    await decideWritingRule({ ruleId: r.id!, revision: r.revision!, decision: "active", eventId: "chat-rq-crash" }, env.dir);
    const res = await decide(it, "approve_rule", { request_id: "rq-crash" });
    expect(res).toMatchObject({ ok: true, replayed: true, rule_id: r.id, decision: "approve_rule" });
  });
});
