/**
 * 手册改动在对话里批 + 工作台路由（spec 2026-10-13 §3、§5、§9.5–9.7）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type http from "node:http";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { decideProposal, proposeLesson } from "../../playbook/changes.js";
import { loadManifest } from "../../playbook/store.js";
import { createPlaybookHandler } from "../../../desktop/playbook-route.js";
import { addWritingRule } from "../../profile/writing-rules.js";
import { makeEnv, type Env } from "../testkit.js";
import { boardLink } from "./view.js";
import type { InboxItem } from "../inbox.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); setPullDeps({ benchPort: 4317 }); });
afterEach(async () => { setPullDeps(null); await env.cleanup(); });

type Item = { item_id: string; gen: string; type: string; content_id: string | null; chat_decidable: boolean; brief: string; facts: Record<string, unknown>; decisions: Array<{ decision: string }>; board_link: string };
const tool = (p: Record<string, unknown>) => executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "sess-1234abcd", ...p });
const items = async (extra: Record<string, unknown> = {}) => ((await tool({ action: "list", ...extra })).items as Item[]).filter((i) => i.type === "playbook_change");
const decide = (it: Item, decision: string, request_id: string, founder_words = "批") => tool({ action: "decide", item_id: it.item_id, gen: it.gen, decision, founder_words, request_id });
const current = async () => (await loadManifest(env.dir)).playbooks.find((p) => p.id === "ganhuo")!;

describe("playbook_change 在对话里", () => {
  it("列出来：可对话定，brief 有改前改后与原话；list{content_id} 能列出来源是这篇稿的库级条目（含 writing_rule）", async () => {
    await proposeLesson({ id: "ganhuo", lesson: "开头先亮名字", founder_words: "名字要早点出", origin: { content_id: "c-777", version: 2 } }, env.dir);
    await addWritingRule({ rule: "少用术语", source: "user_explicit", confidence: 1, origin: { content_id: "c-777", version: 2, founder_words: "别装" } }, env.dir, { promote: false });
    const [it] = await items();
    expect(it).toMatchObject({ content_id: "c-777", chat_decidable: true, board_link: "http://127.0.0.1:4317/#/playbooks", facts: { playbook: "ganhuo", based_on: 1 } });
    expect(it.decisions.map((d) => d.decision)).toEqual(["approve_playbook", "reject_playbook"]);
    expect(it.brief).toContain("改后：- 开头先亮名字（创始人原话：「名字要早点出」）");
    expect(it.brief).toContain("名字要早点出");
    const scoped = ((await tool({ action: "list", content_id: "c-777" })).items as Item[]).map((i) => i.type).sort();
    expect(scoped).toEqual(["playbook_change", "writing_rule"]);
  });

  it("批：生成新版本；同一 request 重试重放；同号换内容 → request_conflict；换号再批 → already_handled", async () => {
    await proposeLesson({ id: "ganhuo", lesson: "开头先亮名字", founder_words: "x" }, env.dir);
    const [it] = await items();
    expect(await decide(it, "approve_playbook", "rq-1")).toMatchObject({ ok: true, version: 2, recorded_as: "chat" });
    expect(await decide(it, "approve_playbook", "rq-1")).toMatchObject({ ok: true, replayed: true, version: 2 });
    expect(await decide(it, "reject_playbook", "rq-1")).toMatchObject({ ok: false, code: "request_conflict" });
    expect(await decide(it, "approve_playbook", "rq-2")).toMatchObject({ ok: false, code: "already_handled" });
    expect((await current()).versions).toHaveLength(2);
    expect((await loadManifest(env.dir)).events).toEqual([expect.objectContaining({ eventId: "chat-rq-1", source: "chat", founder_words: "批", requested_by: expect.stringContaining("sess-123") })]);
  });

  it("崩在 manifest 已提交、请求结果没落盘之间：重试回原来的成功，不是 already_handled", async () => {
    await proposeLesson({ id: "ganhuo", lesson: "开头先亮名字", founder_words: "x" }, env.dir);
    const [it] = await items();
    const p = (await current()).proposals[0];
    await decideProposal({ id: "ganhuo", proposal_id: p.id, gen: p.gen, decision: "approve", eventId: "chat-rq-crash", source: "chat" }, env.dir);
    expect(await decide(it, "approve_playbook", "rq-crash")).toMatchObject({ ok: true, version: 2, replayed: true });
    expect((await current()).versions).toHaveLength(2);
  });

  it("过期提案：手册已升级 → stale，手册不变；「你定」不算批准", async () => {
    await proposeLesson({ id: "ganhuo", lesson: "甲", founder_words: "x" }, env.dir);
    await proposeLesson({ id: "ganhuo", lesson: "乙", founder_words: "y" }, env.dir);
    const [a, b] = await items();
    expect(await decide(a, "approve_playbook", "rq-d", "你定")).toMatchObject({ ok: false, code: "founder_words_not_approval" });
    await decide(a, "approve_playbook", "rq-a");
    expect(await decide(b, "approve_playbook", "rq-b")).toMatchObject({ ok: false, code: "stale" });
    expect((await current()).current).toBe(2);
  });

  it("writing_rule 的看板链接指向品牌校准页，不是灵感收件箱", () => {
    expect(boardLink({ type: "writing_rule", item_id: "rule:x", content_id: null } as InboxItem)).toBe("http://127.0.0.1:4317/#/calibration");
  });
});

describe("工作台路由 /api/playbooks", () => {
  function call(method: string, pathName: string, body: unknown, auth: "session" | "bearer" = "session") {
    const handler = createPlaybookHandler({ authorize: () => auth, originAllowed: () => true, readBody: async () => JSON.stringify(body), resolveDataDir: async () => env.dir });
    let status = 0; let out = "";
    const res = { writeHead: (s: number) => { status = s; return res; }, end: (b: string) => { out = b; } } as unknown as http.ServerResponse;
    const req = { method, headers: { "content-type": "application/json" } } as http.IncomingMessage;
    return handler(req, res, new URL(`http://x${pathName}`)).then(() => ({ status, body: JSON.parse(out) as Record<string, unknown> }));
  }

  it("只认浏览器会话；读出列表、统计、提案对比；批准与回滚走同一套逻辑", async () => {
    expect((await call("GET", "/api/playbooks", null, "bearer")).status).toBe(403);
    await proposeLesson({ id: "ganhuo", lesson: "甲", founder_words: "x" }, env.dir);
    const got = await call("GET", "/api/playbooks", null);
    const book = (got.body.playbooks as Array<{ id: string; proposals: Array<{ id: string; gen: string; diff: unknown[] }> }>).find((p) => p.id === "ganhuo")!;
    expect(book.proposals[0].diff).toHaveLength(1);
    expect(got.body.stats).toMatchObject({ unattributed: 0 });
    const ok = await call("POST", "/api/playbooks", { op: "approve", id: "ganhuo", proposal_id: book.proposals[0].id, gen: book.proposals[0].gen, event_id: "evt-12345678" });
    expect(ok.body).toMatchObject({ ok: true, version: 2 });
    const v1 = await call("GET", "/api/playbooks/version?id=ganhuo&version=1", null);
    expect(v1.body).toMatchObject({ ok: true, current: 2, diff: [expect.objectContaining({ before: [] })] });
    expect((await call("POST", "/api/playbooks", { op: "rollback", id: "ganhuo", to_version: 1, expected_current_version: 1, request_id: "req-12345678" })).body).toMatchObject({ ok: false, code: "stale" });
    expect((await call("POST", "/api/playbooks", { op: "rollback", id: "ganhuo", to_version: 1, expected_current_version: 2, request_id: "req-12345678" })).body).toMatchObject({ ok: true, version: 3 });
    expect((await current()).versions.at(-1)).toMatchObject({ kind: "rollback", founder_words: "工作台点了「回滚到第 1 版」" });
  });
});
