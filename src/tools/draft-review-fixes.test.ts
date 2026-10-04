/** Codex 复审（04ab362d..HEAD）逐条回归：每条先复现原 bug，再锁住修法 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "./draft.js";
import { setDraftFetch } from "../modules/draft/draft-research.js";
import { resetDraftTokens } from "../modules/draft/draft-claims.js";
import { resetReviewQueue, reviewsIdle, setCodexRunner } from "../modules/draft/codex-review-queue.js";
import { buildIpcHandlers } from "../desktop/ipc.js";
import { getContent, transitionStatus, updateContent } from "../storage/local-store.js";
import { draftHash } from "../storage/draft-hash.js";
import { readProductionDoc, scriptApprovalFor } from "../storage/production-store.js";
import { acceptanceBlock } from "../modules/video/handoff/acceptance.js";

let dir: string;
const PAGE = "研究显示，参与调查的 1200 名职场人里，有 37% 每天用 AI 写周报。";
const BODY = "你是不是也觉得用了 AI 以后反而更忙了？省下来的时间，被你自己又填满了。可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的那段时间写进日历，标成不许约会。";
const ANGLE = { main_line: "AI 省下的时间会被你自己填满", for_whom: "职场人", opening: "你是不是也觉得更忙了？", why_viral: "同题材播放第一", chain: ["一", "二", "三", "四"], founder_words: "就这个" };
const call = (action: string, args: Record<string, unknown>, extra: Record<string, unknown> = { _host: "claude-code", _session: "s1" }) =>
  executeDraft({ action, ...args, _dataDir: dir, ...extra });
const as = (host: string | undefined, session: string | undefined) => ({ ...(host ? { _host: host } : {}), ...(session ? { _session: session } : {}) });

async function fresh(extra = as("claude-code", "s1")): Promise<string> {
  const r = await call("start", { inspiration: "AI 越用越忙" }, extra);
  return r.content_id as string;
}
async function idle(id: string, minutes = 11): Promise<void> {
  const c = (await getContent(id, dir))!;
  const at = new Date(Date.now() - minutes * 60_000).toISOString();
  await updateContent(id, { claim: { ...c.claim!, lastWriteAt: at, at } }, dir);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-fixes-"));
  resetDraftTokens(); resetReviewQueue();
  setCodexRunner(async () => ({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }));
  setDraftFetch(async (url) => ({ finalUrl: url, text: PAGE, imageCandidates: [] }));
});
afterEach(async () => { await reviewsIdle(); setDraftFetch(undefined); setCodexRunner(null); await fs.rm(dir, { recursive: true, force: true }); });

describe("P1 撤回之后交接不再认「定了」", () => {
  it("定了 → 创始人拉回写稿段：draftFinal 清掉，认稿决定已撤回，交接拒", async () => {
    const id = await fresh();
    await call("angle", { content_id: id, ...ANGLE });
    await call("save", { content_id: id, body: BODY });
    await call("prepare_final", { content_id: id, citations: [] });
    expect(await buildIpcHandlers()["draft:finalize"]({ id, draft_hash: draftHash((await getContent(id, dir))!), _dataDir: dir }, { authMethod: "session" })).toMatchObject({ ok: true });
    expect((await transitionStatus(id, "draft_ready", { decidedBy: "founder", force: true }, dir)).ok).toBe(true);
    const c = (await getContent(id, dir))!;
    expect(c.draftFinal).toBeUndefined();
    const doc = await readProductionDoc(id, dir);
    const approved = Boolean(doc && scriptApprovalFor(doc, c.body));
    expect(approved).toBe(false);
    // 即使 draftFinal 残留（老数据），认稿决定已撤回 → 交接照样拒
    const stale = { ...c, draftFinal: { draftHash: draftHash(c), finalizedAt: "x", source: "founder-workbench" as const, kept: [] } };
    expect(acceptanceBlock(stale, undefined, undefined, approved)).toMatchObject({ ok: false, code: "not_accepted" });
  });
});

describe("P1 认领与写入同一把锁", () => {
  it.each(["save", "angle", "cite"])("两个会话同时 %s 一篇没人认领的稿：只有一个成", async (action) => {
    const owner = await fresh();
    await call("angle", { content_id: owner, ...ANGLE });
    await call("save", { content_id: owner, body: BODY });
    await call("read", { content_id: owner, url: "https://example.com/r" });
    // 放掉认领，模拟「没人认领」
    await updateContent(owner, { claim: undefined }, dir);
    const args: Record<string, Record<string, unknown>> = {
      save: { body: BODY }, angle: ANGLE, cite: { page_id: "p1", quote: "有 37% 每天用 AI 写周报" }, prepare_final: { citations: [] },
    };
    const [a, b] = await Promise.all([
      call(action, { content_id: owner, ...args[action] }, as("claude-code", "sa")),
      call(action, { content_id: owner, ...args[action] }, as("claude-code", "sb")),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: "claim_held" });
  });
});

describe("P1 prepare_final 不和别的写入交错", () => {
  it("另一个会话同时 save：要么被拒，要么排在定稿清单之后（稿回到写作中、清单作废）", async () => {
    const id = await fresh();
    await call("angle", { content_id: id, ...ANGLE });
    await call("save", { content_id: id, body: BODY });
    await updateContent(id, { claim: undefined }, dir);
    const [prep, save] = await Promise.all([
      call("prepare_final", { content_id: id, citations: [] }, as("claude-code", "sa")),
      call("save", { content_id: id, body: `${BODY}另一个会话的。` }, as("claude-code", "sb")),
    ]);
    expect(prep.ok).toBe(true);
    const c = (await getContent(id, dir))!;
    if (save.ok) expect(c.status).toBe("drafting");
    else expect(save).toMatchObject({ code: "claim_held" });
  });
});

describe("P1 没有会话头的调用不共享令牌", () => {
  it("unknown 会话：第一次写交还 claim_token；另一个 unknown 调用不带它就被拒，带上才算同一写入方", async () => {
    const id = await fresh(as("claude-code", undefined));
    const first = await call("angle", { content_id: id, ...ANGLE }, as("claude-code", undefined));
    expect(first).toMatchObject({ ok: true, claim_token: expect.any(String) });
    expect(await call("save", { content_id: id, body: BODY }, as("claude-code", undefined))).toMatchObject({ ok: false, code: "claim_held" });
    expect(await call("save", { content_id: id, body: BODY, claim_token: first.claim_token }, as("claude-code", undefined))).toMatchObject({ ok: true });
  });
});

describe("P1 local-user 在模型写口上没有越门放行", () => {
  it("没带 _host 的调用不能越过别人的认领", async () => {
    const id = await fresh();
    await call("angle", { content_id: id, ...ANGLE });
    expect(await call("save", { content_id: id, body: BODY }, {})).toMatchObject({ ok: false, code: "claim_held" });
  });
  it("两个没带 _host 的调用各算各的（第二个没令牌就被拒）", async () => {
    const id = await fresh({});
    const first = await call("angle", { content_id: id, ...ANGLE }, {});
    expect(first.ok).toBe(true);
    expect((await getContent(id, dir))!.claim!.host).toBe("local-agent");
    expect(await call("save", { content_id: id, body: BODY }, {})).toMatchObject({ ok: false, code: "claim_held" });
  });
});

describe("P2 跨宿主闲置接管", () => {
  it("持有宿主闲置满 10 分钟，别的宿主带 takeover 可接手；原宿主迟到的写入被拒", async () => {
    const id = await fresh();
    await call("angle", { content_id: id, ...ANGLE });
    expect(await call("save", { content_id: id, body: BODY, takeover: true }, as("codex", "c1"))).toMatchObject({ ok: false, code: "claim_held" });
    await idle(id);
    expect(await call("save", { content_id: id, body: BODY, takeover: true }, as("codex", "c1"))).toMatchObject({ ok: true });
    expect((await getContent(id, dir))!.claim!.host).toBe("codex");
    expect(await call("save", { content_id: id, body: `${BODY}迟到。` })).toMatchObject({ ok: false, code: "claim_held" });
  });
});

describe("P2 evidence_ids 类型不对要报错", () => {
  it.each([[{ a: 1 }], [7], [[1, 2]]])("evidence_ids=%o → bad_param", async (ids) => {
    const id = await fresh();
    await call("angle", { content_id: id, ...ANGLE });
    await call("save", { content_id: id, body: BODY });
    expect(await call("prepare_final", { content_id: id, citations: [{ text: "省下来的时间", evidence_ids: ids }] })).toMatchObject({ ok: false, code: "bad_param" });
  });
});
