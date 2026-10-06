/**
 * 对话里拍板（spec 2026-10-06 chat-approval，修订：对话原话直接定，不弹窗）：保留下来的边界逐条验收。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { getContent } from "../../../storage/local-store.js";
import { readProductionDoc } from "../../../storage/production-store.js";
import { mutateProduction } from "../service.js";
import { readRequest, writeRequest } from "./requests.js";
import type { Decision } from "../../../storage/production-types.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { executeContentSave } from "../../../tools/content-save.js";
import { decide, decideItem } from "../inbox-decide.js";
import { founderDecision } from "../decisions.js";
import { readInbox } from "../inbox-read.js";
import { explainContent } from "../read.js";
import { founderApprove, makeEnv, png, put, record, videoContent, waiveSliverCheck, type Env } from "../testkit.js";
import { HUMAN_WRITE } from "../../../storage/first-body-guard.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); setPullDeps({ benchPort: 4317 }); });
afterEach(async () => { setPullDeps(null); await env.cleanup(); });

const TITLE = "对话拍板测试";
const tool = (p: Record<string, unknown>, host = "claude-code", session = "sess-1234567890") =>
  executeReviewInbox({ _dataDir: env.dir, _host: host, _session: session, ...p });
const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;
const decisions = async (id: string, type: Decision["type"]) => (await doc(id)).decisions.filter((d) => d.type === type);
const itemOf = async (type: string) => (await readInbox(env.dir)).items.find((i) => i.type === type)!;
const img = (n: string, w: number, h: number, seed = n) => put(path.join(env.chatcut, n), png(w, h, seed));
let rid = 0;
const nextId = () => `req-${++rid}`;

async function editing() {
  const c = await videoContent(env, TITLE);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${TITLE}-原片.mov`), "raw"), request_id: "a" });
  return c;
}
async function coverGroup(contentId: string, tag: string, text = "原来的字") {
  return record(env, { content_id: contentId, kind: "cover", paths: [await img(`${tag}-34.png`, 900, 1200), await img(`${tag}-43.png`, 1200, 900)], cover_text: text, request_id: `g-${tag}` });
}
async function cut(contentId: string) {
  const r = await record(env, { content_id: contentId, kind: "cut", path: await put(path.join(env.chatcut, `${TITLE}.mp4`), "cut-bytes"), request_id: "cut", review: true });
  const sha = (await doc(contentId)).facts.find((f) => f.id === r.fact_id)!.sha256!;
  await waiveSliverCheck(env, contentId, sha);
  return { fact_id: String(r.fact_id), sha };
}
async function candidate(contentId: string) {
  const r = await record(env, { content_id: contentId, kind: "cut", path: await put(path.join(env.outside, "外面的文件.mp4"), "cand-bytes"), request_id: "cand" });
  return String(r.fact_id);
}
const decideCover = async (extra: Record<string, unknown> = {}, host?: string) => {
  const it = await itemOf("cover_pick");
  return tool({ action: "decide", item_id: it.item_id, gen: it.gen, decision: "pick_cover", founder_words: "就用这组", request_id: nextId(), ...extra }, host);
};

describe("对话原话直接定（E2、E3、E15、两个宿主）", () => {
  it.each(["claude-code", "codex"])("%s 能记；决定带 source chat、原话、发起方；封面字服务端算一次原样提交", async (host) => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const text = "大字 <b>&\"引号\"";
    const r = await decideCover({ cover_text: `  ${text} ` }, host);
    expect(r).toMatchObject({ ok: true, recorded_as: "chat" });
    const [d] = await decisions(c.id, "cover_approval");
    expect(d).toMatchObject({ cover_text: text, source: "chat", founder_words: "就用这组", requested_by: `${host === "codex" ? "Codex" : "Claude"}（会话 sess-123）` });
  });

  it("不带封面字 → 用这组自己的字", async () => {
    const c = await editing();
    await coverGroup(c.id, "a", "组里的字");
    await decideCover();
    expect((await decisions(c.id, "cover_approval"))[0].cover_text).toBe("组里的字");
  });

  it("E5 原话必填；还要改要带 note；还要改记成 chat，看板标「对话里转述」", async () => {
    const c = await editing();
    const k = await cut(c.id);
    const it0 = await itemOf("cut_review");
    const base = { action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "reject_cut", request_id: nextId() };
    expect(await tool({ ...base, note: "开头太慢" })).toMatchObject({ ok: false, code: "founder_words_required" });
    expect(await tool({ ...base, founder_words: "开头拖" })).toMatchObject({ ok: false, code: "note_required" });
    expect(await tool({ ...base, founder_words: "开头拖", note: "开头 10 秒砍掉" })).toMatchObject({ ok: true });
    expect((await decisions(c.id, "cut_reject"))[0]).toMatchObject({ fact_id: k.fact_id, note: "开头 10 秒砍掉", source: "chat", founder_words: "开头拖" });
    const exp = await explainContent((await getContent(c.id, env.dir))!, env.dir);
    expect(exp.missing).toContain("（对话里转述）你说还要改：开头 10 秒砍掉");
  });

  it("候选：confirm / reject 都能定，选错的决定 → not_chat_decidable", async () => {
    const c = await editing();
    const fid = await candidate(c.id);
    const cand = await itemOf("candidate");
    expect(await tool({ action: "decide", item_id: cand.item_id, gen: cand.gen, decision: "approve_cut", founder_words: "x", request_id: nextId() })).toMatchObject({ code: "not_chat_decidable" });
    expect(await tool({ action: "decide", item_id: cand.item_id, gen: cand.gen, decision: "reject_candidate", founder_words: "不是这条的", request_id: nextId() })).toMatchObject({ ok: true });
    expect((await doc(c.id)).facts.find((f) => f.id === fid)!.state).toBe("rejected");
    expect((await decisions(c.id, "candidate_reject"))[0]).toMatchObject({ source: "chat", founder_words: "不是这条的" });
  });
});

describe("状态（E6–E8）", () => {
  it("E6 代次变了 → 拒并给新的样子，什么都不记", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const old = await itemOf("cover_pick");
    await coverGroup(c.id, "b");
    const r = await tool({ action: "decide", item_id: old.item_id, gen: old.gen, decision: "pick_cover", founder_words: "行", request_id: nextId() });
    expect(r).toMatchObject({ ok: false, code: "stale", item: { item_id: old.item_id } });
    expect(await decisions(c.id, "cover_approval")).toHaveLength(0);
  });

  it("多组没点名 → selector_required，不替他挑；点名了就定那一组", async () => {
    const c = await editing();
    const a = await coverGroup(c.id, "a");
    await coverGroup(c.id, "b");
    expect(await decideCover()).toMatchObject({ ok: false, code: "selector_required" });
    expect(await decideCover({ group_id: a.group_id })).toMatchObject({ ok: true, group_id: a.group_id });
  });

  it("E7 已在网页上定了 → 已在别处处理", async () => {
    const c = await editing();
    const g = await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    expect(await decide(c.id, "pick_cover", { group_id: g.group_id }, env.dir)).toMatchObject({ ok: true });
    const r = await tool({ action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: nextId() });
    expect(r).toMatchObject({ ok: false, code: "already_handled" });
    expect(String(r.error)).toContain("已在别处处理");
  });

  it("E8 同一 request_id 重试 → 同一结果；同号换内容 → request_conflict", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    const p = { action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: "same-1" };
    const first = await tool(p);
    expect(await tool(p)).toMatchObject({ ok: true, replayed: true, decision: { id: (first.decision as { id: string }).id } });
    expect(await tool({ ...p, cover_text: "别的字" })).toMatchObject({ ok: false, code: "request_conflict" });
    expect(await decisions(c.id, "cover_approval")).toHaveLength(1);
  });
});

describe("内容（E13）与成片路径", () => {
  it("E13 文件在列出之后被覆盖 → 拒，什么都不记", async () => {
    const c = await editing();
    const fid = await candidate(c.id);
    const cand = await itemOf("candidate");
    await put(path.join(env.outside, "外面的文件.mp4"), "changed-bytes");
    const r = await tool({ action: "decide", item_id: cand.item_id, gen: cand.gen, decision: "confirm_candidate", founder_words: "是", request_id: nextId() });
    expect(r).toMatchObject({ ok: false, code: "file_changed" });
    expect((await doc(c.id)).facts.find((f) => f.id === fid)!.state).toBe("candidate");
  });

  it("list 给成片的绝对路径；审片通过记 chat", async () => {
    const c = await editing();
    const k = await cut(c.id);
    const r = await tool({ action: "list" });
    const item = (r.items as Array<Record<string, unknown>>).find((i) => i.type === "cut_review")!;
    const v = (item.facts as { versions: Array<{ path: string }> }).versions[0];
    expect(path.isAbsolute(v.path)).toBe(true);
    expect(path.basename(v.path)).toBe(`${TITLE}.mp4`);
    const it0 = await itemOf("cut_review");
    expect(await tool({ action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "approve_cut", founder_words: "这版可以", request_id: nextId() })).toMatchObject({ ok: true });
    expect((await decisions(c.id, "cut_approval"))[0]).toMatchObject({ fact_id: k.fact_id, source: "chat", founder_words: "这版可以" });
  });

  it("list：能在对话里定的带事实与决定，别的只给看板链接", async () => {
    const c = await editing();
    await coverGroup(c.id, "a", "封面上的字");
    const r = await tool({ action: "list" });
    const item = (r.items as Array<Record<string, unknown>>).find((i) => i.type === "cover_pick")!;
    expect(item).toMatchObject({ chat_decidable: true, facts: { groups: [{ cover_text: "封面上的字", files: ["封面-3x4.png", "封面-4x3.png"] }] } });
    expect(String(item.board_link)).toBe(`http://127.0.0.1:4317/#/board?inbox=${encodeURIComponent(c.id)}&types=cover_pick`);
    expect((item.decisions as Array<{ decision: string }>).map((d) => d.decision)).toEqual(["pick_cover", "retire_cover_group", "reject_cover"]);
  });
});

describe("撤回与其它路径（E16）", () => {
  it("revoke：撤回刚才的批准，来源 chat；要带原话", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const r = await decideCover();
    const id = (r.decision as { id: string }).id;
    expect(await tool({ action: "revoke", content_id: c.id, decision_id: id, request_id: nextId() })).toMatchObject({ code: "founder_words_required" });
    expect(await tool({ action: "revoke", content_id: c.id, decision_id: id, founder_words: "撤回刚才那个", request_id: nextId() })).toMatchObject({ ok: true });
    expect((await decisions(c.id, "approval_revoke"))[0]).toMatchObject({ target_id: id, source: "chat", founder_words: "撤回刚才那个" });
    expect(await itemOf("cover_pick")).toBeDefined();
  });

  it("E16 网页决定照旧记 founder；模型直接调决定入口一律 founder_only", async () => {
    const c = await editing();
    const g = await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    expect(await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "pick_cover", content_id: c.id, _host: "claude-code" }, env.dir)).toMatchObject({ code: "founder_only" });
    expect(await founderDecision(c.id, "pick_cover", { group_id: g.group_id, _host: "codex" }, env.dir)).toMatchObject({ code: "founder_only" });
    expect(await decide(c.id, "pick_cover", { group_id: g.group_id }, env.dir)).toMatchObject({ ok: true });
    const [d] = await decisions(c.id, "cover_approval");
    expect(d.source).toBe("founder");
    expect(d.founder_words).toBeUndefined();
  });

  it("修订前的旧来源（chat-reported / chat-dialog）照旧读得出，看板照样标", async () => {
    const c = await editing();
    await cut(c.id);
    const it0 = await itemOf("cut_review");
    await tool({ action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "reject_cut", founder_words: "慢", note: "砍开头", request_id: nextId() });
    await mutateProduction(c.id, env.dir, (d) => {
      for (const x of d.decisions) if (x.type === "cut_reject") x.source = "chat-reported";
      return { value: null, events: [] };
    });
    const exp = await explainContent((await getContent(c.id, env.dir))!, env.dir);
    expect(exp.missing).toContain("（对话里转述）你说还要改：砍开头");
    const summary = await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, action: "summary", id: c.id }) as { rejections?: Array<{ source?: string }> };
    expect(summary.rejections?.[0]?.source).toBe("chat");
  });
});

describe("Codex 审 b44fff09 P2", () => {
  it("封面「还要改」与网页同一范围：多组时不要点名，打回所有还没定的组", async () => {
    const c = await editing();
    const a = await coverGroup(c.id, "a");
    const b = await coverGroup(c.id, "b");
    const it0 = await itemOf("cover_pick");
    const r = await tool({ action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "reject_cover", founder_words: "两组字都太小", note: "字放大", request_id: nextId() });
    expect(r).toMatchObject({ ok: true });
    expect([...((await decisions(c.id, "cover_reject"))[0].group_ids ?? [])].sort()).toEqual([String(a.group_id), String(b.group_id)].sort());
  });

  it("封面「还要改」核所有被打回组的文件：其中一组被覆盖 → file_changed", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    await coverGroup(c.id, "b");
    const it0 = await itemOf("cover_pick");
    const d = await doc(c.id);
    const g = (it0.detail.groups as Array<{ "3:4": { fact_id: string } }>)[1];
    const f = d.facts.find((x) => x.id === g["3:4"].fact_id)!;
    const { contentRoot } = await import("../../../storage/content-project.js");
    await put(path.isAbsolute(f.path!) ? f.path! : path.join(contentRoot(c.id, env.dir), f.path!), "overwritten");
    expect(await tool({ action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "reject_cover", founder_words: "改", note: "改", request_id: nextId() })).toMatchObject({ ok: false, code: "file_changed" });
  });

  it("P2-3（028c3e18）决定已写、消费记录没写就崩：重试按请求号从决定里找回", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    const p = { action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: "crash-log" };
    const first = await tool(p);
    await mutateProduction(c.id, env.dir, (d) => { d.inbox_log = (d.inbox_log ?? []).filter((e) => e.item_id !== it0.item_id); return { value: null, events: [] }; });
    const rec = (await readRequest(env.dir, "crash-log"))!;
    await writeRequest(env.dir, { ...rec, state: "pending", result: undefined });
    const again = await tool(p);
    expect(again).toMatchObject({ ok: true, replayed: true, decision: { id: (first.decision as { id: string }).id, request_id: "crash-log" } });
    expect(await decisions(c.id, "cover_approval")).toHaveLength(1);
  });

  it("决定已写、消费记录没写就崩（封面打回，代次不变）：找回时补上消费，条目消失，同一代别的决定被拒", async () => {
    const c = await editing();
    const g = await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    const p = { action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "reject_cover", founder_words: "字太小", note: "字放大", request_id: "crash-rej" };
    expect(await tool(p)).toMatchObject({ ok: true });
    await mutateProduction(c.id, env.dir, (d) => { d.inbox_log = (d.inbox_log ?? []).filter((e) => e.item_id !== it0.item_id); return { value: null, events: [] }; });
    expect((await itemOf("cover_pick"))?.gen).toBe(it0.gen);
    const rec = (await readRequest(env.dir, "crash-rej"))!;
    await writeRequest(env.dir, { ...rec, state: "pending", result: undefined });
    expect(await tool(p)).toMatchObject({ ok: true, replayed: true });
    expect(await itemOf("cover_pick")).toBeUndefined();
    expect(await decide(c.id, "pick_cover", { group_id: g.group_id, item_id: it0.item_id, gen: it0.gen }, env.dir)).toMatchObject({ ok: false });
    expect(await decisions(c.id, "cover_approval")).toHaveLength(0);
    expect(await decisions(c.id, "cover_reject")).toHaveLength(1);
  });

  it("P2-2 提交后、记结果前死掉：重试按请求号找回已提交的决定，不看当前列表", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    const p = { action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: "crash-1" };
    const first = await tool(p);
    const rec = (await readRequest(env.dir, "crash-1"))!;
    await writeRequest(env.dir, { ...rec, state: "pending", result: undefined });
    const again = await tool(p);
    expect(again).toMatchObject({ ok: true, replayed: true, decision: { id: (first.decision as { id: string }).id } });
    expect(await decisions(c.id, "cover_approval")).toHaveLength(1);
  });

  it("P2-2 失败的请求也留绑定：同号换内容 → request_conflict", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    expect(await tool({ action: "decide", item_id: it0.item_id, gen: "old-gen", decision: "pick_cover", founder_words: "行", request_id: "fail-1" })).toMatchObject({ ok: false, code: "stale" });
    expect(await tool({ action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: "fail-1" })).toMatchObject({ ok: false, code: "request_conflict" });
  });

  it("P2-3 「还要改」也核选中文件：成片被覆盖 → file_changed", async () => {
    const c = await editing();
    await cut(c.id);
    const it0 = await itemOf("cut_review");
    const list = await tool({ action: "list" });
    const v = ((list.items as Array<Record<string, unknown>>).find((i) => i.type === "cut_review")!.facts as { versions: Array<{ path: string }> }).versions[0];
    await put(v.path, "overwritten-cut");
    expect(await tool({ action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "reject_cut", founder_words: "慢", note: "砍开头", request_id: nextId() })).toMatchObject({ ok: false, code: "file_changed" });
    expect(await decisions(c.id, "cut_reject")).toHaveLength(0);
  });

  it("P2-5 两项都在对话里批完（D3）：「对话里定的」标签还在", async () => {
    const c = await editing();
    await cut(c.id);
    await coverGroup(c.id, "a");
    const ci = await itemOf("cut_review");
    await tool({ action: "decide", item_id: ci.item_id, gen: ci.gen, decision: "approve_cut", founder_words: "这版可以", request_id: nextId() });
    await decideCover();
    const exp = await explainContent((await getContent(c.id, env.dir))!, env.dir);
    expect(exp.badges).toEqual(expect.arrayContaining(["成片是对话里定的", "封面是对话里定的"]));
  });
});
