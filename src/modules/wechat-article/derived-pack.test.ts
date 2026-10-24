/**
 * 派生公众号文章领写作包（2026-10-24 创始人定：派生文章直接复用源视频的调研台账，不开新调研任务）。
 * 边界：选题已有另一个平台的调研任务 → 照领包、源任务原样；源视频没调研 → 照领包并写明；
 * 非派生稿照旧走写前准备；旧流程导入的老视频底稿说明说人话。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeEnv, setContent, videoContent, type Env } from "../production/testkit.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { executeWechatArticle } from "../../tools/wechat-article.js";
import { executeWriter } from "../../tools/writer.js";
import { packPreparation } from "../../tools/writer-prepare.js";
import { readPack } from "../../tools/writer-pack.js";
import { asFounder } from "../research/angle-gate.test-helper.js";
import { BRIEF_SCHEMA_VERSION, saveBrief, type AngleCardV3, type ResearchBrief } from "../research/brief-store.js";
import { getJob, pendingPerspectives, topicHashOf, upsertJob } from "../research/research-job-store.js";
import { createCreativeTask } from "../writing/creative-task.js";
import { saveTopic, updateTopic, updateContent, getContent } from "../../storage/local-store.js";
import { buildWritingContext } from "../writing/generate-script.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";
import { NO_RESEARCH_NOTE } from "./writer-request.js";
import { articleSource, LEGACY_IMPORT_NOTE } from "./source.js";
// 审阅页的真排版要 uv + 排版脚本，这里只测包与审阅页其余部分（真排版见 preview-format.test.ts）
vi.mock("./preview-format.js", () => ({ formatArticleBodyCached: async (i: { theme: string }) => ({ ok: true, theme: i.theme, html: "<p>排版后的正文</p>" }) }));

let env: Env;
afterEach(async () => { await env.cleanup(); });

const TITLE = "深度思考开到 max";
const DESC = "什么时候该开深度思考";

const CARD: AngleCardV3 = {
  cardVersion: 3, id: "angle-1", angle: "开不开看活", thesis: "深度思考不是越大越好", evidenceLevel: "grounded",
  coreEvidenceIds: ["ev-1"], antiScope: "不写评测", hookDraft: "开到 max 反而慢。", primaryPersona: "grow",
  misconception: "以为越深越好", mechanism: "简单活多想只是多等", payoff: "按活选档", nextAction: "今天试一次低档",
  counterResponse: "难题照开", personaGains: { grow: "a", trust: "b", convert: "c" },
  elements: ["新奇点"], evidenceNeeds: [], structure: "myth-busting", score: 4, scoreReasons: ["有简报证据"],
};

/** angle：选题简报是旧格式（没存创作任务）且创始人选了卡——创始人真实那条视频就是这样 */
async function setup(opts: { research: boolean; angle?: boolean }) {
  env = await makeEnv();
  await fs.writeFile(path.join(env.dir, "engine.json"), JSON.stringify({ apiKey: "sk-test", strongModel: "m", fastModel: "m" }));
  await initProfile(env.dir);
  await updateProfile({ platforms: ["douyin", "wechat_mp"] }, env.dir);
  const topic = await saveTopic({ title: TITLE, description: DESC, tags: [] }, env.dir);
  if (opts.research) {
    const brief: ResearchBrief = {
      schemaVersion: BRIEF_SCHEMA_VERSION, summary: "s", perspectives: [], tensions: [], angleSuggestions: [], angleCards: [],
      evidence: [{ claim: "c", quote: "q", sourceUrl: "https://example.com/r" }], assetPicks: [], missingPerspectives: [], gaps: [],
      generatedAt: "2026-10-01T10:00:00.000Z", revision: 1, topicHash: topicHashOf(TITLE, DESC),
      ...(opts.angle ? { angleCards: [CARD], evidence: [{ claim: "简报里别的证据", quote: "不该进文章的简报原句", sourceUrl: "https://example.com/other" }] } : { creativeTask: createCreativeTask({ platform: "douyin" }) }),
    };
    await saveBrief(topic.id, brief, env.dir);
    await upsertJob({ topicId: topic.id, status: "succeeded", startedAt: "2026-10-01T09:00:00.000Z", settledAt: "2026-10-01T10:00:00.000Z",
      perspectives: pendingPerspectives(), briefRevision: 1, topicHash: topicHashOf(TITLE, DESC), creativeTask: brief.creativeTask }, env.dir);
    if (opts.angle) await updateTopic(topic.id, { selectedAngle: { briefRevision: 1, angleId: CARD.id, card: CARD, selectedAt: "2026-10-01T11:00:00.000Z" } }, env.dir);
  }
  const c = await videoContent(env, TITLE, "draft_ready", "源视频的定稿正文，提到 370 次。", { topicId: topic.id });
  const src = await setContent(env, c.id, {
    videoDone: { renderedRevision: 1, at: new Date().toISOString() },
    ...(opts.research ? { evidenceLedger: { entries: [{ id: "ev-1", source: "verified_quote", claim: "c", quote: "q", sourceUrl: "https://example.com/r" }], lookups: [], budget: { max: 3, used: 0 } } } : {}),
  });
  const derived = await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id });
  expect(derived).toMatchObject({ ok: true });
  return { topicId: topic.id, articleId: String(derived.content_id), srcId: src.id };
}

const writer = async (params: Record<string, unknown>, deps: Record<string, unknown> = {}) => {
  await asFounder(env.dir, params);
  return executeWriter({ ...params, _dataDir: env.dir }, { onWarn: () => {}, ...deps }) as Promise<Record<string, any>>;
};

async function pack(topicId: string, contentId?: string, deps: Record<string, unknown> = {}) {
  const r = await writer({ action: "pack", topic_id: topicId, platform: "wechat_mp", ...(contentId ? { content_id: contentId } : {}), requirements: "写给不写代码的人" }, deps);
  if (r.ok === false || r.status === "ready") return r;
  await packPreparation(String(r.content_id));
  return writer({ action: "pack_status", content_id: r.content_id });
}

describe("派生文章领包：复用源视频的调研，不动选题上的调研任务", () => {
  it("选题已有抖音调研任务 → 包照领，源任务同一份、视角不变；源台账进本包的账", async () => {
    const { topicId, articleId, srcId } = await setup({ research: true });
    const before = await getJob(topicId, env.dir);
    const r = await pack(topicId, articleId);
    expect(r).toMatchObject({ status: "ready", content_id: articleId });
    const after = await getJob(topicId, env.dir);
    expect(after).toEqual(before);
    expect(after?.creativeTask?.platform).toBe("douyin");
    const file = (await readPack(articleId, env.dir)) as any;
    expect(file.ledger.entries.map((e: { id: string }) => e.id)).toContain(`src:${srcId}:ev-1`);
    expect(file.context?.readiness?.research?.reason).toMatch(/复用源视频的调研台账/);
  });

  it("源视频没调研 → 包照领，写明只靠底稿", async () => {
    const { topicId, articleId } = await setup({ research: false });
    const r = await pack(topicId, articleId);
    expect(r).toMatchObject({ status: "ready" });
    expect(await getJob(topicId, env.dir)).toBeNull();
    expect(JSON.stringify(r)).toContain(NO_RESEARCH_NOTE.slice(0, 12));
  });

  it("非派生的公众号稿照旧走写前准备：平台不同 → writing_not_prepared", async () => {
    const { topicId } = await setup({ research: true });
    expect(await pack(topicId)).toMatchObject({ ok: false, code: "writing_not_prepared" });
  });
});

describe("Codex 复审三条", () => {
  it("选题有旧格式简报 + 选中的卡：包照领、带上源视频的立意；简报证据不进包", async () => {
    const { topicId, articleId, srcId } = await setup({ research: true, angle: true });
    expect(await pack(topicId, articleId)).toMatchObject({ status: "ready" });
    const file = (await readPack(articleId, env.dir)) as any;
    expect(file.context.readiness.angle).toMatchObject({ status: "selected", selectedAngleId: "angle-1" });
    expect(file.context.angleCard?.thesis).toBe(CARD.thesis);
    const quotes = file.ledger.entries.map((e: { quote: string }) => e.quote);
    expect(quotes).not.toContain("不该进文章的简报原句");
    expect(file.ledger.entries.map((e: { id: string }) => e.id)).toContain(`src:${srcId}:ev-1`);
  });

  it("源台账编号带命名空间：和本文自己的 ev-1 不撞号，两条都在", async () => {
    const { topicId, articleId, srcId } = await setup({ research: true });
    const r = await pack(topicId, articleId, {
      buildContextImpl: async (...a: Parameters<typeof buildWritingContext>) => {
        const built = await buildWritingContext(...a);
        built.inputs.ledger.add({ id: "ev-1", source: "user_claim", quote: "本文自己的 ev-1" });
        return built;
      },
    });
    expect(r).toMatchObject({ status: "ready" });
    const entries = ((await readPack(articleId, env.dir)) as any).ledger.entries as Array<{ id: string; quote: string }>;
    expect(entries.find((e) => e.id === "ev-1")?.quote).toBe("本文自己的 ev-1");
    expect(entries.find((e) => e.id === `src:${srcId}:ev-1`)?.quote).toBe("q");
  });

  it("源只读一次：备料期间源台账变了，包账仍是领包那一刻的快照（与写作要求一致）", async () => {
    const { topicId, articleId, srcId } = await setup({ research: true });
    const r = await pack(topicId, articleId, {
      buildContextImpl: async (...a: Parameters<typeof buildWritingContext>) => {
        await updateContent(srcId, { _provenance: HUMAN_WRITE, evidenceLedger: { entries: [{ id: "ev-9", source: "verified_quote", quote: "后来才加的" }], lookups: [], budget: { max: 3, used: 0 } } } as any, env.dir);
        return buildWritingContext(...a);
      },
    });
    expect(r).toMatchObject({ status: "ready" });
    const file = (await readPack(articleId, env.dir)) as any;
    const ids = file.ledger.entries.map((e: { id: string }) => e.id);
    expect(ids).toContain(`src:${srcId}:ev-1`);
    expect(ids).not.toContain(`src:${srcId}:ev-9`);
    expect(file.context.req.requirements).toContain(`[src:${srcId}:ev-1]`);
  });

  it("源视频删了 → 领包明确失败（source_missing），不悄悄当没台账", async () => {
    const { topicId, articleId, srcId } = await setup({ research: true });
    await updateContent(srcId, { _provenance: HUMAN_WRITE, deletedAt: new Date().toISOString() } as any, env.dir);
    expect(await getContent(srcId, env.dir)).toBeTruthy();
    expect(await pack(topicId, articleId)).toMatchObject({ ok: false, code: "source_missing" });
  });
});

describe("旧流程导入的老视频：底稿说明说人话", () => {
  it("本体启用、有 videoDone、从没审过片 → 说明是「老视频没登记成片字幕」", async () => {
    env = await makeEnv({ enabled: true });
    const c = await videoContent(env, TITLE);
    const src = await setContent(env, c.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
    const s = await articleSource({ derivedFrom: { kind: "wechat_article", contentId: src.id } as any }, env.dir);
    expect(s).toMatchObject({ ok: true, source: { kind: "script", note: LEGACY_IMPORT_NOTE } });
  });
});
