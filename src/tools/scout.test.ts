import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeScout, type ScoutDeps } from "./scout.js";
import { executeWriter } from "./writer.js";
import { packPreparation } from "./writer-prepare.js";
import { inspectHostResearchTask, withHostResearchLock } from "../modules/research/host-research-store.js";
import { loadHostEvidence } from "../modules/research/host-evidence-store.js";
import { EMPTY_OWN_MATERIAL } from "../modules/research/own-material.js";
import { createEvidenceLedger, seedLedgerFromBrief } from "../modules/research/evidence-ledger.js";
import { loadBrief } from "../modules/research/brief-store.js";
import { getJob, PERSPECTIVE_NAMES, upsertJob } from "../modules/research/research-job-store.js";
import { createResearchRunner } from "../modules/research/research-runner.js";
import { saveTopic, updateTopic, saveContent, updateContent, getContent } from "../storage/local-store.js";
import { writePack, readPack, type ReadyPack } from "./writer-pack.js";
import { claimContent } from "../storage/claims.js";
import * as config from "../engine/config.js";
import { putOnSlate } from "../modules/meetings/slate.test-helper.js";

let dir: string;
let topicId: string;
let taskId: string;
let deps: ScoutDeps;
const URL = "https://example.com/report";
const QUOTE = "邻居们每周共同浇水，轮班时间写在公告板上。";
const REQUIREMENTS = "公众号，写给园艺新手；按清晨浇水的经历自然展开，不反问，不强加关注结尾。";
const run = (action: string, args: Record<string, unknown> = {}, host = "claude") =>
  executeScout(
    { action, topic_id: topicId, ...(taskId ? { task_id: taskId } : {}), ...args, _dataDir: dir, _host: host },
    deps,
  );
async function prepare(extra: Record<string, unknown> = {}) {
  const r = await run("prepare", { platform: "wechat_mp", requirements: REQUIREMENTS, ...extra });
  expect(r.ok).toBe(true);
  taskId = r.task_id as string;
  return r;
}
async function readPage(extra: Record<string, unknown> = {}) {
  return run("read_page", { perspective: "evidence", url: URL, ...extra });
}
function perspective(source = "p1") {
  return {
    insights: [
      { text: "新手需要知道怎样参与", source_ids: [source] },
      { text: "共同劳动提供了真实的交流场景", source_ids: [source] },
      { text: "轮班是把想法落实为行动的方式", source_ids: [source] },
    ],
    evidence: source.startsWith("p") ? [{ claim: "邻居有轮班安排", quote: QUOTE, source_id: source }] : [],
    asset_picks: [],
    gaps: ["没有长期参与数据"],
  };
}
async function perspectives(source = "p1") {
  for (const p of PERSPECTIVE_NAMES)
    expect(await run("perspective", { perspective: p, payload: perspective(source) })).toMatchObject({ ok: true });
}
const synthesis = (extra: Record<string, unknown> = {}) => ({
  summary: "共同照顾菜苗带来具体的邻里交流。",
  tensions: [],
  angle_suggestions: ["浇水的一天"],
  evidence: [{ claim: "邻居有轮班安排", quote: QUOTE, source_id: "p1" }],
  asset_picks: [],
  ...extra,
});
function angles(ref = "ev-1", anchor = false) {
  return {
    misconceptions: { grow: [], trust: [], convert: [] },
    candidates: [
      {
        angle: "浇水的一天",
        thesis: "共同照顾菜苗的具体过程让陌生邻居有机会交流",
        anti_scope: "不介绍平台工具，不夸大社区效果",
      },
      {
        angle: "新手的第一盆菜",
        thesis: "从挑种子和观察土壤开始解释初次种菜的步骤",
        anti_scope: "不讲邻里关系，不做活动宣传",
      },
      {
        angle: "公告板上的轮班表",
        thesis: "一张共同填写的时间表解释志愿协作如何持续",
        anti_scope: "不谈种植技术，不回顾个人成长",
      },
    ].map((c) => ({
      ...c,
      primary_persona: "grow",
      evidence_level: "grounded",
      core_evidence_ids: [ref],
      mechanism: "材料记载了共同浇水的具体过程。",
      payoff: "读者了解怎样从小事参与。",
      next_action: "理解参与的方式与边界。",
      counter_response: "尚无长期效果材料，不做效果承诺。",
      persona_gains: { grow: "了解参与过程", trust: "", convert: "" },
      elements: [],
      evidence_needs: ["参与者自己的补充回忆"],
      structure: "story",
      hook_draft: "清晨，邻居递来一只水壶。",
      ...(anchor ? { firsthand_anchor: { kind: "brief_evidence", chunk_id: ref, quote: QUOTE } } : {}),
    })),
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-scout-"));
  topicId = (await saveTopic({ title: "菜园的清晨", description: "记录社区共同照顾菜苗的经历", tags: [] }, dir)).id;
  await putOnSlate(dir, topicId);
  taskId = "";
  deps = {
    collectOwnMaterialImpl: vi.fn(async () => structuredClone(EMPTY_OWN_MATERIAL)),
    brokerDeps: {
      searchImpl: vi.fn(async () => [{ title: "共同浇水的记录", url: URL, snippet: "有轮班安排" }]),
      fetchImpl: vi.fn(async (url) => ({
        finalUrl: url,
        text: `${QUOTE}\n${"其他记录。".repeat(2600)}`,
        title: "种植记录",
        imageCandidates: [],
      })),
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("host research lifecycle", () => {
  it("无搜索key的直接读页→四路分析→综合→立意产出标准简报，全程无引擎配置调用", async () => {
    const engine = vi.spyOn(config, "loadEngineConfig");
    const initial = await prepare();
    expect(JSON.stringify(initial.pack)).toContain(REQUIREMENTS);
    const page = await readPage();
    expect(page).toMatchObject({ ok: true, source_id: "p1", next_offset: 12000, sources: [{ sourceId: "p1" }] });
    expect(await run("cite", { source_id: "p1", claim: "存在轮班安排", quote: QUOTE })).toMatchObject({
      ok: true,
      citation: { source: "verified_quote", sourceUrl: URL },
    });
    await perspectives();
    expect(await run("synthesize", { payload: synthesis() })).toMatchObject({
      status: "needs_angles",
      pack: { stage: "angles" },
    });
    expect(await run("angles", { payload: angles() })).toMatchObject({
      ok: true,
      status: "ready",
      brief_revision: 1,
      next_action: { tool: "autocrew_workflow" },
    });
    const brief = await loadBrief(topicId, 1, dir);
    expect(brief).toMatchObject({
      creativeTask: { requirements: REQUIREMENTS, platform: "wechat_mp" },
      executedBy: { kind: "host", host: "claude" },
      evidence: [{ source: "verified_quote", sourceId: "p1" }],
    });
    expect(brief?.angleCards).toHaveLength(3);
    expect(await getJob(topicId, dir)).toMatchObject({
      status: "succeeded",
      briefRevision: 1,
      executedBy: { kind: "host", host: "claude" },
    });
    expect(engine).not.toHaveBeenCalled();
    expect(deps.brokerDeps!.searchImpl).not.toHaveBeenCalled();
  });

  it("明确方向不强迫另选立意；重复提交不产生第二版，改结果必须新任务", async () => {
    await prepare({ direction: "保持从清晨浇水自然展开" });
    await readPage();
    await perspectives();
    const payload = synthesis();
    expect(await run("synthesize", { payload })).toMatchObject({ status: "ready", brief_revision: 1 });
    expect(await run("synthesize", { payload: { ...payload } })).toMatchObject({ replayed: true, brief_revision: 1 });
    expect(await run("synthesize", { payload: synthesis({ summary: "另一个结论" }) })).toMatchObject({
      code: "stage_locked",
    });
    expect(await loadBrief(topicId, 2, dir)).toBeNull();
  });

  it("每次调用从磁盘恢复来源、页缓存与配额；换页递增ID", async () => {
    await prepare();
    await readPage();
    expect(await readPage({ offset: 12000 })).toMatchObject({ cached: true, source_id: "p1" });
    expect(deps.brokerDeps!.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readPage({ url: `${URL}/second` })).toMatchObject({
      source_id: "p2",
      usage: { readPage: { used: 2 } },
    });
    expect(await run("cite", { source_id: "p1", claim: "引用原页", quote: QUOTE })).toMatchObject({ ok: true });
    expect(deps.collectOwnMaterialImpl).toHaveBeenCalledTimes(1);
    expect((await inspectHostResearchTask(topicId, dir))?.broker.jobReadPage).toBe(2);
  });

  it("相同引文存在两页时保持宿主指明的来源，不能错配首个命中页", async () => {
    await prepare({ direction: "指定方向" });
    await readPage();
    await readPage({ url: `${URL}/second` });
    await perspectives("p2");
    expect(
      await run("synthesize", {
        payload: synthesis({ evidence: [{ claim: "来源二", quote: QUOTE, source_id: "p2" }] }),
      }),
    ).toMatchObject({ ok: true });
    expect((await loadBrief(topicId, 1, dir))?.evidence[0]).toMatchObject({
      sourceId: "p2",
      sourceUrl: `${URL}/second`,
    });
  });

  it("任务快照落盘但job尚未写入时重领会修复台账", async () => {
    await prepare();
    await fs.rm(path.join(dir, "research", "jobs.jsonl"));
    expect(await run("pack")).toMatchObject({ ok: true, task_id: taskId });
    expect(await getJob(topicId, dir)).toMatchObject({ status: "running", executedBy: { kind: "host" } });
  });
});

describe("truthful provenance and durable quotas", () => {
  it("搜索摘要不能cite；假引文不能cite；离线必须说明原因且不会自动退回", async () => {
    await prepare();
    await run("search", { perspective: "evidence", query: "菜园" });
    expect(await run("cite", { source_id: "s1", claim: "证明", quote: "有轮班安排" })).toMatchObject({
      code: "quote_not_verified",
    });
    await readPage();
    expect(await run("cite", { source_id: "p1", claim: "证明", quote: "网页没有这句话" })).toMatchObject({
      code: "quote_not_verified",
    });
    expect(await run("claim_offline", { claim: "用户亲述" })).toMatchObject({ code: "missing_argument" });
    expect((await inspectHostResearchTask(topicId, dir))?.offlineClaims).toEqual([]);
  });

  it("出网前已持久化扣额，网络失败仍占额且不伪造来源", async () => {
    await prepare();
    deps.brokerDeps!.quotas = { readPagePerJob: 1 };
    deps.brokerDeps!.fetchImpl = vi.fn(async () => {
      expect((await inspectHostResearchTask(topicId, dir))?.broker.jobReadPage).toBe(1);
      throw new Error("fixture network unavailable");
    });
    // 失败照实报，并明说这一格额度已扣、不退（P6 §3.7）
    expect(await readPage()).toMatchObject({
      ok: false,
      code: "page_fetch_failed",
      quota_consumed: true,
      error: expect.stringMatching(/fixture network unavailable.*额度.*不退回/),
    });
    expect(await readPage()).toMatchObject({ ok: false, error: expect.stringContaining("上限 1 页") });
    expect(deps.brokerDeps!.fetchImpl).toHaveBeenCalledTimes(1);
    expect((await inspectHostResearchTask(topicId, dir))?.broker.sources).toEqual([]);
    expect((await inspectHostResearchTask(topicId, dir))?.offlineClaims).toEqual([]);
  });

  it("显式离线陈述经简报→写作证据账本始终是user_claim", async () => {
    await prepare({ direction: "按自己回忆写" });
    const claim = await run("claim_offline", {
      claim: "我记得有共同浇水",
      quote: QUOTE,
      reason: "只有创作者回忆，没有外部原页",
    });
    await perspectives(claim.claim_id as string);
    expect(
      await run("synthesize", { payload: synthesis({ evidence: [], offline_claim_ids: [claim.claim_id] }) }),
    ).toMatchObject({ status: "ready" });
    const brief = (await loadBrief(topicId, 1, dir))!;
    expect(brief.evidence[0]).toMatchObject({ source: "user_claim" });
    expect(brief.gaps.join(" ")).toContain("未核验陈述");
    const ledger = createEvidenceLedger();
    seedLedgerFromBrief(ledger, brief);
    expect(ledger.entries()[0].source).toBe("user_claim");
  });

  it("离线陈述不能被包装成grounded角度或第一手证据锚点", async () => {
    await prepare();
    const claim = await run("claim_offline", { claim: "回忆", quote: QUOTE, reason: "无外部来源" });
    await perspectives(claim.claim_id as string);
    await run("synthesize", { payload: synthesis({ evidence: [], offline_claim_ids: [claim.claim_id] }) });
    const result = await run("angles", { payload: angles("ev-1", true) });
    expect(result).toMatchObject({ ok: false, code: "invalid_angles" });
    expect(JSON.stringify(result.problems)).toContain("user_claim");
    expect(await loadBrief(topicId, 1, dir)).toBeNull();
  });
});

describe("task identity and engine isolation", () => {
  it("换要求/force换任务后拒绝迟到分析与引用，非prepare也不能悄改要求", async () => {
    await prepare();
    const old = taskId;
    expect(await readPage({ requirements: "变成口播" })).toMatchObject({ code: "task_changed" });
    await prepare({ force: true });
    expect(taskId).not.toBe(old);
    expect(await run("perspective", { task_id: old, perspective: "evidence", payload: perspective() })).toMatchObject({
      code: "stale_task",
    });
    expect(await run("cite", { task_id: old, source_id: "p1", claim: "迟到", quote: QUOTE })).toMatchObject({
      code: "stale_task",
    });
    expect(await run("pack")).toMatchObject({ creative_task: { requirements: REQUIREMENTS } });
    await updateTopic(topicId, { description: "用户改变了选题" }, dir);
    expect(await run("status")).toMatchObject({ code: "task_stale" });
  });

  it("host身份由注入字段决定；另一宿主不能抢在途任务或冒认身份", async () => {
    await prepare();
    expect(await run("prepare", {}, "another-host")).toMatchObject({ code: "task_owned" });
    expect(await run("claim_offline", { claim: "回忆", reason: "无原页" }, "another-host")).toMatchObject({
      code: "task_owned",
    });
    expect(await run("status", { host: "claude" }, "another-host")).toMatchObject({ code: "invalid_arguments" });
    expect(await run("status", {}, "another-host")).toMatchObject({ executedBy: { host: "claude" } });
  });

  it("活跃后台任务不被宿主覆盖；宿主任务不被启动回收或trigger变成引擎任务", async () => {
    const runner = createResearchRunner({
      dataDir: dir,
      runJob: vi.fn(async () => ({ status: "failed", perspectives: [] })),
      onError: () => {},
    });
    try {
      await prepare();
      expect(await runner.reclaimStaleJobs()).toEqual([]);
      expect(await runner.trigger(topicId)).toMatchObject({ accepted: false, inFlight: true });
      await runner.idle();
      expect(await getJob(topicId, dir)).toMatchObject({ status: "running", executedBy: { kind: "host" } });
      await upsertJob({ topicId, status: "queued", startedAt: new Date().toISOString(), perspectives: [] }, dir);
      expect(await run("prepare", { force: true })).toMatchObject({ code: "engine_research_in_flight" });
    } finally {
      runner.stop();
    }
  });
});

async function seedPack() {
  const content = await saveContent(
    { title: "草稿", body: "等待写稿", topicId, platform: "wechat_mp", status: "drafting", tags: [] },
    dir,
  );
  const pack: ReadyPack = {
    packId: "pack-1",
    issuedAt: "now",
    state: "ready",
    host: "claude",
    briefHash: "provided",
    angleId: "user-direction",
    ledger: createEvidenceLedger().snapshot(),
    ledgerBudget: { max: 3, used: 0 },
    repair: { max: 0, used: 0 },
    reviewRounds: 0,
    attempts: {},
    context: {
      req: { topic: "草稿", platform: "wechat_mp", requirements: REQUIREMENTS },
      writingContract: REQUIREMENTS,
      platform: "wechat_mp",
      trackPackId: "koubo",
      prompts: { system: "按任务写作", user: REQUIREMENTS },
      researchSlot: "材料",
      voiceSamples: [],
      canFindEvidence: false,
      rulesApplied: 0,
      wroteWithoutBrief: false,
      wroteWithoutAngle: false,
    },
  };
  await writePack(content.id, pack, dir);
  await updateContent(content.id, { pack: { packId: pack.packId, issuedAt: pack.issuedAt, host: pack.host } }, dir);
  return { content, pack, target: { content_id: content.id, pack_id: pack.packId } };
}

describe("host evidence supplementation", () => {
  it("准确引文可补入同稿活跃包，重复补证不重复扣额，force换任务/包仍保留12条上限", async () => {
    await prepare();
    await readPage();
    const { content, pack, target } = await seedPack();
    const first = await run("cite", { ...target, source_id: "p1", quote: QUOTE, claim: "共同浇水" });
    expect(first).toMatchObject({
      host_evidence_used: 1,
      evidence_entry: { source: "verified_quote" },
      claim_token: expect.stringMatching(/^clm-/),
    });
    // 第一次补证入稿即认领（P6 §3.8）：之后对这篇的补证都带它交回的令牌
    const claimed = { ...target, claim_token: first.claim_token };
    const quoteArgs = { ...claimed, source_id: "p1", quote: QUOTE, claim: "共同浇水" };
    expect(await run("cite", quoteArgs)).toMatchObject({ host_evidence_used: 1 });
    for (let i = 1; i < 12; i++)
      expect(await run("claim_offline", { ...claimed, claim: `回忆${i}`, reason: "只有口述" })).toMatchObject({
        host_evidence_used: i + 1,
        verified: false,
      });
    expect((await getContent(content.id, dir))?.evidenceLedger?.entries).toHaveLength(12);
    await prepare({ force: true });
    await writePack(content.id, { ...pack, packId: "pack-2" }, dir);
    await updateContent(content.id, { pack: { packId: "pack-2", issuedAt: "now", host: "claude" } }, dir);
    expect(
      await run("claim_offline", { ...claimed, pack_id: "pack-2", claim: "第十三条", reason: "无原页" }),
    ).toMatchObject({ code: "evidence_quota" });
    expect(await loadHostEvidence(content.id, dir)).toHaveLength(12);
  });

  it("过期包、异主包、异选题或审阅中的稿件均不能补证", async () => {
    await prepare();
    await readPage();
    const { content, pack, target } = await seedPack();
    const args = { ...target, source_id: "p1", quote: QUOTE, claim: "共同浇水" };
    expect(await run("cite", { ...args, pack_id: "old" })).toMatchObject({ code: "stale_pack" });
    await writePack(content.id, { ...pack, host: "other" }, dir);
    expect(await run("cite", args)).toMatchObject({ code: "stale_pack" });
    await writePack(content.id, pack, dir);
    await updateContent(content.id, { topicId: "topic-123456-other" }, dir);
    expect(await run("cite", args)).toMatchObject({ code: "wrong_content" });
    await updateContent(content.id, { topicId, status: "approved" }, dir);
    expect(await run("cite", args)).toMatchObject({ code: "content_not_writable" });
    expect(await loadHostEvidence(content.id, dir)).toEqual([]);
    expect((await readPack(content.id, dir))?.ledger.entries).toEqual([]);
  });
});

describe("写门（P6 §3.8）", () => {
  it("同宿主另一个会话不带令牌补证入稿被拒并看见持有者，稿件账本不动；不入稿的引用照常", async () => {
    await prepare();
    await readPage();
    const { content, target } = await seedPack();
    const claimed = await claimContent(content.id, "writer", "claude", dir);
    if (!claimed.ok) throw new Error(claimed.error);
    const args = { ...target, source_id: "p1", quote: QUOTE, claim: "共同浇水" };
    expect(await run("cite", args)).toMatchObject({ ok: false, code: "claim_held", holder: { host: "claude" } });
    expect(await run("claim_offline", { ...target, claim: "口述", reason: "无原页" })).toMatchObject({ code: "claim_held" });
    expect(await loadHostEvidence(content.id, dir)).toEqual([]);
    expect((await readPack(content.id, dir))?.ledger.entries).toEqual([]);
    expect(await run("cite", { source_id: "p1", quote: QUOTE, claim: "共同浇水" })).toMatchObject({ ok: true });
  });

  it("带着令牌补证入稿照常入账，回执交回同一枚令牌", async () => {
    await prepare();
    await readPage();
    const { content, target } = await seedPack();
    const claimed = await claimContent(content.id, "writer", "claude", dir);
    if (!claimed.ok) throw new Error(claimed.error);
    const args = { ...target, claim_token: claimed.claim.token, source_id: "p1", quote: QUOTE, claim: "共同浇水" };
    expect(await run("cite", args)).toMatchObject({ ok: true, host_evidence_used: 1, claim_token: claimed.claim.token });
    expect(await loadHostEvidence(content.id, dir)).toHaveLength(1);
  });
});

describe("durable task leases", () => {
  it("并发调用返回busy；已死进程租约可恢复，损坏快照不会静默丢弃", async () => {
    await prepare();
    await withHostResearchLock(topicId, dir, async () => {
      expect(await run("status")).toMatchObject({ code: "task_busy" });
    });
    const taskDir = path.join(dir, "research", "host-tasks", topicId);
    await fs.writeFile(path.join(taskDir, "lease.json"), JSON.stringify({ pid: 2147483647, token: "dead", at: "old" }));
    expect(await run("status")).toMatchObject({ ok: true });
    await fs.writeFile(path.join(taskDir, `${taskId}.json`), "{}");
    expect(await run("pack")).toMatchObject({ code: "task_corrupt" });
  });
});

it("真实writer force重领同稿恢复宿主补证，来源等级、额度和可见材料不丢失也不重复", async () => {
  const loop = vi.fn(async () => {
    throw new Error("host pipeline must never call runLoop");
  });
  const engine = vi.spyOn(config, "loadEngineConfig");
  const writer = (args: Record<string, unknown>) =>
    executeWriter({ ...args, _host: "claude", _dataDir: dir }, { runLoopImpl: loop, onWarn: () => {} });
  await prepare({ direction: "从清晨浇水的经历自然展开" });
  await readPage();
  await perspectives();
  expect(await run("synthesize", { payload: synthesis() })).toMatchObject({ status: "ready" });
  const first = await writer({
    action: "pack",
    topic_id: topicId,
    platform: "wechat_mp",
    requirements: REQUIREMENTS,
    direction: "从清晨浇水的经历自然展开",
  });
  expect(first).toMatchObject({ ok: true, status: "ready", synchronous: true }); // 宿主模式 pack 就地备完（P6 §3.7）
  const contentId = first.content_id as string;
  await packPreparation(contentId);
  expect(await writer({ action: "pack_status", content_id: contentId })).toMatchObject({
    status: "ready",
    budget: { host_evidence_left: 12 },
  });
  // 领包即认领（P6 §3.8）：往这篇补证是写，带 pack 回的令牌
  const citation = {
    source_id: "p1",
    claim: "公告板记录轮班",
    quote: QUOTE,
    content_id: contentId,
    pack_id: first.pack_id,
    claim_token: first.claim_token,
  };
  const offline = {
    claim: "我记得水壶是邻居借给我的。",
    reason: "仅创作者回忆，未作外部查证",
    content_id: contentId,
    pack_id: first.pack_id,
    claim_token: first.claim_token,
  };
  expect(await run("cite", citation)).toMatchObject({ host_evidence_used: 1 });
  expect(await run("claim_offline", offline)).toMatchObject({ host_evidence_used: 2 });
  const before = (await readPack(contentId, dir))!.ledger.entries.filter((e) => e.id.startsWith("ev-H"));
  expect(before.map((e) => e.source)).toEqual(["verified_quote", "user_claim"]);
  const supplemented = await writer({ action: "pack_status", content_id: contentId });
  expect(supplemented).toMatchObject({ budget: { host_evidence_left: 10 } });
  expect(supplemented.pack_md).toContain("网页引文已逐字核对");
  expect(supplemented.pack_md).toContain("用户材料，未核验");
  const reissued = await writer({
    action: "pack",
    topic_id: topicId,
    platform: "wechat_mp",
    content_id: contentId,
    force: true,
    // 重领同篇也是写：带上首次领包回的令牌（P6 §3.8 同宿主不再免检）
    claim_token: first.claim_token,
  });
  expect(reissued).toMatchObject({ ok: true, content_id: contentId, status: "ready", synchronous: true });
  expect(reissued.pack_id).not.toBe(first.pack_id);
  await packPreparation(contentId);
  const ready = await writer({ action: "pack_status", content_id: contentId });
  expect(ready).toMatchObject({ status: "ready", pack_id: reissued.pack_id, budget: { host_evidence_left: 10 } });
  const after = (await readPack(contentId, dir))!.ledger.entries.filter((e) => e.id.startsWith("ev-H"));
  expect(after).toEqual(before);
  expect(ready.pack_md).toContain(QUOTE);
  expect(ready.pack_md).toContain(offline.claim);
  expect(ready.pack_md).toContain("本稿还可登记 10 条来源");
  expect(String(ready.pack_md).split("【本稿已补充来源")).toHaveLength(2);
  expect(await run("cite", citation)).toMatchObject({ code: "stale_pack" });
  expect(await run("cite", { ...citation, pack_id: reissued.pack_id })).toMatchObject({ host_evidence_used: 2 });
  expect(await run("claim_offline", { ...offline, pack_id: reissued.pack_id })).toMatchObject({
    host_evidence_used: 2,
  });
  expect(
    await run("claim_offline", { ...offline, claim: "新补充：轮班安排仍需其他邻居确认。", pack_id: reissued.pack_id }),
  ).toMatchObject({ host_evidence_used: 3 });
  const final = await writer({ action: "pack_status", content_id: contentId });
  expect(final).toMatchObject({ budget: { host_evidence_left: 9 } });
  expect(final.pack_md).toContain("新补充：轮班安排仍需其他邻居确认。");
  expect((await readPack(contentId, dir))!.ledger.entries.filter((e) => e.id.startsWith("ev-H"))).toHaveLength(3);
  expect(loop).not.toHaveBeenCalled();
  expect(engine).not.toHaveBeenCalled();
});

it("超长网页按完整字符分页，复制消毒后的标点、链接与空白仍可逐字核验", async () => {
  const copied = "邻居说：“湿土不用再浇。” 详见[链接] ·原文·\u00a0保持句号。";
  deps.brokerDeps!.fetchImpl = vi.fn(async (url) => ({
    finalUrl: url,
    text: `${"字".repeat(11999)}🌱${copied.replace("[链接]", "https://example.com/original").replace("·原文·", "<<<原文>>>")}`,
    imageCandidates: [],
  }));
  await prepare();
  const first = await readPage();
  expect(String(first.page).includes("🌱")).toBe(true);
  expect(first).toMatchObject({ next_offset: 12000 });
  const second = await readPage({ offset: first.next_offset });
  expect(second.page).toContain(copied);
  expect(second.next_offset).toBeUndefined();
  expect(await run("cite", { source_id: "p1", claim: "土壤观察与浇水", quote: copied })).toMatchObject({
    ok: true,
    citation: { source: "verified_quote", quote: copied },
  });
  expect(
    await run("cite", { source_id: "p1", claim: "不能任意替换标点", quote: copied.replace("：“", ':"') }),
  ).toMatchObject({ code: "quote_not_verified" });
  expect(deps.brokerDeps!.fetchImpl).toHaveBeenCalledTimes(1);
});
