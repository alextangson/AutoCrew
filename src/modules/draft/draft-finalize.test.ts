/** prepare_final → 工作台「定了」→ 交接验收（会审 #1/#2/#3） */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "../../tools/draft.js";
import { setDraftFetch } from "./draft-research.js";
import { resetDraftTokens } from "./draft-claims.js";
import { resetReviewQueue, reviewsIdle, setCodexRunner } from "./codex-review-queue.js";
import { buildIpcHandlers } from "../../desktop/ipc.js";
import { getContent } from "../../storage/local-store.js";
import { draftHash } from "../../storage/draft-hash.js";
import { contentFile } from "../../storage/content-project.js";
import { acceptanceBlock } from "../video/handoff/acceptance.js";
import { validateCoverage, type CitationCoverage } from "../video/handoff/project-evidence.js";
import { readProductionDoc } from "../../storage/production-store.js";

let dir: string;
const PAGE = "研究显示，参与调查的 1200 名职场人里，有 37% 每天用 AI 写周报。";
const SOURCED = "有份调查问了 1200 名职场人，37% 每天用 AI 写周报。";
const UNSOURCED = "而且会议时间平均多了 25%。";
const BODY = `你是不是也觉得用了 AI 以后反而更忙了？省下来的时间，被你自己又填满了。${SOURCED}可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的那段时间写进日历。`;
const ANGLE = { main_line: "AI 省下的时间会被你自己填满", for_whom: "职场人", opening: "你是不是也觉得更忙了？", why_viral: "同题材播放第一", chain: ["一", "二", "三", "四"], founder_words: "就这个" };
const run = (action: string, args: Record<string, unknown> = {}) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });
const finalize = (payload: Record<string, unknown>, authMethod?: "session" | "bearer") => buildIpcHandlers()["draft:finalize"]({ ...payload, _dataDir: dir }, authMethod ? { authMethod } : undefined);

async function written(body = BODY): Promise<string> {
  const id = (await run("start", { inspiration: "AI 越用越忙" })).content_id as string;
  await run("angle", { content_id: id, ...ANGLE });
  expect((await run("save", { content_id: id, body })).ok).toBe(true);
  await run("read", { content_id: id, url: "https://example.com/r" });
  expect((await run("cite", { content_id: id, page_id: "p1", quote: "有 37% 每天用 AI 写周报" })).ok).toBe(true);
  expect((await run("cite", { content_id: id, page_id: "p1", quote: "参与调查的 1200 名职场人" })).ok).toBe(true);
  return id;
}
const MAPPING = [{ text: SOURCED, evidence_ids: ["ev-d1", "ev-d2"] }];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-final-"));
  resetDraftTokens(); resetReviewQueue();
  setCodexRunner(async () => ({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }));
  setDraftFetch(async (url) => ({ finalUrl: url, text: PAGE, imageCandidates: [] }));
});
afterEach(async () => {
  await reviewsIdle(); setDraftFetch(undefined); setCodexRunner(null); await fs.rm(dir, { recursive: true, force: true }); });

describe("prepare_final", () => {
  it("全部有出处：清单全 sourced，推到等你认稿，并附审稿状态（失败也能定稿）", async () => {
    const id = await written();
    const r = await run("prepare_final", { content_id: id, citations: MAPPING });
    expect(r).toMatchObject({ ok: true, status: "draft_ready", unsourced: 0, workbench_url: expect.stringContaining(id) });
    expect((r.items as Array<{ status: string }>).every((i) => i.status === "sourced")).toBe(true);
    expect((await getContent(id, dir))!.status).toBe("draft_ready");
    const again = await run("prepare_final", { content_id: id, citations: JSON.stringify(MAPPING) });
    expect((again.items as Array<{ id: string }>).map((i) => i.id)).toEqual((r.items as Array<{ id: string }>).map((i) => i.id));
  });

  it("有没出处的数字：列进清单、不拦；没映射的事实句也标未核验", async () => {
    const id = await written(BODY.replace("可周报写得快了", `${UNSOURCED}可周报写得快了`));
    const r = await run("prepare_final", { content_id: id, citations: MAPPING });
    expect(r).toMatchObject({ ok: true, unsourced: 1 });
    const bad = (r.items as Array<{ status: string; text: string; reason?: string }>).find((i) => i.status === "unsourced")!;
    expect(bad.text).toContain("25%");
  });

  it("映射引用了不存在的证据或找不到的句子 → 整批退回", async () => {
    const id = await written();
    const r = await run("prepare_final", { content_id: id, citations: [{ text: "稿里没有的句子", evidence_ids: [] }, { text: SOURCED, evidence_ids: ["ev-d9"] }] });
    expect(r).toMatchObject({ ok: false, code: "bad_citations" });
    expect((r.errors as string[]).length).toBe(2);
  });

  it("所引证据里找不到同值数字 → 该句标未核验", async () => {
    const id = await written();
    const r = await run("prepare_final", { content_id: id, citations: [{ text: SOURCED, evidence_ids: ["ev-d2"] }] });
    expect((r.items as Array<{ status: string; reason?: string }>)[0]).toMatchObject({ status: "unsourced", reason: expect.stringContaining("37%") });
  });
});

describe("工作台「定了」", () => {
  it("非浏览器会话（令牌 / 未知）→ 拒绝", async () => {
    const id = await written();
    await run("prepare_final", { content_id: id, citations: MAPPING });
    const hash = draftHash((await getContent(id, dir))!);
    expect(await finalize({ id, draft_hash: hash }, "bearer")).toMatchObject({ ok: false, code: "founder_only" });
    expect(await finalize({ id, draft_hash: hash })).toMatchObject({ ok: false, code: "founder_only" });
    expect((await getContent(id, dir))!.status).toBe("draft_ready");
  });

  it("定了：写认稿决定、进等 A-roll、citations.json 覆盖当前稿；交接认这份定稿", async () => {
    const id = await written();
    await run("prepare_final", { content_id: id, citations: MAPPING });
    const before = (await getContent(id, dir))!;
    expect(acceptanceBlock(before)).toMatchObject({ ok: false, code: "not_accepted" });
    const r = await finalize({ id, draft_hash: draftHash(before) }, "session");
    expect(r).toMatchObject({ ok: true, status: "approved" });
    const after = (await getContent(id, dir))!;
    expect(after.draftFinal).toMatchObject({ draftHash: draftHash(before), source: "founder-workbench" });
    expect(acceptanceBlock(after)).toBeNull();
    const coverage = JSON.parse(await fs.readFile(contentFile(id, dir, "citations.json"), "utf8")) as CitationCoverage;
    expect(validateCoverage(after, coverage)).toEqual([]);
    const doc = await readProductionDoc(id, dir);
    expect(doc?.decisions.some((d) => d.type === "script_approval" && d.source === "founder")).toBe(true);
  });

  it("没出处的项必须由创始人逐条保留；保留后写成显式的未核验引用", async () => {
    const id = await written(BODY.replace("可周报写得快了", `${UNSOURCED}可周报写得快了`));
    const prep = await run("prepare_final", { content_id: id, citations: MAPPING });
    const hash = draftHash((await getContent(id, dir))!);
    expect(await finalize({ id, draft_hash: hash }, "session")).toMatchObject({ ok: false, code: "unsourced_open" });
    const keep = (prep.items as Array<{ id: string; status: string }>).filter((i) => i.status === "unsourced").map((i) => i.id);
    expect(await finalize({ id, draft_hash: hash, keep }, "session")).toMatchObject({ ok: true, kept: 1 });
    const after = (await getContent(id, dir))!;
    const coverage = JSON.parse(await fs.readFile(contentFile(id, dir, "citations.json"), "utf8")) as CitationCoverage;
    const unverified = coverage.citations.find((c) => c.excerpt.includes("25%"))!;
    expect(unverified).toMatchObject({ sourceType: "user_claim", verification: expect.stringContaining("未核验") });
    expect(validateCoverage(after, coverage)).toEqual([]);
  });

  it("清单生成之后正文又改过 → 「定了」作废，要重新 prepare_final", async () => {
    const id = await written();
    await run("prepare_final", { content_id: id, citations: MAPPING });
    const stale = draftHash((await getContent(id, dir))!);
    expect((await run("save", { content_id: id, body: `${BODY}再加一句。` })).ok).toBe(true);
    expect((await getContent(id, dir))!.status).toBe("drafting");
    const r = await finalize({ id, draft_hash: stale }, "session");
    expect(r.ok).toBe(false);
    await run("prepare_final", { content_id: id, citations: MAPPING });
    const fresh = (await getContent(id, dir))!;
    expect(await finalize({ id, draft_hash: stale }, "session")).toMatchObject({ ok: false, code: "stale_checklist" });
    expect(await finalize({ id, draft_hash: draftHash(fresh) }, "session")).toMatchObject({ ok: true });
  });

  it("交接：定稿之后正文再变 → 不再认", async () => {
    const id = await written();
    await run("prepare_final", { content_id: id, citations: MAPPING });
    await finalize({ id, draft_hash: draftHash((await getContent(id, dir))!) }, "session");
    const c = (await getContent(id, dir))!;
    expect(acceptanceBlock({ ...c, body: `${c.body}改了` })).toMatchObject({ ok: false, code: "not_accepted" });
  });
});
