/**
 * P6 §3.7 写作线协议瘦身：同号重放 vs attempt_conflict、交稿即带审稿包、草稿就绪后直接修订（revision_of）。
 * 零网络、零模型：包是手工落的 ready 包，审稿由测试扮演宿主经 review_desk 提交结构化结论。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as engineConfig from "../engine/config.js";
import { createEvidenceLedger } from "../modules/research/evidence-ledger.js";
import { draftHash } from "../storage/draft-hash.js";
import { getContent, saveContent, updateContent } from "../storage/local-store.js";
import { executeReviewDesk } from "./host-review.js";
import { executeWriter } from "./writer.js";
import { readPack, writePack, type ReadyPack } from "./writer-pack.js";
import { MAX_REVISION_CYCLES, revisionNextAction } from "./writer-revision.js";
import { runSubmit } from "./writer-submit.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

let dir: string;
let engineLoad: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-writer-submit-"));
  engineLoad = vi.spyOn(engineConfig, "loadEngineConfig");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

const task = "公众号；写给第一次参加社区菜园的居民。按清晨浇水的经历自然展开，不反问，不强加关注结尾。";
const BODY = "清晨我们一起给菜苗浇水。邻居递过水壶，告诉我这一排土还湿着。以前我们只在电梯里点头，现在开始商量谁来照顾菜园。";
const revised = (n: number) => `${BODY}第${n}次改稿时，我们把轮班时间写在一张纸上，具体安排还要大家确认。`;
const blocker = { severity: "blocker", quote: "现在开始商量谁来照顾菜园", rule: "规划遗漏", instruction: "补清楚轮班分工的过程，不编造结果" };

async function seed() {
  const content = await saveContent({ _provenance: HUMAN_WRITE, title: "菜园的清晨", body: "等待写稿", platform: "wechat_mp", status: "drafting", tags: [] }, dir);
  const pack: ReadyPack = {
    packId: "writing-pack-1", issuedAt: "2026-09-22T00:00:00Z", state: "ready", host: "claude", briefHash: "provided", angleId: "user-direction",
    ledger: createEvidenceLedger().snapshot(), ledgerBudget: { max: 3, used: 0 }, repair: { max: 0, used: 0 }, reviewRounds: 0, attempts: {},
    context: {
      req: { topic: "菜园的清晨", platform: "wechat_mp", requirements: task }, writingContract: task, platform: "wechat_mp", trackPackId: "koubo",
      prompts: { system: "按任务自然写作", user: task }, researchSlot: "创作者材料：邻居共同照顾菜园。", voiceSamples: [], canFindEvidence: false,
      rulesApplied: 0, wroteWithoutBrief: false, wroteWithoutAngle: false,
    },
  };
  await writePack(content.id, pack, dir);
  await updateContent(content.id, { _provenance: HUMAN_WRITE, pack: { packId: pack.packId, issuedAt: pack.issuedAt, host: "claude" } }, dir);
  return { id: content.id, args: { contentId: content.id, packId: pack.packId, attempt: 1, title: "菜园的清晨", body: BODY, host: "claude" } };
}
const desk = (args: Record<string, unknown>) => executeReviewDesk({ ...args, _host: "claude", _dataDir: dir });
const writer = (args: Record<string, unknown>) => executeWriter({ action: "submit", ...args, _host: "claude", _dataDir: dir });

/** 审稿结论是写（P6 §3.8）：退修时写手认领还挂着，下一次交结论要带上一次回的令牌 */
let token: string | undefined;
beforeEach(() => { token = undefined; });

/** 交稿 → 按回执里的 next_action 直接交审稿结论（不再调 review_desk pack） */
async function submitAndReview(args: Parameters<typeof runSubmit>[0], issues: unknown[] = []) {
  const saved = await runSubmit(args, dir) as Record<string, any>;
  expect(saved).toMatchObject({ status: "awaiting_host_review", next_action: { tool: "autocrew_review_desk", params: { action: "submit" } } });
  const result = await desk({ ...saved.next_action.params, issues, ...(token ? { claim_token: token } : {}) });
  token = typeof result.claim_token === "string" ? result.claim_token : token;
  return result;
}

describe("attempt 重放语义", () => {
  it("同号同载荷是合法重放；同号换正文报 attempt_conflict，新正文不被静默丢弃", async () => {
    const { id, args } = await seed();
    const first = await runSubmit(args, dir) as Record<string, any>;
    const replay = await runSubmit(args, dir) as Record<string, any>;
    expect(replay).toMatchObject({ status: "awaiting_host_review", replayed: true, review_pack_id: first.review_pack_id, review_pack: { review_pack_id: first.review_pack_id } });
    const before = await readPack(id, dir);
    const conflict = await runSubmit({ ...args, body: revised(1) }, dir);
    expect(conflict).toMatchObject({ ok: false, code: "attempt_conflict", current_attempt: 1, next_action: { tool: "autocrew_writer", params: { action: "submit", attempt: 2 } } });
    expect((await getContent(id, dir))?.body).toBe(BODY);
    expect(await readPack(id, dir)).toEqual(before);
    expect(await runSubmit({ ...args, attempt: 0 }, dir)).toMatchObject({ ok: false });
  });
});

describe("submit{review:host} 直接带回审稿包", () => {
  it("回执里的审稿包与 review_desk pack 逐字相同，重取是同一个 review_pack_id，受众依据交稿时就已冻结落盘", async () => {
    const { id, args } = await seed();
    const saved = await runSubmit(args, dir) as Record<string, any>;
    expect(saved.review_pack).toMatchObject({ ok: true, status: "ready_for_host_review", review_pack_id: saved.review_pack_id, draft_hash: saved.draft_hash, attempt: 1 });
    expect(saved.review_pack.user).toContain(BODY);
    expect(saved.review_pack.user).toContain(task);
    expect(saved.next_action).toEqual(expect.objectContaining({ tool: "autocrew_review_desk", params: { action: "submit", content_id: id, review_pack_id: saved.review_pack_id, attempt: 1 } }));
    expect((await readPack(id, dir))?.attempts["1"].hostReview?.audienceContext).toMatchObject({ writingContract: task, confirmedProfile: false });
    const refetched = await desk({ action: "pack", content_id: id });
    expect(refetched).toEqual(saved.review_pack);
    expect((await desk({ action: "pack", content_id: id })).review_pack_id).toBe(saved.review_pack_id);
    expect(await desk({ ...saved.next_action.params, issues: [] })).toMatchObject({ ok: true, status: "accepted", quality_status: "host_self_reviewed" });
    expect(engineLoad).not.toHaveBeenCalled();
  });
});

describe("draft_ready 直接修订（revision_of）", () => {
  it("开新修订周期：退回 revision、审稿轮数归零、attempts 不清，修订说明以 source:host 进版本记录", async () => {
    const { id, args } = await seed();
    expect(await submitAndReview(args, [blocker])).toMatchObject({ status: "review_required" });
    expect(await submitAndReview({ ...args, attempt: 2, body: revised(0) })).toMatchObject({ status: "accepted" });
    expect(await readPack(id, dir)).toMatchObject({ reviewRounds: 1 });
    const current = (await getContent(id, dir))!;
    expect(current.status).toBe("draft_ready");
    const refused = await writer({ content_id: id, pack_id: args.packId, attempt: 3, title: args.title, body: revised(1) });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("revision_of") });

    const out = await writer({ content_id: id, pack_id: args.packId, attempt: 3, title: args.title, body: revised(1), revision_of: draftHash(current), revision_note: "按审稿意见把轮班写具体", claim_token: refused.claim_token }) as Record<string, any>;
    expect(out).toMatchObject({ status: "awaiting_host_review", ok: true, attempt: 3, review_pack: { status: "ready_for_host_review", attempt: 3 } });
    const pack = await readPack(id, dir) as ReadyPack & { revisionCycles?: number };
    expect(pack).toMatchObject({ reviewRounds: 0, revisionCycles: 1 });
    expect(Object.keys(pack.attempts).sort()).toEqual(["1", "2", "3"]);
    const saved = (await getContent(id, dir))!;
    expect(saved.status).toBe("revision");
    expect(saved.versions.at(-1)).toMatchObject({ body: revised(1), source: "host", revisionNote: "按审稿意见把轮班写具体" });
    expect(saved.writingFeedback ?? []).toEqual([]);
    expect(saved).not.toHaveProperty("_versionMeta");
    // 令牌随 next_action 走：审完直接交结论，稿件回到草稿就绪
    expect(await desk({ ...out.next_action.params, issues: [] })).toMatchObject({ ok: true, status: "accepted" });
    expect((await getContent(id, dir))?.status).toBe("draft_ready");
  });

  it("revision_of 对不上当前稿（编辑器改过）→ stale_draft，稿件与周期都不动", async () => {
    const { id, args } = await seed();
    await submitAndReview(args);
    const reviewed = (await getContent(id, dir))!;
    await updateContent(id, { _provenance: HUMAN_WRITE, body: `${BODY}创作者在编辑器里补了一句。` }, dir);
    const before = await getContent(id, dir);
    expect(await runSubmit({ ...args, attempt: 2, body: revised(1), revisionOf: draftHash(reviewed) }, dir)).toMatchObject({ ok: false, code: "stale_draft" });
    expect(await getContent(id, dir)).toEqual(before);
    expect(await readPack(id, dir)).not.toHaveProperty("revisionCycles");
  });

  it(`每个写作包至多 ${MAX_REVISION_CYCLES} 个修订周期，用尽回 revision_budget_exhausted / needs_human`, async () => {
    const { id, args } = await seed();
    await submitAndReview(args);
    for (let cycle = 1; cycle <= MAX_REVISION_CYCLES; cycle++) {
      const current = (await getContent(id, dir))!;
      expect(await submitAndReview({ ...args, attempt: cycle + 1, body: revised(cycle), revisionOf: draftHash(current) })).toMatchObject({ status: "accepted" });
    }
    const current = (await getContent(id, dir))!;
    const exhausted = await runSubmit({ ...args, attempt: MAX_REVISION_CYCLES + 2, body: revised(9), revisionOf: draftHash(current) }, dir);
    expect(exhausted).toMatchObject({ ok: false, code: "revision_budget_exhausted", status: "needs_human", revision_cycles: MAX_REVISION_CYCLES });
    expect(await getContent(id, dir)).toMatchObject({ status: "draft_ready", body: revised(MAX_REVISION_CYCLES) });
  });

  it("revisionNextAction：没有待应用的创作者意见时直接修订；有新反馈时仍走重领包", async () => {
    const { id, args } = await seed();
    await submitAndReview(args);
    const ready = (await getContent(id, dir))!;
    expect(await revisionNextAction(ready, dir)).toMatchObject({
      tool: "autocrew_writer", params: { action: "submit", content_id: id, pack_id: args.packId, attempt: 2, revision_of: draftHash(ready) },
    });
    const withFeedback = (await updateContent(id, { _provenance: HUMAN_WRITE, writingFeedback: [{ instruction: "结尾别上价值", scope: "whole", at: new Date().toISOString() }] }, dir))!;
    expect(await revisionNextAction(withFeedback, dir)).toMatchObject({ tool: "autocrew_writer", params: { action: "pack", content_id: id, force: true } });
  });
});
