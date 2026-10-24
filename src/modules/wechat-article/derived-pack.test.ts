/**
 * 派生公众号文章领写作包（2026-10-24 创始人定：派生文章直接复用源视频的调研台账，不开新调研任务）。
 * 边界：选题已有另一个平台的调研任务 → 照领包、源任务原样；源视频没调研 → 照领包并写明；
 * 非派生稿照旧走写前准备；旧流程导入的老视频底稿说明说人话。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeEnv, setContent, videoContent, type Env } from "../production/testkit.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { executeWechatArticle } from "../../tools/wechat-article.js";
import { executeWriter } from "../../tools/writer.js";
import { packPreparation } from "../../tools/writer-prepare.js";
import { readPack } from "../../tools/writer-pack.js";
import { asFounder } from "../research/angle-gate.test-helper.js";
import { BRIEF_SCHEMA_VERSION, saveBrief, type ResearchBrief } from "../research/brief-store.js";
import { getJob, pendingPerspectives, topicHashOf, upsertJob } from "../research/research-job-store.js";
import { createCreativeTask } from "../writing/creative-task.js";
import { saveTopic } from "../../storage/local-store.js";
import { NO_RESEARCH_NOTE } from "./writer-request.js";
import { articleSource, LEGACY_IMPORT_NOTE } from "./source.js";

let env: Env;
afterEach(async () => { await env.cleanup(); });

const TITLE = "深度思考开到 max";
const DESC = "什么时候该开深度思考";

async function setup(opts: { research: boolean }) {
  env = await makeEnv();
  await fs.writeFile(path.join(env.dir, "engine.json"), JSON.stringify({ apiKey: "sk-test", strongModel: "m", fastModel: "m" }));
  await initProfile(env.dir);
  await updateProfile({ platforms: ["douyin", "wechat_mp"] }, env.dir);
  const topic = await saveTopic({ title: TITLE, description: DESC, tags: [] }, env.dir);
  if (opts.research) {
    const brief: ResearchBrief = {
      schemaVersion: BRIEF_SCHEMA_VERSION, summary: "s", perspectives: [], tensions: [], angleSuggestions: [], angleCards: [],
      evidence: [{ claim: "c", quote: "q", sourceUrl: "https://example.com/r" }], assetPicks: [], missingPerspectives: [], gaps: [],
      generatedAt: "2026-10-01T10:00:00.000Z", revision: 1, topicHash: topicHashOf(TITLE, DESC), creativeTask: createCreativeTask({ platform: "douyin" }),
    };
    await saveBrief(topic.id, brief, env.dir);
    await upsertJob({ topicId: topic.id, status: "succeeded", startedAt: "2026-10-01T09:00:00.000Z", settledAt: "2026-10-01T10:00:00.000Z",
      perspectives: pendingPerspectives(), briefRevision: 1, topicHash: topicHashOf(TITLE, DESC), creativeTask: brief.creativeTask }, env.dir);
  }
  const c = await videoContent(env, TITLE, "draft_ready", "源视频的定稿正文，提到 370 次。", { topicId: topic.id });
  const src = await setContent(env, c.id, {
    videoDone: { renderedRevision: 1, at: new Date().toISOString() },
    ...(opts.research ? { evidenceLedger: { entries: [{ id: "ev-1", source: "verified_quote", claim: "c", quote: "q", sourceUrl: "https://example.com/r" }], lookups: [], budget: { max: 3, used: 0 } } } : {}),
  });
  const derived = await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id });
  expect(derived).toMatchObject({ ok: true });
  return { topicId: topic.id, articleId: String(derived.content_id) };
}

const writer = async (params: Record<string, unknown>) => {
  await asFounder(env.dir, params);
  return executeWriter({ ...params, _dataDir: env.dir }, { onWarn: () => {} }) as Promise<Record<string, any>>;
};

async function pack(topicId: string, contentId?: string) {
  const r = await writer({ action: "pack", topic_id: topicId, platform: "wechat_mp", ...(contentId ? { content_id: contentId } : {}), requirements: "写给不写代码的人" });
  if (r.ok === false || r.status === "ready") return r;
  await packPreparation(String(r.content_id));
  return writer({ action: "pack_status", content_id: r.content_id });
}

describe("派生文章领包：复用源视频的调研，不动选题上的调研任务", () => {
  it("选题已有抖音调研任务 → 包照领，源任务同一份、视角不变；源台账进本包的账", async () => {
    const { topicId, articleId } = await setup({ research: true });
    const before = await getJob(topicId, env.dir);
    const r = await pack(topicId, articleId);
    expect(r).toMatchObject({ status: "ready", content_id: articleId });
    const after = await getJob(topicId, env.dir);
    expect(after).toEqual(before);
    expect(after?.creativeTask?.platform).toBe("douyin");
    const file = (await readPack(articleId, env.dir)) as any;
    expect(file.ledger.entries.map((e: { id: string }) => e.id)).toContain("ev-1");
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

describe("旧流程导入的老视频：底稿说明说人话", () => {
  it("本体启用、有 videoDone、从没审过片 → 说明是「老视频没登记成片字幕」", async () => {
    env = await makeEnv({ enabled: true });
    const c = await videoContent(env, TITLE);
    const src = await setContent(env, c.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
    const s = await articleSource({ derivedFrom: { kind: "wechat_article", contentId: src.id } as any }, env.dir);
    expect(s).toMatchObject({ ok: true, source: { kind: "script", note: LEGACY_IMPORT_NOTE } });
  });
});
