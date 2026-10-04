import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMcpRequest } from "./server.js";
import { saveTopic, saveContent, getTopic, getContent, listContents, listTopics, createPlatformVariant } from "../src/storage/local-store.js";
import { executeReview } from "../src/tools/review.js";
import * as engineConfig from "../src/engine/config.js";
import * as engineLoop from "../src/engine/loop.js";
import * as pages from "../src/modules/inbox/fetch-external.js";
import * as search from "../src/modules/research/search-provider.js";
import { getJob, PERSPECTIVE_NAMES } from "../src/modules/research/research-job-store.js";
import { reviewInFlight } from "../src/tools/writer-review.js";
import * as styleDistiller from "../src/modules/learnings/style-distiller.js";
import { listDiffs } from "../src/modules/learnings/diff-tracker.js";
import { asFounder, founderAuthored } from "../src/modules/research/angle-gate.test-helper.js";

let dataDir: string;
/** MCP 往返计数（P6 §5 预算：首稿 ≤25） */
let roundTrips = 0;
const access = { principal: { subject: "claude-desktop-test", plan: "local" as const }, host: "claude-desktop-test" };
beforeEach(async () => { dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-mcp-writing-flow-")); roundTrips = 0; });
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
async function call(name: string, args: Record<string, unknown>) {
  roundTrips += 1;
  if (name === "autocrew_writer" || name === "autocrew_workflow" || name === "autocrew_generate") await asFounder(dataDir, args);
  const response = await handleMcpRequest({ id: 1, method: "tools/call", params: { name, arguments: args } }, access, dataDir);
  return (response!.result as { structuredContent: Record<string, any> }).structuredContent;
}

// Host analysis is fixture-authored; fetching is mocked at the external-page
// boundary. MCP routing, provenance checks, stage validation and storage are real.
const GARDEN_URL = "https://example.com/community-garden";
/** 新写作包交稿必带的稿件摘要（spec 2026-09-28 §3 A） */
const OUTLINE = {
  thesis: "先弄清轮班安排，再决定参与哪一班。",
  points: [{ text: "公告板上的轮班", kind: "case", seconds: 40 }],
  structure: { opening: "从公告板说起", progression: "先共同浇水再讲轮班", ending: "自己选一班" },
  said: [{ id: "rota", kind: "concept", text: "轮班时间写在公告板上" }],
};
/** 审稿台的系列比对：快照为空也要显式交（spec §3 B） */
function seriesReviewOf(reviewPack: { series_snapshot?: { id: string; items: Array<{ content_id: string; insufficient: boolean }> } }) {
  const snap = reviewPack.series_snapshot!;
  return { snapshot_id: snap.id, checked: snap.items.map(i => i.content_id), insufficient: snap.items.filter(i => i.insufficient).map(i => i.content_id), findings: [] };
}
const GARDEN_QUOTE = "邻居们每周共同浇水，轮班时间写在公告板上。";
const GARDEN_REQUIREMENTS = "抖音口播，写给园艺新手；先介绍共同浇水，再解释轮班。只写有出处的材料，不反问，不强加关注结尾。";
function gardenPerspective(sourceId: string) {
  return {
    insights: [
      { text: "新手需要知道怎样参与", source_ids: [sourceId] },
      { text: "共同劳动提供了交流场景", source_ids: [sourceId] },
      { text: "轮班把参与意愿落到具体安排", source_ids: [sourceId] },
    ],
    evidence: [{ claim: "邻居有共同浇水和轮班安排", quote: GARDEN_QUOTE, source_id: sourceId }],
    asset_picks: [], gaps: ["没有长期参与数据，不能承诺协作效果"],
  };
}
function gardenAngles() {
  return {
    misconceptions: { grow: [], trust: [], convert: [] },
    candidates: [
      { angle: "从共同浇水开始", thesis: "共同照顾菜苗给新手提供了具体的参与入口", anti_scope: "不介绍平台工具，不夸大社区效果" },
      { angle: "公告板上的轮班表", thesis: "一张共同填写的时间表解释志愿协作怎样安排", anti_scope: "不讲种植技术，不回顾个人成长" },
      { angle: "参与之后仍要观察什么", thesis: "现有轮班记录能说明参与方式但不能证明长期效果", anti_scope: "不提供活动宣传，不承诺社区关系改善" },
    ].map(candidate => ({
      ...candidate, why_may_perform: "无数据依据", primary_persona: "grow", evidence_level: "grounded", core_evidence_ids: ["ev-1"],
      mechanism: "材料记载了共同浇水与轮班安排。", payoff: "读者了解从哪里参与。", next_action: "理解参与方式与边界。",
      counter_response: "没有长期效果材料，不做效果承诺。", persona_gains: { grow: "了解参与过程", trust: "", convert: "" },
      elements: [], evidence_needs: ["参与者后续是否持续参与"], structure: "story", hook_draft: "公告板上写着本周的浇水安排。",
    })),
  };
}

describe("Claude MCP writing journey without external model calls", () => {
  it("revises a manual import with no topic through feedback, host writing and host self-review", async () => {
    await fs.writeFile(path.join(dataDir, "engine.json"), "{ invalid backend config");
    const engineLoad = vi.spyOn(engineConfig, "loadEngineConfig");
    const optionalEngineLoad = vi.spyOn(engineConfig, "loadEngineConfigIfConfigured");
    const runLoop = vi.spyOn(engineLoop, "runLoop").mockRejectedValue(new Error("backend models are forbidden"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is forbidden"));
    const original = "邻居们共同浇水，轮班时间写在公告板上。大家可以去看公告板上的安排。";
    const imported = await call("autocrew_content", {
      action: "save", title: "社区菜园的参与方式", body: original, platform: "douyin",
      source: "manual_import", import_reason: "用户给出自己的原稿并要求修改",
    });
    expect(imported).toMatchObject({ ok: true, content: { status: "draft_ready", body: original } });
    const contentId = imported.content.id;
    expect((await getContent(contentId, dataDir))?.topicId).toBeUndefined();
    const instruction = "写给园艺新手；保留共同浇水和公告板的轮班安排，表达自然一些，不加关注引导。";
    const revision = await call("autocrew_revise", { content_id: contentId, instruction });
    expect(revision).toMatchObject({ status: "host_revision_required", model_api_calls: 0 });
    const feedback = await call(revision.next_action.tool, { ...revision.next_action.params, event_id: "import-revision", user_confirmed: true });
    expect(feedback).toMatchObject({ ok: true, next_action: { tool: "autocrew_writer", params: { content_id: contentId, force: true, research_mode: "provided", research: expect.stringContaining(original) } } });
    // 记反馈是写，没人认领时顺手认领并回令牌（P6 §3.8）：接着领包要带上它
    expect(feedback.claim_token).toMatch(/^clm-/);
    const issued = await call(feedback.next_action.tool, { ...feedback.next_action.params, claim_token: feedback.claim_token });
    // 领包即认领并回令牌（P6 §3.8）；宿主模式就地备完，不必再 pack_status（P6 §3.7）
    expect(issued).toMatchObject({ ok: true, status: "ready", synchronous: true, content_id: contentId, claim_token: expect.stringMatching(/^clm-/) });
    const ready = issued;
    expect(ready).toMatchObject({ preparation: { research: { status: "provided", autoResearched: false } } });
    expect(ready.pack_md).toContain(original);
    expect(ready.pack_md).toContain(instruction);
    expect(ready.pack_md).toContain("user_claim");
    expect((await getContent(contentId, dataDir))?.body).toBe(original);
    expect(await listTopics(dataDir)).toHaveLength(1);
    const body = "想参加社区菜园的浇水，可以先看看公告板。原稿里提到，邻居们会共同浇水，轮班时间就写在那里。\n\n对刚接触园艺的人来说，先弄清安排，再决定自己能参与哪一班，这件事就具体了。至于实际参加的过程，还需要向当事人核对。";
    const submitted = await call("autocrew_writer", { action: "submit", content_id: contentId, pack_id: issued.pack_id, claim_token: issued.claim_token, attempt: 1, title: "先看看公告板上的安排", body, outline: OUTLINE });
    // 审稿任务随交稿回执给出（P6 §3.7），下一步直接交结论，不再单独调 review_desk pack
    expect(submitted).toMatchObject({
      status: "awaiting_host_review", saved: true,
      next_action: { tool: "autocrew_review_desk", params: { action: "submit", claim_token: issued.claim_token } },
      review_pack: { status: "ready_for_host_review", review_source: { kind: "host_self_review", independent: false } },
    });
    expect(submitted.review_pack.user).toContain(instruction);
    const reviewed = await call(submitted.next_action.tool, {
      ...submitted.next_action.params, issues: [], series_review: seriesReviewOf(submitted.review_pack),
      audience: { audienceBasis: { source: "current_task", quote: "写给园艺新手" }, verdicts: [{ tier: "core", name: "园艺新手", wouldStop: true, why: "说明参与的具体入口，并披露原稿材料仍需核对。", losesAt: [] }], suggestions: [] },
    });
    expect(reviewed).toMatchObject({ ok: true, status: "accepted", quality_status: "host_self_reviewed" });
    expect(await getContent(contentId, dataDir)).toMatchObject({ body, writingFeedback: [expect.objectContaining({ instruction })], review: { source: { kind: "host_self_review" } } });
    expect((await getContent(contentId, dataDir))?.adoption).toBeUndefined();
    expect(await listContents(dataDir)).toHaveLength(1);
    expect(await listTopics(dataDir)).toHaveLength(1);
    expect(engineLoad).not.toHaveBeenCalled();
    expect(optionalEngineLoad).not.toHaveBeenCalled();
    expect(runLoop).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps legacy style and revise entry points host-driven after three MCP edits", async () => {
    await fs.writeFile(path.join(dataDir, "engine.json"), "{ invalid backend config must not affect host work");
    const engineLoad = vi.spyOn(engineConfig, "loadEngineConfig");
    const runLoop = vi.spyOn(engineLoop, "runLoop").mockRejectedValue(new Error("backend models are forbidden"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is forbidden"));
    const distill = vi.spyOn(styleDistiller, "distillStyleRules").mockRejectedValue(new Error("implicit distillation is forbidden"));
    const absorb = vi.spyOn(styleDistiller, "analyzeStyleSamples").mockRejectedValue(new Error("implicit sample model is forbidden"));
    const topic = await saveTopic({ title: "已有稿的表达", description: "保留原稿与用户修改记录", tags: [] }, dataDir);
    const content = await saveContent({ title: "用户已有稿", body: "这是用户已经写好的正文。", topicId: topic.id, platform: "douyin", status: "draft_ready" }, dataDir);
    const profileBefore = await call("autocrew_editorial", { action: "profile" });
    let claimToken: string | undefined;
    for (const body of ["先把事情发生的经过说清楚。", "接着解释交接记录里缺了什么。", "最后保留需要向当事人核对的地方。"]) {
      const updated = await call("autocrew_content", { action: "update", id: content.id, body, ...(claimToken ? { claim_token: claimToken } : {}) });
      expect(updated).toMatchObject({ ok: true, claim_token: expect.stringMatching(/^clm-/) });
      claimToken = updated.claim_token;
    }
    expect(await listDiffs({ contentId: content.id }, dataDir)).toHaveLength(3);
    expect(await styleDistiller.shouldDistillStyle(dataDir)).toBe(true);
    const learning = await call("autocrew_style", { action: "distill" });
    expect(learning).toMatchObject({ ok: true, status: "host_style_task", model_api_calls: 0, executed_by: { kind: "host", host: access.host } });
    expect(learning.edits).toHaveLength(3);
    const samples = ["先把具体经历说清楚，再表达自己的判断。"];
    expect(await call("autocrew_style", { action: "absorb_samples", samples })).toMatchObject({
      ok: true, status: "host_style_task", samples, model_api_calls: 0,
    });
    const beforeRevision = await getContent(content.id, dataDir);
    const instruction = "保留事情经过，只把结尾写得更具体。";
    const revision = await call("autocrew_revise", { content_id: content.id, instruction });
    expect(revision).toMatchObject({
      ok: true, status: "host_revision_required", content_id: content.id, feedback: instruction, model_api_calls: 0,
      next_action: { tool: "autocrew_editorial", params: { action: "feedback", content_id: content.id, scope: "draft", feedback: instruction } },
    });
    expect(revision.draft_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await getContent(content.id, dataDir)).toEqual(beforeRevision);
    expect(await call("autocrew_editorial", { action: "profile" })).toEqual(profileBefore);
    expect(distill).not.toHaveBeenCalled();
    expect(absorb).not.toHaveBeenCalled();
    expect(engineLoad).not.toHaveBeenCalled();
    expect(runLoop).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["missing", "broken"] as const)("completes default host research, angles, writing and self-review with %s engine configuration", async configState => {
    if (configState === "broken") await fs.writeFile(path.join(dataDir, "engine.json"), "{ deliberately invalid fixture");
    const engineLoad = vi.spyOn(engineConfig, "loadEngineConfig");
    const optionalEngineLoad = vi.spyOn(engineConfig, "loadEngineConfigIfConfigured");
    const runLoop = vi.spyOn(engineLoop, "runLoop").mockRejectedValue(new Error("backend models are forbidden in this journey"));
    const searchWeb = vi.spyOn(search, "searchWeb").mockRejectedValue(new Error("paid search is not part of this journey"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("real network requests are forbidden in this journey"));
    const pageFetch = vi.spyOn(pages, "fetchExternalPage").mockResolvedValue({
      finalUrl: GARDEN_URL, title: "社区菜园记录", text: GARDEN_QUOTE, imageCandidates: [],
    });
    const topic = await saveTopic({ title: "社区菜园的浇水安排", description: "依据社区记录说明共同浇水与轮班方式", tags: [] }, dataDir);
    const request = { action: "prepare", topic_id: topic.id, platform: "douyin", requirements: GARDEN_REQUIREMENTS };
    const prepared = await call("autocrew_workflow", request);
    expect(prepared).toMatchObject({
      ok: true, status: "awaiting_host_research", model_api_calls: 0,
      executed_by: { kind: "host", host: access.host }, next_action: { tool: "autocrew_scout" },
    });
    // prepare 已带回任务包：不再领一次 scout pack，下一步就是按包提交（P6 §3.7）
    const task = prepared.research_task;
    expect(task).toMatchObject({ ok: true, status: "researching", pack: { stage: "perspective" } });
    expect(prepared.next_action).toMatchObject({ tool: "autocrew_scout", params: { action: "perspective", task_id: task.task_id } });
    expect(JSON.stringify(task.pack)).toContain(GARDEN_REQUIREMENTS);
    const scout = (action: string, args: Record<string, unknown> = {}) => call("autocrew_scout", { action, topic_id: topic.id, task_id: task.task_id, ...args });
    const page = await scout("read_page", { perspective: "evidence", url: GARDEN_URL });
    expect(page).toMatchObject({ ok: true, source_id: "p1", cached: false });
    expect(page.page).toContain(GARDEN_QUOTE);
    expect(await scout("cite", { source_id: page.source_id, claim: "虚构效果", quote: "社区关系因此得到长期改善" })).toMatchObject({ ok: false, code: "quote_not_verified" });
    expect(await scout("cite", { source_id: page.source_id, claim: "记录中有共同浇水和轮班安排", quote: GARDEN_QUOTE })).toMatchObject({
      ok: true, citation: { source: "verified_quote", sourceUrl: GARDEN_URL },
    });
    for (const perspective of PERSPECTIVE_NAMES) {
      const result = await scout("perspective", { perspective, payload: gardenPerspective(page.source_id) });
      expect(result, perspective).toMatchObject({ ok: true });
    }
    const synthesis = await scout("synthesize", { payload: {
      summary: "社区记录展示了共同浇水和轮班的参与方式，长期效果尚无依据。", tensions: [], angle_suggestions: ["从共同浇水开始"],
      evidence: [{ claim: "邻居有共同浇水和轮班安排", quote: GARDEN_QUOTE, source_id: page.source_id }], asset_picks: [],
    } });
    expect(synthesis).toMatchObject({ ok: true, status: "needs_angles", pack: { stage: "angles" } });
    const researched = await scout("angles", { payload: gardenAngles() });
    expect(researched).toMatchObject({ ok: true, status: "ready", brief_revision: 1 });
    expect(await getJob(topic.id, dataDir)).toMatchObject({ status: "succeeded", executedBy: { kind: "host", host: access.host } });

    const choices = await call(researched.next_action.tool, researched.next_action.params);
    expect(choices).toMatchObject({ status: "needs_angle", research: { status: "complete", autoResearched: false } });
    expect(choices.angle.cards).toHaveLength(3);
    expect(choices.angle.recommendation).toMatchObject({ automaticSelection: false });
    expect((await getTopic(topic.id, dataDir))?.selectedAngle).toBeUndefined();
    const chosen = choices.angle.cards[0]; // This fixture simulates the creator choosing the displayed card.
    expect(choices.next_action).toMatchObject({ tool: "autocrew_workflow", params: { action: "select_angle", brief_revision: researched.brief_revision } });
    // 选定即回 writer pack 的参数，不再 prepare 第二次；pack 就地备完，不再 pack_status（P6 §3.7）
    const selected = await call(choices.next_action.tool, { ...choices.next_action.params, angle_id: chosen.id });
    expect(selected).toMatchObject({ ok: true, status: "ready_to_write", next_action: { tool: "autocrew_writer", params: { action: "pack", requirements: GARDEN_REQUIREMENTS } } });
    const started = await call(selected.next_action.tool, selected.next_action.params);
    expect(started).toMatchObject({ status: "ready", synchronous: true, writing_source: { kind: "host" } });
    const pack = started;
    expect(pack.pack_md).toContain(GARDEN_REQUIREMENTS);
    expect(pack.pack_md).toContain(GARDEN_QUOTE);
    expect(pack.pack_md).toContain("ev-1");
    const body = `社区菜园的记录写着：“${GARDEN_QUOTE}”（ev-1）\n\n对想参与的新手来说，这份记录先说明了大家共同做什么，又交代了去哪里看轮班安排。它提供了具体的参与线索；至于邻居能否持续参与，还需要后续记录，不能从这段材料直接得出结论。`;
    const submitted = await call("autocrew_writer", {
      action: "submit", content_id: started.content_id, pack_id: started.pack_id, claim_token: started.claim_token,
      attempt: 1, title: "从共同浇水开始", body, outline: OUTLINE,
    });
    expect(submitted).toMatchObject({ status: "awaiting_host_review", saved: true, next_action: { tool: "autocrew_review_desk", params: { action: "submit" } } });
    expect(reviewInFlight(started.content_id)).toBeUndefined();
    expect(await call("autocrew_writer", { action: "submit_status", content_id: started.content_id })).toMatchObject({ status: "awaiting_host_review" });
    // 审稿任务随交稿回执给出（P6 §3.7）：与 review_desk pack 同一份产物，省掉一次往返
    const review = submitted.review_pack;
    expect(review).toMatchObject({ status: "ready_for_host_review", attempt: 1, writing_pack_id: started.pack_id, review_source: { kind: "host_self_review", independent: false } });
    expect(review.user).toContain(GARDEN_REQUIREMENTS);
    expect(review.user).toContain(body);
    // 审稿结论是写：同宿主也要带领包回的令牌（P6 §3.8）——令牌已随 next_action 带上
    expect(submitted.next_action.params.claim_token).toBe(started.claim_token);
    const reviewed = await call(submitted.next_action.tool, {
      ...submitted.next_action.params, issues: [], series_review: seriesReviewOf(submitted.review_pack),
      audience: {
        audienceBasis: { source: "current_task", quote: "写给园艺新手" },
        verdicts: [{ tier: "core", name: "园艺新手", wouldStop: true, why: "给出可行动的参与线索，并保留事实边界。", losesAt: [] }],
        suggestions: [],
      },
    });
    expect(reviewed).toMatchObject({ ok: true, status: "accepted", quality_status: "host_self_reviewed", audience_review: { status: "reviewed" }, review_source: { kind: "host_self_review", independent: false } });
    expect(await call("autocrew_writer", { action: "submit_status", content_id: started.content_id })).toMatchObject({ status: "accepted", quality_status: "host_self_reviewed" });
    const saved = await getContent(started.content_id, dataDir);
    expect(saved).toMatchObject({ body, status: "draft_ready", writtenBy: { kind: "host", host: access.host }, review: { source: { kind: "host_self_review", independent: false } } });
    expect(saved?.adoption).toBeUndefined();
    expect(await listContents(dataDir)).toHaveLength(1);
    expect(roundTrips).toBeLessThanOrEqual(25); // 含两次故意的查验（假引文、submit_status），真实首稿更少
    expect(pageFetch).toHaveBeenCalledTimes(1);
    expect(pageFetch).toHaveBeenCalledWith(GARDEN_URL, { collectImages: true });
    expect(searchWeb).not.toHaveBeenCalled();
    expect(engineLoad).not.toHaveBeenCalled();
    expect(optionalEngineLoad).not.toHaveBeenCalled();
    expect(runLoop).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(dataDir, "search.json"))).rejects.toMatchObject({ code: "ENOENT" });
    if (configState === "broken") expect(await fs.readFile(path.join(dataDir, "engine.json"), "utf8")).toBe("{ deliberately invalid fixture");
  });

  it("delivers the default workflow through MCP initialization, prompt and resource", async () => {
    const initialized = await handleMcpRequest({ id: 1, method: "initialize" }, access, dataDir);
    expect((initialized!.result as { instructions: string }).instructions).toContain("autocrew_workflow prepare");
    const guide = await handleMcpRequest({ id: 2, method: "resources/read", params: { uri: "autocrew://writing-guide" } }, access, dataDir);
    expect(JSON.stringify(guide)).toContain("quality_status");
    const prompt = await handleMcpRequest({ id: 3, method: "prompts/get", params: { name: "write_content", arguments: { requirements: "只写真实经历" } } }, access, dataDir);
    expect(JSON.stringify(prompt)).toContain("只写真实经历");
    expect(JSON.stringify(prompt)).toContain("workflow prepare");
  });

  it("exposes the editorial feedback contract through the real MCP tool list", async () => {
    const response = await handleMcpRequest({ id: 4, method: "tools/list" }, access, dataDir);
    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: any }> }).tools;
    const editorial = tools.find(tool => tool.name === "autocrew_editorial");
    expect(editorial).toBeDefined();
    expect(editorial!.inputSchema).toMatchObject({
      type: "object",
      properties: {
        // v1.3：几选一常量以等价的 enum 形式列出（接受的值不变，见 tool-surface.test 契约快照）
        action: { type: "string", enum: ["profile", "update_profile", "inspect", "feedback"] },
        draft_hash: { type: "string" },
        event_id: { type: "string" },
        user_confirmed: { type: "boolean" },
        scope: { type: "string", enum: ["draft", "platform", "voice"] },
      },
    });
  });

  it("cannot jump from a new topic straight to a pack, engine generation, or generic save", async () => {
    const topic = await saveTopic({ title: "门店返工", description: "观察团队的交接问题", tags: [] }, dataDir);
    // 选题会闸口：真实 MCP 面上，没开过选题会的新题领包 / 后台代写都被同一判定拦下（顺带回就绪检查的下一步）
    expect(await call("autocrew_writer", { action: "pack", topic_id: topic.id, platform: "douyin" })).toMatchObject({ ok: false, gate: "needs_founder_angle" });
    expect(await call("autocrew_generate", { action: "script", topic: topic.title, topic_id: topic.id, platform: "douyin", execution: "engine" })).toMatchObject({ ok: false, gate: "needs_founder_angle" });
    const pack = await call("autocrew_writer", { action: "pack", topic_id: topic.id, platform: "douyin", direction: "写交接问题" });
    expect(pack).toMatchObject({ ok: false, needsResearch: true, preparation: { research: { status: "not_started" } } });
    expect(pack.next_action.params.action).toBe("prepare");
    const engine = await call("autocrew_generate", { action: "script", topic: topic.title, topic_id: topic.id, platform: "douyin" });
    expect(engine).toMatchObject({ ok: false, code: "host_writer_default" });
    const explicitEngine = await call("autocrew_generate", { action: "script", topic: topic.title, topic_id: topic.id, platform: "douyin", execution: "engine" });
    expect(explicitEngine).toMatchObject({ ok: false, needsResearch: true });
    const saved = await call("autocrew_content", { action: "save", title: "直接成稿", body: "未经准备的稿件" });
    expect(saved).toMatchObject({ ok: false, code: "writer_submission_required" });
    expect(await listContents(dataDir)).toHaveLength(0);
  });

  it("uses provided material explicitly, keeps the host as author and preserves natural full prose", async () => {
    const topic = await saveTopic({ title: "门店交接", description: "只写已经提供的亲历材料", tags: [] }, dataDir);
    const request = {
      topic_id: topic.id, platform: "douyin", research_mode: "provided",
      research: "团队先走访门店，再检查交接记录，发现问题在于责任归属。",
      direction: "按这次走访的真实顺序讲", requirements: "自然收尾，不要关注点赞引导",
    };
    const prepared = await call("autocrew_workflow", { ...request, action: "prepare" });
    expect(prepared).toMatchObject({ status: "ready_to_write", research: { status: "provided", autoResearched: false } });
    const started = await call("autocrew_writer", { ...request, action: "pack" });
    expect(started).toMatchObject({ status: "ready", synchronous: true, writing_source: { kind: "host" }, preparation: { research: { status: "provided" } } });
    const body = "我们先走访门店。\n\n我们其次检查交接记录。\n\n我们发现责任不清，流程还没有形成闭环。";
    const submitted = await call("autocrew_writer", {
      action: "submit", content_id: started.content_id, pack_id: started.pack_id, claim_token: started.claim_token,
      attempt: 1, title: "交接记录里的问题", body, hashtags: [], review: "none", outline: OUTLINE,
    });
    expect(submitted).toMatchObject({ status: "accepted_unreviewed", saved: true, needs_attention: true });
    expect(submitted.quality_status).not.toBe("passed");
    expect((await getContent(started.content_id, dataDir))?.body).toBe(body);
    expect((await getContent(started.content_id, dataDir))?.writtenBy).toMatchObject({ kind: "host", host: access.host });
  });

  it("后台改稿（autocrew_revise engine）/ 审稿自动修（review auto_fix）动不了没开过选题会的占位稿", async () => {
    const topic = await saveTopic({ title: "占位题", description: "还没开选题会", tags: [] }, dataDir);
    const placeholder = (await createPlatformVariant(topic.id, "douyin", undefined, dataDir)).content!;
    const revise = await call("autocrew_revise", { content_id: placeholder.id, instruction: "写成正文", execution: "engine" });
    expect(revise).toMatchObject({ ok: false, code: "needs_founder_angle" });
    // 占位正文改动会被拒；占位正文本身没有可修的就原样不写——两种都不会让它变成真稿
    const fixed = await executeReview({ action: "auto_fix", content_id: placeholder.id, _dataDir: dataDir, _host: "claude" });
    if (fixed.ok !== false) expect((await getContent(placeholder.id, dataDir))?.body).toBe(placeholder.body);
    else expect(fixed).toMatchObject({ code: "needs_founder_angle" });
    expect((await getContent(placeholder.id, dataDir))?.body).toBe(placeholder.body);
  });

  it("manual import remains available but cannot claim semantic approval", async () => {
    const imported = await call("autocrew_content", {
      action: "save", title: "用户已有稿", body: "用户已经写好的原稿。", status: "approved",
      source: "manual_import", import_reason: "用户给出自己的旧稿并要求归档",
    });
    expect(imported).toMatchObject({ ok: true, saved: true, quality_status: "unreviewed", needs_attention: true, content: { status: "draft_ready" } });
  });

  it("records draft feedback and follows the returned action into a fresh pack for the same content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external calls are forbidden in this journey"));
    try {
      const topic = await saveTopic({ title: "走访后的交接", description: "团队走访后核对交接记录", tags: [] }, dataDir);
        const requirements = "保留我们作为叙述者，按真实走访顺序写，不添加关注引导";
      const request = {
        topic_id: topic.id, platform: "douyin", research_mode: "provided",
        research: "团队先走访门店，再检查交接记录，发现交接记录没有写清责任人。",
        direction: "讲清交接责任问题", requirements,
      };
      const prepared = await call("autocrew_workflow", { action: "prepare", ...request });
      expect(prepared).toMatchObject({ status: "ready_to_write", research: { status: "provided" } });
      const started = await call(prepared.next_action.tool, prepared.next_action.params);
      expect(started).toMatchObject({ status: "ready", synchronous: true });
      const body = "我们先走访门店。\n\n我们其次检查交接记录。\n\n我们发现记录没有写清责任人，交接的事情还没有落实。";
      const submitted = await call("autocrew_writer", {
        action: "submit", content_id: started.content_id, pack_id: started.pack_id, claim_token: started.claim_token,
        attempt: 1, title: "交接责任还没写清", body, review: "none", outline: OUTLINE,
      });
      expect(submitted).toMatchObject({ status: "accepted_unreviewed", saved: true, audience_review: { status: "skipped" } });
      const inspected = await call("autocrew_editorial", { action: "inspect", content_id: started.content_id });
      expect(inspected).toMatchObject({ ok: true, content_id: started.content_id, feedback: [] });
      expect(inspected.draft_hash).toMatch(/^[a-f0-9]{64}$/);
      const feedback = "保留走访顺序，把交接责任写具体，结尾不要上价值。";
      const feedbackRequest = {
        action: "feedback", content_id: started.content_id, draft_hash: inspected.draft_hash,
        event_id: "mcp-feedback-journey", feedback, user_confirmed: true,
      };
      const recorded = await call("autocrew_editorial", feedbackRequest);
      expect(recorded).toMatchObject({ ok: true, status: "recorded", receipt: { scope: "draft", feedback } });
      expect(recorded.next_action).toMatchObject({
        tool: "autocrew_writer",
        params: { action: "pack", content_id: started.content_id, topic_id: topic.id, platform: "douyin", force: true },
      });
      expect((await call("autocrew_editorial", feedbackRequest))).toMatchObject({ ok: true, replayed: true });
      // 收稿即交接、写手认领随之释放；记反馈重新认领并回令牌，重领包带上它（P6 §3.8）
      expect(recorded.claim_token).toMatch(/^clm-/);
      const reissued = await call(recorded.next_action.tool, { ...recorded.next_action.params, claim_token: recorded.claim_token });
      expect(reissued.content_id).toBe(started.content_id);
      expect(reissued.pack_id).not.toBe(started.pack_id);
      const revisedPack = reissued;
      expect(revisedPack).toMatchObject({ status: "ready", synchronous: true });
      expect(revisedPack.pack_md).toContain(requirements);
      expect(revisedPack.pack_md).toContain(feedback);
      expect(revisedPack.pack_md).toContain(body);
      const contents = await listContents(dataDir);
      expect(contents.map(content => content.id)).toEqual([started.content_id]);
      expect((await getContent(started.content_id, dataDir))?.body).toBe(body);
      const afterFeedback = await call("autocrew_editorial", { action: "inspect", content_id: started.content_id });
      expect(afterFeedback.feedback).toHaveLength(1);
      const profile = await call("autocrew_editorial", { action: "profile" });
      expect(JSON.stringify(profile.profile ?? {})).not.toContain(feedback);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
