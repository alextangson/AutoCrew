import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as engineConfig from "../engine/config.js";
import { createEvidenceLedger } from "../modules/research/evidence-ledger.js";
import { saveContent, getContent, updateContent } from "../storage/local-store.js";
import { readPack, writePack, type ReadyPack } from "./writer-pack.js";
import { runSubmit } from "./writer-submit.js";
import { forgetReview, reviewInFlight, submitStatus } from "./writer-review.js";
import { executeReviewDesk } from "./host-review.js";
import { updateProfile } from "../modules/profile/creator-profile.js";
import { draftingNote, draftView } from "./workflow-views.js";

let dir: string;
let engineLoad: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-host-review-"));
  engineLoad = vi.spyOn(engineConfig, "loadEngineConfig");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
const body = "清晨我们一起给菜苗浇水。邻居递过水壶，告诉我这一排土还湿着。以前我们只在电梯里点头，现在开始商量谁来照顾菜园。";
const task = "公众号；写给第一次参加社区菜园的居民。按清晨浇水的经历自然展开，不反问，不强加关注结尾。";
async function seed() {
  const content = await saveContent({ title: "菜园的清晨", body: "等待写稿", platform: "wechat_mp", status: "drafting", tags: [] }, dir);
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
  await updateContent(content.id, { pack: { packId: pack.packId, issuedAt: pack.issuedAt, host: "claude" } }, dir);
  return { content, pack, args: { contentId: content.id, packId: pack.packId, attempt: 1, title: "菜园的清晨", body, host: "claude" } };
}
const desk = (args: Record<string, unknown>, host = "claude") => executeReviewDesk({ ...args, _host: host, _dataDir: dir });
async function pending() {
  const fixture = await seed();
  const saved = await runSubmit(fixture.args, dir);
  expect(saved).toMatchObject({ status: "awaiting_host_review", saved: true });
  const review = await desk({ action: "pack", content_id: fixture.content.id });
  expect(review).toMatchObject({ ok: true, status: "ready_for_host_review" });
  return { ...fixture, saved, review, submission: { action: "submit", content_id: fixture.content.id, review_pack_id: review.review_pack_id, attempt: review.attempt, issues: [] } };
}
const issue = { severity: "blocker", quote: "现在开始商量谁来照顾菜园", rule: "规划遗漏", instruction: "按创作者要求补清楚轮班分工的过程，不编造结果" };

describe("default host review", () => {
  it("保存后发宿主审稿材料，无配置也不调用后台模型或启动任务", async () => {
    const { content, review } = await pending();
    expect(engineLoad).not.toHaveBeenCalled();
    expect(reviewInFlight(content.id)).toBeUndefined();
    expect(review.system).toContain("创作者规划遵循");
    expect(review.user).toContain(body);
    expect(review.user).toContain(task);
    expect(review.user).toContain("邻居共同照顾菜园");
    expect(review.review_source).toMatchObject({ kind: "host_self_review", independent: false });
    expect((await getContent(content.id, dir))?.body).toBe(body);
    expect((await getContent(content.id, dir))?.adoption).toBeUndefined();
    const contentView = await getContent(content.id, dir);
    expect(draftingNote(contentView!)).toContain("等待当前宿主审稿");
    expect(draftingNote(contentView!)).not.toContain("后台跑");
    expect(draftView(contentView!)).toMatchObject({ reviewPending: "awaiting_host_review", reviewNextAction: { tool: "autocrew_review_desk" } });
  });

  it("重启后的submit_status与submit重放继续等待宿主，不转engine", async () => {
    const { content, args, saved } = await pending();
    forgetReview(content.id);
    expect(await submitStatus(content.id, undefined, dir, {})).toMatchObject({ status: "awaiting_host_review", next_action: { tool: "autocrew_review_desk" } });
    expect(await runSubmit(args, dir)).toMatchObject({ status: "awaiting_host_review", review_pack_id: saved.review_pack_id, replayed: true });
    expect(engineLoad).not.toHaveBeenCalled();
    expect(reviewInFlight(content.id)).toBeUndefined();
    expect(await runSubmit({ ...args, attempt: 2 }, dir)).toMatchObject({ ok: false, error: expect.stringContaining("宿主审稿") });
  });

  it("初稿之后补充的来源进入共同审稿材料并保留未核验标签", async () => {
    const { content } = await pending();
    const pack = await readPack(content.id, dir) as ReadyPack;
    pack.ledger.entries.push({ id: "ev-H-fixture", source: "user_claim", claim: "创作者补充经历", quote: "住在隔壁的居民在清晨送来一壶水。" });
    await writePack(content.id, pack, dir);
    const review = await desk({ action: "pack", content_id: content.id });
    expect(review.user).toContain("住在隔壁的居民在清晨送来一壶水");
    expect(review.user).toContain("用户材料，未核验");
    expect(review.evidence_ledger).toMatchObject({ entries: [expect.objectContaining({ id: "ev-H-fixture", source: "user_claim" })] });
    expect(engineLoad).not.toHaveBeenCalled();
  });

  it("同宿主自审如实保存来源，不产生作者采纳；同一提交幂等", async () => {
    const { content, submission } = await pending();
    const result = await desk(submission);
    expect(result).toMatchObject({ ok: true, status: "accepted", quality_status: "host_self_reviewed", review_source: { kind: "host_self_review", reviewerHost: "claude", writerHost: "claude", independent: false }, audience_review: { status: "skipped" } });
    expect(result.note).toContain("不是独立评审");
    const saved = await getContent(content.id, dir);
    expect(saved?.status).toBe("draft_ready");
    expect(saved?.review).toMatchObject({ status: "passed", source: { kind: "host_self_review", independent: false } });
    expect(saved?.adoption).toBeUndefined();
    expect(draftView(saved!)).not.toHaveProperty("reviewPending");
    expect(await desk(submission)).toMatchObject({ ok: true, replayed: true });
    expect(await getContent(content.id, dir)).toEqual(saved);
    expect(engineLoad).not.toHaveBeenCalled();
  });

  it("另一凭证主体不等于独立模型或独立评审", async () => {
    const { submission } = await pending();
    const result = await desk(submission, "editor-principal");
    expect(result).toMatchObject({ review_source: { kind: "host_other_principal_review", reviewerHost: "editor-principal", independent: false }, quality_status: "host_reviewed" });
    expect(result.note).toContain("不能据此保证不同模型");
    expect(await desk(submission, "third-principal")).toMatchObject({ ok: false, status: "review_conflict" });
  });

  it("真实引用的问题触发返修，新稿产生新审稿包", async () => {
    const { content, args, submission, review } = await pending();
    expect(await desk({ ...submission, issues: [issue] })).toMatchObject({ ok: true, status: "review_required", quality_status: "needs_revision", review_source: { kind: "host_self_review" }, next_action: { params: { attempt: 2 } } });
    expect((await getContent(content.id, dir))?.status).toBe("revision");
    expect((await readPack(content.id, dir))?.reviewRounds).toBe(1);
    const second = await runSubmit({ ...args, attempt: 2, body: `${body}我们把轮班时间记在纸上，具体安排还需要大家确认。` }, dir);
    expect(second).toMatchObject({ status: "awaiting_host_review" });
    expect(second.review_pack_id).not.toBe(review.review_pack_id);
    expect(draftView((await getContent(content.id, dir))!)).toMatchObject({ reviewPending: "awaiting_host_review", reviewNextAction: { tool: "autocrew_review_desk" } });
    expect(await desk(submission)).toMatchObject({ ok: false, status: "stale_review" });
  });
});

describe("host review validation and fencing", () => {
  it.each([
    [{ ...issue, quote: "完全不存在的原文片段" }],
    [{ ...issue, quote: "现在 开始商量谁来照顾菜园" }],
    [{ ...issue, quote: "菜园" }],
    [null],
  ])("不接收幻觉、改写、短引用或错误形状: %j", async issues => {
    const { content, submission } = await pending();
    expect(await desk({ ...submission, issues })).toMatchObject({ ok: false });
    expect((await getContent(content.id, dir))?.review).toBeUndefined();
    expect((await readPack(content.id, dir))?.attempts["1"].status).toBe("awaiting_host_review");
  });

  it.each([{ title: "新标题" }, { body: "编辑器刚保存的新正文" }, { platform: "douyin" }])("稿件任一指纹字段变化均拒收: %j", async patch => {
    const { content, submission } = await pending();
    await updateContent(content.id, patch, dir);
    const before = await getContent(content.id, dir);
    expect(await desk(submission)).toMatchObject({ ok: false, status: "stale_review" });
    expect(await getContent(content.id, dir)).toEqual(before);
  });

  it("force换写作包或伪造审稿attempt被拒，不能把旧结论覆盖新稿", async () => {
    const { content, pack, submission } = await pending();
    expect(await desk({ ...submission, attempt: 2 })).toMatchObject({ ok: false, status: "stale_review" });
    await writePack(content.id, { ...pack, packId: "new-pack", attempts: {} }, dir);
    await updateContent(content.id, { pack: { packId: "new-pack", host: "claude", issuedAt: "now" } }, dir);
    expect(await desk(submission)).toMatchObject({ ok: false, status: "stale_review" });
  });

  it("相同结论字段换键序仍幂等，改写有效结论返回冲突", async () => {
    const { content, submission } = await pending();
    const first = await desk({ ...submission, issues: [issue] });
    expect(first.ok).toBe(true);
    const reordered = { instruction: issue.instruction, rule: issue.rule, quote: issue.quote, severity: issue.severity };
    expect(await desk({ ...submission, issues: [reordered] })).toMatchObject({ ok: true, replayed: true });
    expect(await desk(submission)).toMatchObject({ ok: false, status: "review_conflict" });
    expect((await readPack(content.id, dir))?.reviewRounds).toBe(1);
  });
});

describe("host audience assessment", () => {
  const audience = {
    audienceBasis: { source: "current_task", quote: "写给第一次参加社区菜园的居民" },
    verdicts: [{ tier: "core", name: "第一次参加社区菜园的居民", wouldStop: false, why: "读者想了解自己怎么参与，结尾尚缺具体线索", losesAt: ["现在开始商量谁来照顾菜园"] }],
    suggestions: ["补充有依据的参与方式；没有资料时保留边界"],
  };
  it("没有账号画像也能按本稿明确受众点评，来源可追溯", async () => {
    const { submission } = await pending();
    expect(await desk({ ...submission, audience })).toMatchObject({ ok: true, audience_review: { status: "reviewed", result: { coreStops: false, audienceBasis: audience.audienceBasis, personaUsed: expect.stringContaining(audience.audienceBasis.quote) } } });
    expect(engineLoad).not.toHaveBeenCalled();
  });
  it("未确认画像和编造的受众依据不被收为已点评", async () => {
    const { submission } = await pending();
    expect(await desk({ ...submission, audience: { ...audience, audienceBasis: { source: "profile", quote: "" } } })).toMatchObject({ ok: false });
    expect(await desk({ ...submission, audience: { ...audience, audienceBasis: { source: "current_task", quote: "中型企业老板" } } })).toMatchObject({ ok: false });
    expect(await desk({ ...submission, audience: { ...audience, verdicts: [{ ...audience.verdicts[0], losesAt: ["编造一句原稿中不存在的话"] }] } })).toMatchObject({ ok: false });
  });
  it("已确认画像被冻结，后改画像不偷偷改变本次审阅依据", async () => {
    await updateProfile({ audiencePersona: { core: { name: "园艺新手" }, calibratedAt: "now" } }, dir);
    const { submission } = await pending();
    await updateProfile({ audiencePersona: { core: { name: "别的人群" }, calibratedAt: "later" } }, dir);
    expect(await desk({ ...submission, audience: { audienceBasis: { source: "profile", quote: "园艺新手" }, verdicts: [{ tier: "core", name: "园艺新手", wouldStop: true, why: "具体经历便于理解", losesAt: [] }], suggestions: [] } })).toMatchObject({ ok: true, audience_review: { result: { personaUsed: "核心受众=园艺新手" } } });
  });
});

it("显式none保留未审语义，也不调用模型", async () => {
  const { args } = await seed();
  expect(await runSubmit({ ...args, review: "none" }, dir)).toMatchObject({ status: "accepted_unreviewed", quality_status: "unreviewed" });
  expect(engineLoad).not.toHaveBeenCalled();
});

it("显式engine仍使用已有后台审稿链，host默认不改变兼容路径", async () => {
  const { content, args } = await seed();
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "test-only", strongModel: "fixture-reviewer" }));
  let called = 0;
  const result = await runSubmit({ ...args, review: "engine" }, dir, {
    runLoopImpl: (async (_config: unknown, opts: { tools: Array<{ name: string; execute: (args: Record<string, unknown>) => unknown }> }) => {
      called += 1;
      await opts.tools.find(tool => tool.name === "submit_review")!.execute({ verdict: "pass", issues: [] });
      return { finalMessage: "", turns: 1, totalTokens: 1, toolCallCount: 1, stopReason: "no_tool_calls" };
    }) as never,
  });
  expect(result).toMatchObject({ status: "reviewing" });
  await reviewInFlight(content.id);
  expect(called).toBe(1);
  expect(await submitStatus(content.id, undefined, dir, {})).toMatchObject({ status: "accepted", review: { status: "passed" } });
});

it("结论写回前编辑器改稿，CAS不把旧审阅结果套到新正文", async () => {
  const { content, submission } = await pending();
  const storage = await import("../storage/local-store.js");
  const original = storage.updateContentIfDraftMatches;
  vi.spyOn(storage, "updateContentIfDraftMatches").mockImplementationOnce(async (...args) => {
    await updateContent(content.id, { body: "编辑器在结论落盘前保存了另一份稿件。" }, dir);
    return original(...args);
  });
  expect(await desk(submission)).toMatchObject({ ok: false, status: "stale_review" });
  const saved = await getContent(content.id, dir);
  expect(saved?.body).toBe("编辑器在结论落盘前保存了另一份稿件。");
  expect(saved?.review).toBeUndefined();
  expect(saved?.status).toBe("drafting");
});

it.each([{ issues: [] }, { issues: [issue] }])("结论落盘后推进前发生编辑，状态不推进且结论即时失效: %j", async ({ issues }) => {
  const { content, submission } = await pending();
  const storage = await import("../storage/local-store.js");
  const original = storage.transitionStatus;
  vi.spyOn(storage, "transitionStatus").mockImplementationOnce(async (...params) => {
    await updateContent(content.id, { body: "编辑器在审稿结论落盘之后保存的新稿件。" }, dir);
    return original(...params);
  });
  expect(await desk({ ...submission, issues })).toMatchObject({ ok: false, status: "stale_review" });
  const saved = await getContent(content.id, dir);
  expect(saved?.body).toBe("编辑器在审稿结论落盘之后保存的新稿件。");
  expect(saved?.review?.status).toBe("stale");
  expect(saved?.status).toBe("drafting");
  expect(saved?.handoffs ?? []).toHaveLength(0);
  expect(draftingNote(saved!)).toContain("旧审稿结论已经失效");
});

it.each([{ title: "编辑后的标题" }, { body: "编辑后的另一份正文" }, { platform: "douyin" }])("已审稿编辑后也不能保留旧通过徽章或回执: %j", async patch => {
  const { content, submission, review, args } = await pending();
  expect(await desk(submission)).toMatchObject({ ok: true });
  await updateContent(content.id, patch, dir);
  expect((await getContent(content.id, dir))?.review).toMatchObject({ status: "stale", source: { draftHash: review.draft_hash } });
  expect(await desk(submission)).toMatchObject({ ok: false, status: "stale_review" });
  expect(await submitStatus(content.id, undefined, dir, {})).toMatchObject({ status: "stale_review", quality_status: "stale_review", original_status: "accepted" });
  expect(await runSubmit(args, dir)).toMatchObject({ ok: false, error: expect.stringContaining("stale_review") });
});

it("结论已应用但最后回执写盘失败，pending重试可恢复且不允许换结论", async () => {
  const { content, submission } = await pending();
  const rename = fs.rename.bind(fs);
  let interrupted = false;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (!interrupted && String(to).endsWith("writing-pack.json")) {
      const data = JSON.parse(await fs.readFile(from, "utf8"));
      if (data.attempts?.["1"]?.hostReview?.submission?.state === "applied") {
        interrupted = true;
        throw new Error("模拟进程在最终回执写盘前中断");
      }
    }
    return rename(from, to);
  });
  expect(await desk({ ...submission, issues: [issue] })).toMatchObject({ ok: false });
  expect(interrupted).toBe(true);
  expect((await getContent(content.id, dir))?.status).toBe("revision");
  expect((await readPack(content.id, dir))?.attempts["1"].hostReview?.submission?.state).toBe("pending");
  expect(await desk(submission)).toMatchObject({ ok: false, status: "review_conflict" });
  const recovered = await desk({ ...submission, issues: [issue] });
  expect(recovered).toMatchObject({ ok: true, status: "review_required" });
  expect(recovered).not.toHaveProperty("warning");
  expect((await readPack(content.id, dir))?.reviewRounds).toBe(1);
  expect(await desk({ ...submission, issues: [issue] })).toMatchObject({ ok: true, replayed: true });
  expect(engineLoad).not.toHaveBeenCalled();
});
