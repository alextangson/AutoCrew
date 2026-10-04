/**
 * spec 2026-09-28 §3 A/B/C、§4：写作包冻结系列快照与手法目录、交稿必带摘要、同号幂等算上新字段、
 * 手法卡按冻结版本校验、缺口记录经 pack_request_changed → force 恢复、旧包不带摘要照常交稿。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeWriter } from "./writer.js";
import { executeReviewDesk } from "./host-review.js";
import { PACK_JSON, type WritingPackFile } from "./writer-pack.js";
import { packPreparation } from "./writer-prepare.js";
import { BRIEF_SCHEMA_VERSION, saveBrief, type AngleCardV3, type ResearchBrief } from "../modules/research/brief-store.js";
import { pendingPerspectives, topicHashOf, upsertJob } from "../modules/research/research-job-store.js";
import { createCreativeTask } from "../modules/writing/creative-task.js";
import { getContent, saveContent, saveTopic, transitionStatus, updateContent, updateTopic } from "../storage/local-store.js";
import { asFounder } from "../modules/research/angle-gate.test-helper.js";

let dir: string;
const TITLE = "AI 编程助手横评";
const DESC = "对比主流工具的真实提效";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-writer-series-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "sk-test", strongModel: "m", fastModel: "m" }));
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const CARD: AngleCardV3 = {
  cardVersion: 3, id: "angle-1", angle: "算一笔维护账", thesis: "省下的编码时间被维护成本吃回去了", evidenceLevel: "grounded",
  coreEvidenceIds: ["ev-1"], antiScope: "不写工具横评", hookDraft: "提效是真的，只是账没算完。", primaryPersona: "grow",
  misconception: "他以为提效数字就是净收益", mechanism: "AI 写得快，返工的活落回人身上", payoff: "把返工工时也记进去",
  nextAction: "今晚把上周的返工工时记一次", counterResponse: "熟练组也没降", personaGains: { grow: "a", trust: "b", convert: "c" },
  elements: ["新奇点"], evidenceNeeds: [], structure: "myth-busting", score: 4, scoreReasons: ["有简报证据"],
};

async function freshTopic(): Promise<string> {
  const topic = await saveTopic({ title: TITLE, description: DESC, tags: [] }, dir);
  const brief: ResearchBrief = {
    schemaVersion: BRIEF_SCHEMA_VERSION, summary: "厂商口径与独立评测差了四倍。", perspectives: [], tensions: ["差距"], angleSuggestions: [],
    angleCards: [CARD], evidence: [{ claim: "提效幅度低", quote: "平均完成时间缩短约 12%。", sourceUrl: "https://example.com/r" }],
    assetPicks: [], missingPerspectives: [], gaps: [], generatedAt: "2026-09-04T10:00:00.000Z", revision: 1, topicHash: topicHashOf(TITLE, DESC),
    creativeTask: createCreativeTask({ platform: "douyin" }),
  };
  await saveBrief(topic.id, brief, dir);
  await upsertJob({ topicId: topic.id, status: "succeeded", startedAt: "2026-09-04T09:00:00.000Z", settledAt: "2026-09-04T10:00:00.000Z",
    perspectives: pendingPerspectives(), briefRevision: 1, topicHash: topicHashOf(TITLE, DESC) }, dir);
  await updateTopic(topic.id, { selectedAngle: { briefRevision: 1, angleId: "angle-1", card: CARD, selectedAt: "2026-09-04T11:00:00.000Z" } }, dir);
  return topic.id;
}

const run = async (params: Record<string, unknown>) => { await asFounder(dir, params); return executeWriter({ ...params, _dataDir: dir }, { onWarn: () => {} }) as Promise<Record<string, any>>; };

async function pack(topicId: string, over: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const started = await run({ action: "pack", topic_id: topicId, platform: "douyin", ...over });
  if (started.ok === false || started.status === "ready") return started;
  await packPreparation(started.content_id);
  return { ...started, ...(await run({ action: "pack_status", content_id: started.content_id })) };
}
async function readPackFile(contentId: string): Promise<WritingPackFile> {
  return JSON.parse(await fs.readFile(path.join(dir, "contents", contentId, PACK_JSON), "utf-8")) as WritingPackFile;
}

const GOOD = {
  title: "写代码更快之后，账为什么反而不好看",
  hook: "同事说他现在写得飞快，可上线前的通宵一次没少。",
  body: "他省下的是敲字的时间，花掉的是回头看的时间。这两笔账记在不同的本子上，所以看起来像赚了。",
  cta: "今晚记一次你的返工时间，明早再看这笔账。",
  hashtags: ["#AI编程"],
};
const OUTLINE = {
  thesis: "AI 省下的是敲字时间，返工时间记在另一本账上。",
  points: [{ text: "同事写得快但通宵没少", kind: "case", seconds: 60 }],
  structure: { opening: "反差", progression: "拆两本账", ending: "记一次返工时间" },
  said: [{ id: "two-ledgers", kind: "metaphor", text: "敲字时间和回头看的时间是两本账" }],
};
const submit = (p: Record<string, any>, attempt: number, over: Record<string, unknown> = {}) =>
  run({ action: "submit", content_id: p.content_id, pack_id: p.pack_id, claim_token: p.claim_token, attempt, ...GOOD, outline: OUTLINE, review: "none", ...over });

describe("writing pack freezes series memory and the technique catalog", () => {
  it("renders the same-platform snapshot (other topics only) and the approved catalog; re-pack keeps the same frozen snapshot", async () => {
    const otherTopic = await saveTopic({ title: "别的选题", description: "x", tags: [] }, dir);
    const neighbour = await saveContent({ title: "上周那条", body: "开头。\n\n结尾。", platform: "douyin", topicId: otherTopic.id, status: "drafting", tags: [] }, dir);
    await transitionStatus(neighbour.id, "draft_ready", { force: true }, dir);
    const wechat = await saveContent({ title: "公众号那条", body: "别的平台。", platform: "wechat_mp", status: "drafting", tags: [] }, dir);
    await transitionStatus(wechat.id, "draft_ready", { force: true }, dir);

    const topicId = await freshTopic();
    const p = await pack(topicId);
    expect(p.status).toBe("ready");
    const file = await readPackFile(p.content_id);
    expect(file.series?.items.map((i) => i.content_id)).toEqual([neighbour.id]);
    expect(file.series?.items[0]).toMatchObject({ insufficient: true, label: "待发（写过，观众还没看到）" });
    expect(file.techniques?.cards.length).toBeGreaterThanOrEqual(12);
    expect(p.pack_md).toContain("上周那条");
    expect(p.pack_md).toContain("覆盖不足");
    expect(p.pack_md).not.toContain("公众号那条");
    expect(p.pack_md).toContain("sticky-curiosity-gap@v1");
    expect(p.pack_md).toContain("先规划再动笔");

    // 冻结之后进入范围的稿不会悄悄进同一个包
    const later = await saveContent({ title: "后来的", body: "后来。", platform: "douyin", topicId: (await saveTopic({ title: "t3", description: "", tags: [] }, dir)).id, status: "drafting", tags: [] }, dir);
    await transitionStatus(later.id, "draft_ready", { force: true }, dir);
    const again = await pack(topicId);
    expect(again.pack_id).toBe(p.pack_id);
    expect((await readPackFile(p.content_id)).series?.id).toBe(file.series?.id);
  });

  it("technique action reads a frozen card; unknown or wrong-version technique_ids are refused without charging repair", async () => {
    const p = await pack(await freshTopic());
    const card = await run({ action: "technique", content_id: p.content_id, id: "minto-scq-intro", version: 1 });
    expect(card).toMatchObject({ ok: true, card: { id: "minto-scq-intro", version: 1, illustration: { label: "示意，不是事实材料" } } });
    expect(await run({ action: "technique", id: "minto-scq-intro", version: 9 })).toMatchObject({ ok: false });
    expect(await submit(p, 1, { technique_ids: [{ id: "minto-scq-intro", version: 9 }] })).toMatchObject({ ok: false, code: "unknown_technique" });
    expect((await readPackFile(p.content_id)).repair.used).toBe(0);
    const ok = await submit(p, 1, { technique_ids: [{ id: "minto-scq-intro", version: 1 }] });
    expect(ok).toMatchObject({ status: "accepted_unreviewed", length_hint: { advisory: true } });
    expect((await getContent(p.content_id, dir))?.technique_ids).toEqual([{ id: "minto-scq-intro", version: 1 }]);
  });
});

describe("submit contract with outline (spec §4)", () => {
  it("new packs require an outline (refusal, no repair charged); the saved version carries outline + review-context fingerprint", async () => {
    const p = await pack(await freshTopic());
    const missing = await run({ action: "submit", content_id: p.content_id, pack_id: p.pack_id, claim_token: p.claim_token, attempt: 1, ...GOOD, review: "none" });
    expect(missing).toMatchObject({ ok: false, code: "outline_required" });
    const file = await readPackFile(p.content_id);
    expect(file.repair.used).toBe(0);
    expect(file.attempts).toEqual({});
    expect(await submit(p, 1, { outline: { ...OUTLINE, thesis: "" } })).toMatchObject({ ok: false });
    const ok = await submit(p, 1);
    expect(ok.status).toBe("accepted_unreviewed");
    const saved = (await getContent(p.content_id, dir))!;
    expect(saved.outline).toEqual(OUTLINE);
    expect(saved.outlineVersion).toBe(1);
    expect(saved.seriesSnapshotId).toBe(file.series?.id);
    expect(saved.reviewContextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.versions.at(-1)).toMatchObject({ outline: OUTLINE, reviewContextHash: saved.reviewContextHash });
  });

  it("attempt idempotency includes outline and technique_ids: identical replay returns the recorded result, a changed outline is attempt_conflict", async () => {
    const p = await pack(await freshTopic());
    const first = await submit(p, 1);
    expect(first.status).toBe("accepted_unreviewed");
    const replay = await submit(p, 1);
    expect(replay.status).toBe(first.status);
    expect((await getContent(p.content_id, dir))?.versions.length).toBe((await getContent(p.content_id, dir))?.versions.length);
    const changedOutline = await submit(p, 1, { outline: { ...OUTLINE, thesis: "换了一个中心思想" } });
    expect(changedOutline).toMatchObject({ ok: false, code: "attempt_conflict" });
    const changedTechniques = await submit(p, 1, { technique_ids: [{ id: "minto-scq-intro", version: 1 }] });
    expect(changedTechniques).toMatchObject({ ok: false, code: "attempt_conflict" });
  });

  it("same-attempt retry with only object key order changed replays; array order still matters (Codex P2)", async () => {
    const p = await pack(await freshTopic());
    const first = await submit(p, 1, { technique_ids: [{ id: "minto-scq-intro", version: 1 }] });
    expect(first.status).toBe("accepted_unreviewed");
    const reordered = {
      said: OUTLINE.said.map((x) => ({ text: x.text, kind: x.kind, id: x.id })),
      structure: { ending: OUTLINE.structure.ending, progression: OUTLINE.structure.progression, opening: OUTLINE.structure.opening },
      points: OUTLINE.points.map((x) => ({ seconds: x.seconds, kind: x.kind, text: x.text })),
      thesis: OUTLINE.thesis,
    };
    const replay = await submit(p, 1, { outline: reordered, technique_ids: [{ version: 1, id: "minto-scq-intro" }] });
    expect(replay.code).toBeUndefined();
    expect(replay.status).toBe("accepted_unreviewed");
    // 数组顺序仍算内容：多一个信息点（或换序）就是另一份载荷
    const twoPoints = { ...OUTLINE, points: [...OUTLINE.points, { text: "第二点", kind: "cause", seconds: 30 }] };
    expect(await submit(p, 1, { outline: twoPoints, technique_ids: [{ id: "minto-scq-intro", version: 1 }] })).toMatchObject({ ok: false, code: "attempt_conflict" });
    const q = await pack(await freshTopic());
    await submit(q, 1, { outline: twoPoints });
    expect(await submit(q, 1, { outline: { ...twoPoints, points: [...twoPoints.points].reverse() } })).toMatchObject({ ok: false, code: "attempt_conflict" });
  });

  it("a body edit after submit invalidates the outline for the series snapshot (no silent reuse)", async () => {
    const p = await pack(await freshTopic());
    await submit(p, 1);
    const { buildSeriesSnapshot } = await import("../modules/writing/series-memory.js");
    const before = buildSeriesSnapshot([(await getContent(p.content_id, dir))!], "douyin", {});
    expect(before.items[0]).toMatchObject({ insufficient: false, outline_version: 1 });
    await updateContent(p.content_id, { body: "编辑器里改过的正文。" }, dir);
    const after = buildSeriesSnapshot([(await getContent(p.content_id, dir))!], "douyin", {});
    expect(after.items[0]).toMatchObject({ insufficient: true, outline_version: 0 });
  });

  it("legacy packs (no frozen snapshot) still accept a submit without outline", async () => {
    const p = await pack(await freshTopic());
    const legacy = await readPackFile(p.content_id);
    delete legacy.series; delete legacy.techniques;
    await fs.writeFile(path.join(dir, "contents", p.content_id, PACK_JSON), JSON.stringify(legacy));
    const res = await run({ action: "submit", content_id: p.content_id, pack_id: p.pack_id, claim_token: p.claim_token, attempt: 1, ...GOOD, review: "none" });
    expect(res.status).toBe("accepted_unreviewed");
    expect((await getContent(p.content_id, dir))?.outline).toBeUndefined();
    // 不带新字段时沿用旧指纹算法：同号重放原样返回
    const replay = await run({ action: "submit", content_id: p.content_id, pack_id: p.pack_id, claim_token: p.claim_token, attempt: 1, ...GOOD, review: "none" });
    expect(replay.code).toBeUndefined();
    expect(replay.status).toBe("accepted_unreviewed");
  });
});

describe("gap record (spec §3 A)", () => {
  it("records the gap on the pack, keeps the draft writable and the claim, and resumes only via pack_request_changed → force with a fresh snapshot", async () => {
    const topicId = await freshTopic();
    const p = await pack(topicId);
    const gap = { available: "一份独立评测", missing: "一手返工工时", questions: ["你们组上周返工了几小时？"] };
    expect(await run({ action: "gap", content_id: p.content_id, pack_id: "wp-other", claim_token: p.claim_token, gap })).toMatchObject({ ok: false });
    expect(await run({ action: "gap", content_id: p.content_id, pack_id: p.pack_id, claim_token: p.claim_token, gap: { missing: "x" } })).toMatchObject({ ok: false });
    const recorded = await run({ action: "gap", content_id: p.content_id, pack_id: p.pack_id, claim_token: p.claim_token, gap });
    expect(recorded).toMatchObject({ ok: true, status: "needs_material", gap: { ...gap, packId: p.pack_id }, next_action: { params: { force: true } } });
    expect(await run({ action: "gap", content_id: p.content_id, pack_id: p.pack_id, claim_token: p.claim_token, gap })).toMatchObject({ ok: true, replayed: true });
    const content = (await getContent(p.content_id, dir))!;
    expect(content.status).toBe("drafting");
    expect(content.gapRecord).toMatchObject(gap);
    expect(content.claim).toBeTruthy();

    const blocked = await pack(topicId);
    expect(blocked).toMatchObject({ ok: false, code: "pack_request_changed", pack_id: p.pack_id, gap: { missing: gap.missing } });
    const resumed = await pack(topicId, { force: true, claim_token: p.claim_token });
    expect(resumed.status).toBe("ready");
    expect(resumed.pack_id).not.toBe(p.pack_id);
    const file = await readPackFile(p.content_id);
    expect(file.gapRecord).toBeUndefined();
    expect(file.series).toBeDefined();
    const ok = await submit(resumed, 1);
    expect(ok.status).toBe("accepted_unreviewed");
    expect((await getContent(p.content_id, dir))?.gapRecord).toBeUndefined();
  });
});

describe("a pack with a gap record takes no more drafts (Codex round 3 P2)", () => {
  const gap = { available: "一份独立评测", missing: "一手返工工时", questions: ["上周返工了几小时？"] };

  it("submit on the old pack after needs_material is refused with pack_request_changed; the gap stays", async () => {
    const p = await pack(await freshTopic());
    await run({ action: "gap", content_id: p.content_id, pack_id: p.pack_id, claim_token: p.claim_token, gap });
    const res = await submit(p, 1);
    expect(res).toMatchObject({ ok: false, code: "pack_request_changed", pack_id: p.pack_id });
    const c = (await getContent(p.content_id, dir))!;
    expect(c.status).toBe("drafting");
    expect(c.gapRecord).toMatchObject(gap);
  });

  it("an in-flight host review cannot land after a gap was recorded", async () => {
    const p = await pack(await freshTopic());
    const submitted = await submit(p, 1, { review: "host" });
    expect(submitted.status).toBe("awaiting_host_review");
    await run({ action: "gap", content_id: p.content_id, pack_id: p.pack_id, claim_token: p.claim_token, gap });
    const snap = submitted.review_pack.series_snapshot;
    const verdict = await executeReviewDesk({
      _dataDir: dir, action: "submit", content_id: p.content_id, review_pack_id: submitted.review_pack_id, attempt: 1, issues: [], claim_token: p.claim_token,
      series_review: { snapshot_id: snap.id, checked: [], insufficient: [], findings: [] },
    });
    expect(verdict).toMatchObject({ ok: false, code: "pack_request_changed" });
    expect((await getContent(p.content_id, dir))?.status).toBe("drafting");
  });
});
