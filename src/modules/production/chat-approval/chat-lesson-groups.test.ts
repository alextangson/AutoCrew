/**
 * 「等你拍板」看得懂（spec 2026-10-15 §A）：按稿分组 + 编号「组-条」、每条写出问题、选项代号补全、同手册合并批。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { decideProposal, proposeLesson } from "../../playbook/changes.js";
import { decideLessonBatch } from "../../playbook/batch.js";
import { loadManifest, readVersionText } from "../../playbook/store.js";
import { addWritingRule } from "../../profile/writing-rules.js";
import { saveContent } from "../../../storage/local-store.js";
import { parseFeedback } from "../../draft/draft-feedback.js";
import { readInbox } from "../inbox-read.js";
import { makeEnv, type Env } from "../testkit.js";
import { isOptionCode, UNRECORDED_CARD, wordsLine } from "../lesson-view.js";
import type http from "node:http";
import { createPlaybookHandler } from "../../../desktop/playbook-route.js";
import { createRuleApprovalHandler } from "../../../desktop/rule-approval.js";
import { addApprovedRuleForTest } from "../../profile/rule-fixtures.js";
import { loadProfile, ruleStatus } from "../../profile/creator-profile.js";
import { RULE_CAP } from "../../profile/writing-rules.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>;
async function post(make: (body: string) => Handler, pathName: string, body: unknown) {
  let status = 0, out = "";
  const res = { writeHead(s: number) { status = s; return this; }, end(b: string) { out = b; } } as unknown as http.ServerResponse;
  const req = { method: "POST", headers: { "content-type": "application/json" } } as unknown as http.IncomingMessage;
  await make(JSON.stringify(body))(req, res, new URL(`http://127.0.0.1${pathName}`));
  return { status, body: JSON.parse(out) as Record<string, unknown> };
}
const deps = (b: string) => ({ authorize: () => "session" as const, originAllowed: () => true, readBody: async () => b, resolveDataDir: async () => env.dir });

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); setPullDeps({ benchPort: 4317 }); });
afterEach(async () => { setPullDeps(null); await env.cleanup(); });

type Item = { item_id: string; gen: string; type: string; number?: string | number; brief: string; merge_key?: string };
const tool = (p: Record<string, unknown>) => executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "sess-1234abcd", ...p });
const list = async () => tool({ action: "list" }) as Promise<{ items: Item[]; groups?: Array<{ number: number; title: string; item_ids: string[] }> }>;
const lessons = (cid: string, ...rules: string[]) => Promise.all(rules.map((l) => proposeLesson({ id: "ganhuo", lesson: l, founder_words: "早点出名字", origin: { content_id: cid, version: 2 } }, env.dir)));

describe("原话与问题（一处定义）", () => {
  it("选项代号：带了内容显示「你选了 A：…」，没带显示固定说明，不出孤零零的 A", () => {
    expect(["A", "b", "2", "第3个", "第 三 个", "A。"].every(isOptionCode)).toBe(true);
    expect(isOptionCode("A 方案好")).toBe(false);
    expect(wordsLine("A", "开头先讲故事")).toBe("你选了 A：开头先讲故事");
    expect(wordsLine("A", null)).toBe(UNRECORDED_CARD);
    expect(wordsLine("别装", null)).toBe("「别装」");
  });

  it("save 的 feedback：原话只是代号又没带选项内容 → 拒；带了就存下", () => {
    expect(parseFeedback({ founder_words: "A", lessons: [] })).toMatch(/chosen_option/);
    expect(parseFeedback({ founder_words: "A", chosen_option: "开头先讲故事" })).toMatchObject({ chosen_option: "开头先讲故事" });
  });
});

describe("按稿分组（对话）", () => {
  it("同一稿的规则 + 手册提案收成一组：组标题带稿名和条数，组内编号 g-k，brief 写出问题和补全的原话", async () => {
    const c = await saveContent({ title: "喊一定没用", body: "", platform: "douyin", status: "drafting", tags: [] }, env.dir);
    await addWritingRule({ rule: "少用术语", source: "user_explicit", confidence: 1, origin: { content_id: c.id, version: 2, founder_words: "A", chosen_option: "说人话版" } }, env.dir, { promote: false });
    await addWritingRule({ rule: "结尾给步骤", source: "user_explicit", confidence: 1, origin: { content_id: c.id, version: 2, founder_words: "2" } }, env.dir, { promote: false });
    await lessons(c.id, "开头先亮名字");
    const r = await list();
    expect(r.groups).toEqual([expect.objectContaining({ number: 1, title: "《喊一定没用》改稿攒下 3 条经验，要不要以后都照着写" })]);
    expect(r.items.map((i) => i.number)).toEqual(["1-1", "1-2", "1-3"]);
    expect(r.items[0].brief.startsWith("1. 《喊一定没用》改稿攒下 3 条经验")).toBe(true);
    expect(r.items.find((i) => i.brief.includes("少用术语"))!.brief).toContain("你选了 A：说人话版");
    expect(r.items.find((i) => i.brief.includes("结尾给步骤"))!.brief).toContain(UNRECORDED_CARD);
    expect(r.items.find((i) => i.type === "writing_rule")!.brief).toContain("要你判断：以后每篇都这样写？");
    expect(r.items.find((i) => i.type === "playbook_change")!.brief).toContain("要你判断：以后《干货方法》都这样写？");
  });

  it("稿件取不到：组照样显示「已删的稿」，条目照常能定", async () => {
    await lessons("content-gone-1", "开头先亮名字");
    const r = await list();
    expect(r.groups?.[0].title).toContain("《已删的稿》");
    const [it] = r.items;
    expect(await tool({ action: "decide", item_id: it.item_id, gen: it.gen, decision: "reject_playbook", founder_words: "不要", request_id: "rq-del" })).toMatchObject({ ok: true });
  });
});

describe("同一手册的几条合并批", () => {
  it("单条批准还有兄弟 → use_batch；合并批：要的两条进同一个新版本、不要的否决，没有作废", async () => {
    await lessons("c-1", "开头先亮名字", "结尾留金句", "别用术语");
    const items = (await list()).items;
    expect(new Set(items.map((i) => i.merge_key))).toEqual(new Set(["ganhuo@1"]));
    expect(await tool({ action: "decide", item_id: items[0].item_id, gen: items[0].gen, decision: "approve_playbook", founder_words: "1-1 要", request_id: "rq-1" })).toMatchObject({ ok: false, code: "use_batch" });
    const partial = [{ item_id: items[0].item_id, gen: items[0].gen, decision: "approve_playbook" }];
    expect(await tool({ action: "decide", decision: "playbook_batch", items: JSON.stringify(partial), founder_words: "1-1 要", request_id: "rq-2" })).toMatchObject({ ok: false, code: "incomplete_batch" });
    const all = items.map((i) => ({ item_id: i.item_id, gen: i.gen, decision: i.brief.includes("改后：- 别用术语") ? "reject_playbook" : "approve_playbook" }));
    const r = await tool({ action: "decide", decision: "playbook_batch", items: JSON.stringify(all), founder_words: "1-1、1-2 要，其余不要", request_id: "rq-3" });
    expect(r).toMatchObject({ ok: true, version: 2 });
    expect(await tool({ action: "decide", decision: "playbook_batch", items: all, founder_words: "1-1、1-2 要，其余不要", request_id: "rq-3" })).toMatchObject({ ok: true, replayed: true });
    const text = await readVersionText("ganhuo", 2, env.dir);
    expect(text).toContain("开头先亮名字");
    expect(text).toContain("结尾留金句");
    expect(text).not.toContain("别用术语");
    const statuses = (await loadManifest(env.dir)).playbooks.find((p) => p.id === "ganhuo")!.proposals.map((p) => p.status).sort();
    expect(statuses).toEqual(["approved", "approved", "rejected"]);
    expect((await list()).items).toHaveLength(0);
  });

  it("手册已被别处改过：整组 stale，手册内容不变，提示按新版重提", async () => {
    await lessons("c-1", "开头先亮名字", "结尾留金句");
    await proposeLesson({ id: "ganhuo", lesson: "别处的意见", founder_words: "y", origin: { content_id: "c-2", version: 1 } }, env.dir);
    const m = await loadManifest(env.dir);
    const other = m.playbooks.find((p) => p.id === "ganhuo")!.proposals.find((p) => p.lesson === "别处的意见")!;
    await decideProposal({ id: "ganhuo", proposal_id: other.id, gen: other.gen, decision: "approve", eventId: "ev-other", source: "workbench" }, env.dir);
    const before = (await loadManifest(env.dir)).playbooks.find((p) => p.id === "ganhuo")!;
    const mine = before.proposals.filter((p) => p.origin?.content_id === "c-1");
    await expect(decideLessonBatch({ id: "ganhuo", based_on: 1, items: mine.map((p) => ({ proposal_id: p.id, gen: p.gen, decision: "approve" as const })), eventId: "ev-b", source: "workbench" }, env.dir))
      .rejects.toMatchObject({ code: "stale" });
    expect(before.current).toBe(2);
    expect((await loadManifest(env.dir)).playbooks.find((p) => p.id === "ganhuo")!.current).toBe(2);
  });

  it("对话里合并批时这几条已因手册改过而过期（不在收件箱了）：回 stale 整组提示，不说「已在别处处理」", async () => {
    await lessons("c-1", "开头先亮名字", "结尾留金句");
    const items = (await list()).items;
    await proposeLesson({ id: "ganhuo", lesson: "别处的意见", founder_words: "早点出名字", origin: { content_id: "c-2", version: 1 } }, env.dir);
    const other = (await loadManifest(env.dir)).playbooks.find((p) => p.id === "ganhuo")!.proposals.find((p) => p.lesson === "别处的意见")!;
    await decideProposal({ id: "ganhuo", proposal_id: other.id, gen: other.gen, decision: "approve", eventId: "ev-other-2", source: "workbench" }, env.dir);
    const all = items.map((i) => ({ item_id: i.item_id, gen: i.gen, decision: "approve_playbook" }));
    expect(await tool({ action: "decide", decision: "playbook_batch", items: all, founder_words: "都要", request_id: "rq-stale" }))
      .toMatchObject({ ok: false, code: "stale", error: expect.stringContaining("按新版重提") });
  });

  it("看板读到的条目带问题、原话、稿名与 merge_key（面板直接用）", async () => {
    await lessons("c-9", "开头先亮名字");
    const [it] = (await readInbox(env.dir)).items;
    expect(it.detail).toMatchObject({ question: "以后《干货方法》都这样写？", words_text: "「早点出名字」", content_title: "已删的稿", merge_key: "ganhuo@1", kind: "lesson" });
  });
});

describe("工作台面板的两条路", () => {
  it("手册合并批：一次一个新版本；同一 event_id 重放不再出版本", async () => {
    await lessons("c-1", "开头先亮名字", "结尾留金句");
    const e = (await loadManifest(env.dir)).playbooks.find((p) => p.id === "ganhuo")!;
    const body = { op: "batch", id: "ganhuo", based_on: 1, event_id: "evt-batch-0001", items: e.proposals.map((p) => ({ proposal_id: p.id, gen: p.gen, decision: "approve" })) };
    expect(await post((b) => createPlaybookHandler(deps(b)), "/api/playbooks", body)).toMatchObject({ status: 200, body: { ok: true, version: 2 } });
    expect(await post((b) => createPlaybookHandler(deps(b)), "/api/playbooks", body)).toMatchObject({ status: 200, body: { ok: true, replayed: true } });
    expect((await loadManifest(env.dir)).playbooks.find((p) => p.id === "ganhuo")!.versions).toHaveLength(2);
  });

  it("规则满 12 条：「要，替换第 X 条」带 replaces 生效，旧的停用；不带照样拒", async () => {
    for (let i = 0; i < RULE_CAP; i++) await addApprovedRuleForTest({ rule: `生效规则 ${i}`, source: "manual", confidence: 1 }, env.dir);
    const p = await addWritingRule({ rule: "第十三条", source: "user_explicit", confidence: 1 }, env.dir, { promote: false });
    const r = p.writingRules.find((x) => x.rule === "第十三条")!;
    const old = p.writingRules.find((x) => x.rule === "生效规则 3")!;
    const base = { ruleId: r.id, revision: r.revision, decision: "active" };
    expect((await post((b) => createRuleApprovalHandler(deps(b)), "/api/rules/decision", { ...base, eventId: "web-cap-0001" })).body).toMatchObject({ code: "rule_cap_reached" });
    expect((await post((b) => createRuleApprovalHandler(deps(b)), "/api/rules/decision", { ...base, eventId: "web-cap-0002", replaces: old.id })).status).toBe(200);
    const after = (await loadProfile(env.dir))!.writingRules;
    expect(ruleStatus(after.find((x) => x.id === r.id)!)).toBe("active");
    expect(ruleStatus(after.find((x) => x.id === old.id)!)).toBe("disabled");
  });
});
