/**
 * Codex 审 Phase 1 的修复：过期派生稿出不了任何发布出口、源成片文件被改要算过期、
 * 幂等不靠扫描、只勾 X 的英文版只出 X、坏掉的源不拖垮看板、回收站里的源不能派生。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, listContents } from "../../storage/local-store.js";
import { contentFile, contentRoot } from "../../storage/content-project.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderDecision } from "../production/decisions.js";
import { founderApprove, makeEnv, put, record, setContent, videoContent, waiveSliverCheck, type Env } from "../production/testkit.js";
import { boardData } from "../../desktop/board-data.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { executePublish } from "../../tools/publish.js";
import { executePrePublish, executePrePublishTool } from "../../tools/pre-publish.js";
import { deriveSibling, staleReason } from "./lineage.js";

let env: Env;
afterEach(async () => { await env.cleanup(); });

async function pick(platforms: string[]) { await initProfile(env.dir); await updateProfile({ platforms }, env.dir); }

async function legacySource(platforms = ["douyin", "wechat_mp", "youtube", "x"]) {
  env = await makeEnv();
  await pick(platforms);
  const c = await videoContent(env, "深度思考开到 max");
  return setContent(env, c.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
}

async function derived(sourceId: string, kind: "en_edition" | "wechat_article") {
  const r = await deriveSibling(sourceId, kind, env.dir);
  if (!r.ok) throw new Error(r.error);
  return r.content;
}

/** 本体启用、成片已批的源稿 */
async function ontologySource() {
  env = await makeEnv({ enabled: true });
  await pick(["douyin", "wechat_mp", "youtube"]);
  const c = await videoContent(env, "AI 又忘了怎么办");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
  const f = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "AI又忘了怎么办.mp4"), "cut-v1"), request_id: "c", review: true });
  const fact = (await readProductionDoc(c.id, env.dir))!.facts.find((x) => x.id === f.fact_id)!;
  await waiveSliverCheck(env, c.id, fact.sha256!);
  expect(await founderDecision(c.id, "approve_cut", { fact_id: f.fact_id, sha256: fact.sha256 }, env.dir)).toMatchObject({ ok: true });
  return { c, fact };
}

describe("P1 过期派生稿过不了任何发布出口", () => {
  it("clipboard / ego_lite_prepare / wechat_mp_draft / pre_publish check / video_kit 都拒，原因是中文", async () => {
    const src = await legacySource();
    const article = await derived(src.id, "wechat_article");
    const en = await derived(src.id, "en_edition");
    await setContent(env, src.id, { videoDone: { renderedRevision: 2, at: new Date().toISOString() } });
    for (const action of ["clipboard", "ego_lite_prepare", "wechat_mp_draft"]) {
      const r = await executePublish({ action, content_id: article.id, _dataDir: env.dir }) as Record<string, unknown>;
      expect(r, action).toMatchObject({ ok: false, code: "derived_stale" });
      expect(String(r.error)).toMatch(/过期了，不能发/);
    }
    expect(await executePrePublish({ action: "check", content_id: article.id, _dataDir: env.dir })).toMatchObject({ ok: false, code: "derived_stale" });
    expect(await executePrePublishTool({ action: "video_kit", content_id: en.id, platform: "youtube", _dataDir: env.dir })).toMatchObject({ ok: false, code: "derived_stale" });
  });
});

describe("P2 源成片文件被覆盖 / 删掉", () => {
  it("批准记录还在但文件字节变了：已派生的读成过期，新派生被拒", async () => {
    const { c, fact } = await ontologySource();
    const article = await derived(c.id, "wechat_article");
    expect(await staleReason(article, env.dir, { fresh: true })).toBeNull();

    const abs = path.isAbsolute(fact.path!) ? fact.path! : path.join(contentRoot(c.id, env.dir), fact.path!);
    await put(abs, "overwritten-bytes");
    expect(await staleReason(article, env.dir, { fresh: true })).toMatch(/字节变了/);
    expect(await deriveSibling(c.id, "en_edition", env.dir)).toMatchObject({ ok: false, code: "no_approved_cut" });
  });
});

describe("P2 幂等", () => {
  it("同一资料目录写法不同（带尾斜杠）并发派生也只建一条", async () => {
    const src = await legacySource();
    const [a, b] = await Promise.all([deriveSibling(src.id, "wechat_article", env.dir), deriveSibling(src.id, "wechat_article", `${env.dir}/`)]);
    expect(a.ok && b.ok && a.content.id === b.content.id).toBe(true);
    expect((await listContents(env.dir)).filter((c) => c.derivedFrom?.kind === "wechat_article")).toHaveLength(1);
  });

  it("挂着的兄弟稿读不出来：报错，不再建一条", async () => {
    const src = await legacySource();
    const article = await derived(src.id, "wechat_article");
    await fs.writeFile(contentFile(article.id, env.dir, "meta.json"), "{ broken");
    const r = await deriveSibling(src.id, "wechat_article", env.dir);
    expect(r).toMatchObject({ ok: false, code: "sibling_unreadable" });
    expect((await getContent(src.id, env.dir))!.siblings).toEqual([article.id]);
  });
});

describe("P2 英文版只给勾了的平台", () => {
  it("只勾 X：英文版落在 x，发布包不收 youtube，看板只列 x", async () => {
    const src = await legacySource(["douyin", "twitter"]);
    const en = await derived(src.id, "en_edition");
    expect(en.platform).toBe("x");
    const r = await executePrePublishTool({ action: "video_kit", content_id: en.id, platform: "youtube", _dataDir: env.dir });
    expect(r).toMatchObject({ ok: false, code: "platform_required" });
    expect(String((r as { error: string }).error)).toContain("（x；");
    expect((await boardData(env.dir)).items.find((i) => i.id === en.id)?.kitPlatforms).toEqual(["x"]);
    expect((await boardData(env.dir)).items.find((i) => i.id === src.id)?.kitPlatforms).toEqual(["douyin", "wechat_video", "xiaohongshu", "bilibili"]);
  });
});

describe("P2 看板与回收站", () => {
  it("源稿 production.json 坏了：看板照常出，派生卡标「来源状态读不出来」", async () => {
    const { c } = await ontologySource();
    const article = await derived(c.id, "wechat_article");
    await fs.writeFile(contentFile(c.id, env.dir, "production.json"), "{ broken");
    const board = await boardData(env.dir);
    expect(board.items.find((i) => i.id === article.id)?.derivedStale).toMatch(/来源状态读不出来/);
  });

  it("回收站里的源稿不能派生", async () => {
    const src = await legacySource();
    await setContent(env, src.id, { deletedAt: new Date().toISOString() });
    expect(await deriveSibling(src.id, "wechat_article", env.dir)).toMatchObject({ ok: false, code: "source_deleted" });
  });
});
