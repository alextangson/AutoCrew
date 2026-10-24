/**
 * Phase 2b 验收：封面主图 + 裁切、按批过的整包推草稿箱（幂等 / 作废旧草稿 / 原始报错）、
 * 视频号未公开就等、排期与群发额度顺延、结果不明先核对。推送脚本一律打桩，不碰真实公众号。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

vi.mock("../publish/wechat-mp.js", () => ({ generateWechatImageAsset: vi.fn(), publishWechatMpDraft: vi.fn() }));

import { generateWechatImageAsset, type WechatMpDraftOptions, type WechatMpDraftResult } from "../publish/wechat-mp.js";
import { makeEnv, png, put, setContent, videoContent, type Env } from "../production/testkit.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { readInbox } from "../production/inbox-read.js";
import { decideItem } from "../production/inbox-decide.js";
import { executeWechatArticle } from "../../tools/wechat-article.js";
import { executePublish } from "../../tools/publish.js";
import { getContent } from "../../storage/local-store.js";
import { parseShanghai } from "./slot.js";
import { writePublishState } from "./publish-state.js";
import { readArticlePackage, writeArticlePackage } from "./package.js";
import { centeredCrop, cropParam, parseCrop } from "./cover.js";
import { planSlot, hostSlot } from "./slot.js";
import { readPublishState } from "./publish-state.js";
import { resolveContentProject } from "../../storage/content-project.js";

const genMock = vi.mocked(generateWechatImageAsset);
const NOW = new Date("2026-10-24T10:00:00+08:00");
const now = () => NOW;
let env: Env;
let srcId: string;
let id: string;
let pushes: WechatMpDraftOptions[];
let nextResult: Partial<WechatMpDraftResult>;
const publishImpl = vi.fn(async (o: WechatMpDraftOptions): Promise<WechatMpDraftResult> => {
  pushes.push({ ...o, articleText: await fs.readFile(o.articlePath, "utf8") } as WechatMpDraftOptions);
  return { ok: true, articlePath: o.articlePath, publishInput: o.articlePath, coverPath: o.coverPath ?? "", imageCount: 2, generatedImages: [], mediaId: `MID-${pushes.length}`, ...nextResult };
});

const BODY = `## 开头\n${"字".repeat(2600)}\n\n[IMAGE: gen: 概念示意]\n\n## 第二节\n官方页面长这样\n\n[IMAGE: web: OpenAI 定价页截图]`;
const run = (p: Record<string, unknown>) => executeWechatArticle({ _dataDir: env.dir, content_id: id, ...p }, { publishImpl, now });

beforeEach(async () => {
  env = await makeEnv();
  pushes = [];
  nextResult = {};
  publishImpl.mockClear();
  await initProfile(env.dir);
  await updateProfile({ platforms: ["douyin", "wechat_mp"] }, env.dir);
  const src = await videoContent(env, "深度思考开到 max", "draft_ready", "源正文", { topicId: "topic-1-abc" });
  srcId = src.id;
  await setContent(env, src.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
  id = String((await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
  await setContent(env, id, { body: BODY, status: "draft_ready" });
  genMock.mockReset();
  genMock.mockImplementation(async (_p, out) => {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, png(16, 9, "gen"));
    return { ok: true, stdout: "", stderr: "", provider: "codex", providerKind: "codex" };
  });
});
afterEach(async () => { await env.cleanup(); });

async function complete(cover = png(2350, 1000, "m")) {
  await run({ op: "set_titles", titles: ["标题一", "标题二", "标题三"] });
  await run({ op: "choose_title", index: 2, founder_quote: "用第二个" });
  await run({ op: "generate_images" });
  const shot = await put(path.join(env.outside, "shot.png"), png(1200, 800, "web"));
  await run({ op: "attach_web_image", index: 2, path: shot, url: "https://openai.com/pricing", credit: "图源：OpenAI 官网" });
  expect(await run({ op: "set_cover", path: await put(path.join(env.outside, "cover.png"), cover) })).toMatchObject({ ok: true });
  await run({ op: "set_creation_source", creation_source: "内容由AI生成", founder_quote: "就选 AI 生成" });
}
async function approve() {
  const d = (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === id)!;
  return decideItem({ item_id: d.item_id, gen: d.gen, action: "approve_script", content_id: id }, env.dir);
}
/** 源视频的发布计划：视频号状态 + 时间 */
async function videoChannel(status: string, publishedAt?: string) {
  const root = resolveContentProject(srcId, env.dir)!.project_root;
  const plan = { platforms: [{ platform: "wechat_video", publication: { status, ...(publishedAt ? { published_at: publishedAt } : {}) } }] };
  await put(path.join(root, "06-publish/publish-plan.json"), JSON.stringify(plan));
}

describe("封面 = 一张主图 + 两个裁切", () => {
  it("默认裁切：宽图取居中正方形与整高 2.35 横条；方图取居中横条；写法 X1_Y1_X2_Y2", () => {
    expect(cropParam(centeredCrop(2350, 1000, "2.35:1"))).toBe("0_0_1_1");
    const sq = centeredCrop(2350, 1000, "1:1");
    expect(sq.y1).toBe(0); expect(sq.y2).toBe(1);
    expect((sq.x2 - sq.x1) * 2350).toBeCloseTo(1000, 0);
    expect((sq.x1 + sq.x2) / 2).toBeCloseTo(0.5, 6);
    const band = centeredCrop(1000, 1000, "2.35:1");
    expect(band).toMatchObject({ x1: 0, x2: 1 });
    expect((band.y2 - band.y1) * 1000 * 2.35).toBeCloseTo(1000, 0);
    expect(cropParam(centeredCrop(3000, 1000, "2.35:1"))).toBe("0.108333_0_0.891667_1");
  });

  it("自定裁切要比例对得上；登记时只收一张主图，带 ratio 的旧调用被拒；WebP 不收", async () => {
    expect(parseCrop("0_0_0.5_1", "1:1", 2000, 1000)).toEqual({ x1: 0, y1: 0, x2: 0.5, y2: 1 });
    expect(typeof parseCrop("0_0_1_1", "1:1", 2000, 1000)).toBe("string");
    expect(typeof parseCrop([0, 0, 2, 1], "1:1", 2000, 1000)).toBe("string");
    expect(await run({ op: "set_cover", ratio: "1:1", path: "/x.png" })).toMatchObject({ ok: false, code: "invalid_params" });
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(30)]);
    expect(await run({ op: "set_cover", path: await put(path.join(env.outside, "c.webp"), webp) })).toMatchObject({ ok: false, code: "cover_unreadable" });
    const r = await run({ op: "set_cover", path: await put(path.join(env.outside, "c.png"), png(2000, 1000)), crop_1_1: "0_0_0.5_1" });
    expect(r).toMatchObject({ ok: true, cover: { crop_1_1: "0_0_0.5_1", crop_235: expect.any(String) } });
  });

  it("裁切进指纹：批后只改裁切，批准就失效；审阅页按主图画出两种裁切", async () => {
    await complete();
    expect(await approve()).toMatchObject({ ok: true });
    const status = await run({ op: "status" });
    const html = await fs.readFile(String(status.preview_page), "utf8");
    expect(html).toContain("2.35:1（0_0_1_1）");
    expect(html).toMatch(/1:1（0\.287234_0_0\.712766_1）/);
    await run({ op: "set_cover", path: (await readArticlePackage(id, env.dir)).cover!.path, crop_1_1: "0_0_0.425532_1" });
    expect((await run({ op: "status" })).approval).toMatch(/批准已失效/);
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "article_not_approved" });
  });

  it("2a 留下的两张封面：明确拒，要求重登一张主图，不替他挑", async () => {
    await complete();
    const pkg = await readArticlePackage(id, env.dir);
    await writeArticlePackage(id, { ...pkg, cover: undefined, covers: [{ ratio: "2.35:1", path: pkg.cover!.path, sha256: pkg.cover!.sha256 }, { ratio: "1:1", path: pkg.cover!.path, sha256: pkg.cover!.sha256 }] }, env.dir);
    expect((await run({ op: "status" })).problems).toEqual(expect.arrayContaining([expect.stringMatching(/两张独立封面.*一张主图/)]));
    expect(await approve()).toMatchObject({ ok: false, code: "article_not_ready" });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false });
    expect(publishImpl).not.toHaveBeenCalled();
  });
});

describe("推草稿箱：只推批过的那一包", () => {
  it("没批 / 源视频换版 → 拒，不调推送脚本", async () => {
    await complete();
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "article_not_approved" });
    await approve();
    await setContent(env, srcId, { videoDone: { renderedRevision: 2, at: new Date().toISOString() } });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "derived_stale" });
    expect(await executePublish({ action: "wechat_mp_draft", content_id: id, _dataDir: env.dir }, { publishImpl })).toMatchObject({ ok: false, code: "derived_stale" });
    expect(publishImpl).not.toHaveBeenCalled();
  });

  it("推的是选定标题、主图 + 两个裁切、web 图署名、设置里的署名（不落回脚本默认作者）、严格出图", async () => {
    await complete();
    await approve();
    const r = await run({ op: "push_draft" });
    expect(r).toMatchObject({ ok: true, reused: false, media_id: "MID-1", phase: "pushed_draft" });
    const o = pushes[0] as WechatMpDraftOptions & { articleText: string };
    expect(o).toMatchObject({ title: "标题二", coverCrops: { crop235: "0_0_1_1", crop11: "0.287234_0_0.712766_1" }, author: "", strictImages: true, skipImages: true });
    expect(o.coverPath).toMatch(/wechat-push/);
    expect(await fs.readFile(o.coverPath!)).toEqual(await fs.readFile((await readArticlePackage(id, env.dir)).cover!.path));
    expect(o.preparedImages).toHaveLength(2);
    expect(o.preparedImages!.every((p) => p.startsWith(path.dirname(o.articlePath)))).toBe(true);
    expect(o.articleText).toMatch(/^# 标题二\n/);
    expect(o.articleText).toMatch(/\[IMAGE: web: OpenAI 定价页截图\]\n\n\*图源：OpenAI 官网\*/);
    expect(o.articleText).not.toMatch(/概念示意\]\n\n\*/);
  });

  it("同一包推两次 → 只有一份草稿；桌面 / 旧出口 wechat_mp_draft 也走同一条路", async () => {
    await complete();
    await approve();
    await run({ op: "push_draft" });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: true, reused: true, media_id: "MID-1" });
    expect(await executePublish({ action: "wechat_mp_draft", content_id: id, _dataDir: env.dir }, { publishImpl })).toMatchObject({ ok: true, reused: true });
    expect(publishImpl).toHaveBeenCalledTimes(1);
  });

  it("推后包变了 → 没重批就拒；重批后推新的一份，旧草稿标作废并告诉创始人，不删", async () => {
    await complete();
    await approve();
    await run({ op: "push_draft" });
    expect(await run({ op: "choose_title", index: 3, founder_quote: "还是第三个" })).toMatchObject({ ok: true, reopened_for_review: expect.stringMatching(/退回「等你拍板」/) });
    expect((await getContent(id, env.dir))!.status).toBe("draft_ready");
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "article_not_approved" });
    expect((await run({ op: "publish_status" })).publish_blocked).toMatch(/批准已失效/);
    expect(await approve()).toMatchObject({ ok: true });
    expect((await run({ op: "publish_status" })).draft_is_current_package).toBe(false);
    expect(await run({ op: "begin_editor" })).toMatchObject({ ok: false, code: "draft_superseded" });
    const r = await run({ op: "push_draft" });
    expect(r).toMatchObject({ ok: true, media_id: "MID-2", superseded_draft: "MID-1", superseded_note: expect.stringMatching(/删不删由你/) });
    expect(pushes[1].title).toBe("标题三");
    expect((await readPublishState(id, env.dir)).superseded).toEqual([expect.objectContaining({ mediaId: "MID-1" })]);
  });

  it("API 报错 → 原始报错照给、状态 failed、不出复制件；修好后可以重推", async () => {
    await complete();
    await approve();
    nextResult = { ok: false, mediaId: undefined, error: "公众号推送失败：错误: 获取 access_token 失败 (errcode=40164: invalid ip)；→ IP 不在白名单中", stderr: "" };
    const r = await run({ op: "push_draft" });
    expect(r).toMatchObject({ ok: false, code: "push_failed", phase: "failed", error: expect.stringContaining("40164") });
    expect(JSON.stringify(r)).not.toMatch(/clipboard|复制件/);
    expect((await readPublishState(id, env.dir)).attempts.at(-1)).toMatchObject({ ok: false, raw: expect.stringContaining("白名单") });
    expect(await executePublish({ action: "clipboard", content_id: id, _dataDir: env.dir })).toMatchObject({ ok: false, code: "derived_article_api_only" });
    nextResult = {};
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: true, media_id: "MID-2" });
  });

  it("脚本成功退出却没报 media_id → unknown，先核对再说", async () => {
    await complete();
    await approve();
    nextResult = { mediaId: undefined, stdout: "发布成功!" };
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "push_unknown", phase: "unknown" });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "reconcile_first" });
    expect(await run({ op: "record_absent", raw: "草稿箱里看到了这篇", found_draft: "true" })).toMatchObject({ ok: false, code: "draft_identity_required" });
    expect(await run({ op: "record_absent", raw: "草稿箱里看到了这篇", found_draft: "true", draft_title: "标题二", draft_updated_at: "2026-10-24 10:00" })).toMatchObject({ ok: true, phase: "pushed_draft" });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: true, reused: true });
    expect(publishImpl).toHaveBeenCalledTimes(1);
  });
});

describe("编辑器收尾：视频号、排期、扫码、结果不明", () => {
  beforeEach(async () => { await complete(); await approve(); await run({ op: "push_draft" }); });

  it("视频号原片没公开 → 等，不排定时；公开后按视频号时间晚 3 小时排", async () => {
    await videoChannel("scheduled");
    expect(await run({ op: "begin_editor" })).toMatchObject({ ok: false, code: "video_not_live", phase: "waiting_video_live", slot: null });
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    expect(await run({ op: "begin_editor" })).toMatchObject({ ok: true, phase: "editor_finishing", slot: { at: "2026-10-24T12:00:00+08:00" }, creation_source: "内容由AI生成", title: "标题二" });
  });

  it("读不到视频号时间 → 要创始人给时间；给的时间要带时区、在 +6 天内、整分钟", async () => {
    await videoChannel("published");
    expect(await run({ op: "begin_editor" })).toMatchObject({ ok: false, code: "slot_required" });
    expect(await run({ op: "begin_editor", slot: "2026-10-25T21:00:00+08:00" })).toMatchObject({ ok: false, code: "founder_words_required" });
    expect(await run({ op: "begin_editor", slot: "2026-11-05T21:00:00+08:00", founder_quote: "下月发" })).toMatchObject({ ok: false, code: "invalid_slot" });
    expect(await run({ op: "begin_editor", slot: "明晚九点", founder_quote: "明晚九点" })).toMatchObject({ ok: false, code: "invalid_slot" });
    expect(await run({ op: "begin_editor", slot: "2026-10-25T21:00:00+08:00", founder_quote: "明晚九点" })).toMatchObject({ ok: true, slot: { at: "2026-10-25T21:00:00+08:00", founderWords: "明晚九点" } });
  });

  it("走完：编辑器定时要和排好的一致 → 等扫码 → 创始人说扫了、核到 → 已定时；扫码前不能记回执", async () => {
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    await run({ op: "begin_editor" });
    expect(await run({ op: "record_scheduled", scheduled_at: "2026-10-24T12:00:00+08:00", founder_quote: "扫了" })).toMatchObject({ ok: false, code: "wrong_phase" });
    expect(await run({ op: "mark_editor_done", scheduled_for: "2026-10-24T13:00:00+08:00" })).toMatchObject({ ok: false, code: "slot_mismatch" });
    expect(await run({ op: "final_check", channels_card_visible: "true" })).toMatchObject({ ok: true, may_click_publish: true });
    expect(await run({ op: "mark_editor_done", scheduled_for: "2026-10-24T04:00:00Z" })).toMatchObject({ ok: true, phase: "scheduled_waiting_scan", hand_off: expect.stringMatching(/handOff/) });
    expect(await run({ op: "record_scheduled", scheduled_at: "2026-10-24T12:00:00+08:00" })).toMatchObject({ ok: false, code: "founder_words_required" });
    const r = await run({ op: "record_scheduled", scheduled_at: "2026-10-24T12:00:00+08:00", founder_quote: "扫好了" });
    expect(r).toMatchObject({ ok: true, phase: "scheduled", receipt: { scheduledAt: "2026-10-24T12:00:00+08:00", founderWords: "扫好了", published: false } });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: true, reused: true });
  });

  it("结果不明 → 只能先核对：推送 / 进编辑器 / 标完成都拒；核到定时就记回执", async () => {
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    await run({ op: "begin_editor" });
    await run({ op: "mark_editor_done", scheduled_for: "2026-10-24T12:00:00+08:00" });
    expect(await run({ op: "record_unknown" })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await run({ op: "record_unknown", raw: "扫码后页面一直转圈" })).toMatchObject({ ok: true, phase: "unknown" });
    for (const op of ["push_draft", "begin_editor", "mark_editor_done"]) expect(await run({ op, scheduled_for: "2026-10-24T12:00:00+08:00" }), op).toMatchObject({ ok: false, code: "reconcile_first" });
    expect((await run({ op: "publish_status" })).next_step).toMatch(/先去编辑器/);
    expect(await run({ op: "record_scheduled", scheduled_at: "2026-10-24T12:00:00+08:00", founder_quote: "我看到定时列表里有了" })).toMatchObject({ ok: true, phase: "scheduled" });
  });

  it("另一篇派生文章已占当天群发 → 顺延到第二天同一时间", async () => {
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    const other = await videoContent(env, "另一条视频", "draft_ready", "x", { topicId: "topic-2-abc" });
    await setContent(env, other.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
    const a2 = String((await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: other.id })).content_id);
    const { writePublishState } = await import("./publish-state.js");
    await writePublishState(a2, { phase: "scheduled", receipt: { scheduledAt: "2026-10-24T20:00:00+08:00", founderWords: "x", published: false, at: "x" }, superseded: [], attempts: [] }, env.dir);
    expect(await run({ op: "begin_editor" })).toMatchObject({ ok: true, slot: { at: "2026-10-25T12:00:00+08:00", basis: expect.stringMatching(/顺延/) } });
  });
});

describe("排期规则", () => {
  const t = (s: string) => Date.parse(s);
  it("晚 3 小时、不过 22:30；已过就挪到最近一天同一时刻；被占就顺延；超出 +6 天拒", () => {
    const n = t("2026-10-24T08:00:00+08:00");
    expect(planSlot(t("2026-10-24T18:00:00+08:00"), n, new Set())).toMatchObject({ at: "2026-10-24T21:00:00+08:00" });
    expect(planSlot(t("2026-10-24T19:30:00+08:00"), n, new Set())).toMatchObject({ at: "2026-10-24T22:30:00+08:00" });
    expect(planSlot(t("2026-10-24T23:45:00+08:00"), n, new Set())).toMatchObject({ at: "2026-10-25T20:00:00+08:00", basis: expect.stringMatching(/第二天晚上 20:00/) });
    expect(planSlot(t("2026-10-24T21:00:00+08:00"), n, new Set())).toMatchObject({ at: "2026-10-25T20:00:00+08:00" });
    expect(planSlot(t("2026-10-22T18:00:00+08:00"), n, new Set())).toMatchObject({ at: "2026-10-24T21:00:00+08:00" });
    expect(planSlot(t("2026-10-24T18:00:00+08:00"), n, new Set(["2026-10-24", "2026-10-25"]))).toMatchObject({ at: "2026-10-26T21:00:00+08:00" });
    const full = new Set(Array.from({ length: 7 }, (_, i) => `2026-10-${24 + i}`));
    expect(planSlot(t("2026-10-24T18:00:00+08:00"), n, full)).toMatchObject({ error: expect.stringMatching(/超出/) });
    expect(hostSlot("2026-10-24T21:00:30+08:00", "x", n, new Set())).toMatchObject({ error: expect.stringMatching(/分钟/) });
    expect(hostSlot("2026-10-24T21:00:00+08:00", "x", n, new Set(["2026-10-24"]))).toMatchObject({ error: expect.stringMatching(/群发通知/) });
  });
});

describe("Codex 审 2b 回归", () => {
  beforeEach(async () => { await complete(); await approve(); });

  it("P1-1 每次推送一个新暂存目录，只装这一包的文件", async () => {
    await run({ op: "push_draft" });
    await run({ op: "set_cover", path: await put(path.join(env.outside, "cover2.png"), png(2350, 1000, "m2")) });
    await approve();
    await run({ op: "push_draft" });
    const [a, b] = pushes.map((o) => path.dirname(o.articlePath));
    expect(a).not.toBe(b);
    expect((await fs.readdir(path.join(b, "src"))).sort()).toEqual(["cover.png", "img-01.png", "img-02.png"]);
    expect(await fs.readdir(b)).not.toContain("images");
  });

  it("P1-2 dry_run 不调公众号、不改状态，回给要推的内容", async () => {
    const r = await executePublish({ action: "wechat_mp_draft", content_id: id, dry_run: true, _dataDir: env.dir }, { publishImpl });
    expect(r).toMatchObject({ ok: true, dry_run: true, title: "标题二", crop_235: "0_0_1_1" });
    expect(publishImpl).not.toHaveBeenCalled();
    expect((await readPublishState(id, env.dir)).phase).toBeUndefined();
  });

  it("P1-3 调脚本前落 in_flight；上次中断留下的 in_flight → unknown，先核对", async () => {
    publishImpl.mockImplementationOnce(async (o) => {
      expect((await readPublishState(id, env.dir)).inFlight).toMatchObject({ startedAt: expect.any(String) });
      return { ok: true, articlePath: o.articlePath, publishInput: o.articlePath, coverPath: "", imageCount: 2, generatedImages: [], mediaId: "MID-X" };
    });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: true, media_id: "MID-X" });
    expect((await readPublishState(id, env.dir)).inFlight).toBeUndefined();
    const st = await readPublishState(id, env.dir);
    await writePublishState(id, { ...st, mediaId: undefined, packageHash: undefined, phase: undefined, inFlight: { packageHash: "h", startedAt: "2026-10-24T01:00:00Z" } }, env.dir);
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "reconcile_first" });
    expect((await readPublishState(id, env.dir)).phase).toBe("unknown");
  });

  it("P1-4 超时 / 进程异常 → unknown；token 失败、明确 errcode → failed", async () => {
    nextResult = { ok: false, mediaId: undefined, error: "公众号推送失败：requests.exceptions.ReadTimeout: Read timed out" };
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "push_unknown", phase: "unknown" });
    await run({ op: "record_absent", raw: "三处都没有" });
    nextResult = { ok: false, mediaId: undefined, error: "公众号推送失败：错误: 推送草稿箱失败 (errcode=45009: reach max api daily quota limit)" };
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "push_failed" });
    publishImpl.mockImplementationOnce(async () => { throw new Error("socket hang up"); });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "push_unknown" });
  });

  it("P1-5 结果不明后记定时要带草稿身份；之后已定时就拦新推送（没有 media_id 也拦）", async () => {
    nextResult = { mediaId: undefined, stdout: "?" };
    await run({ op: "push_draft" });
    expect(await run({ op: "record_scheduled", scheduled_at: "2026-10-24T21:00:00+08:00", founder_quote: "扫了" })).toMatchObject({ ok: false, code: "draft_identity_required" });
    expect(await run({ op: "record_scheduled", scheduled_at: "2026-10-24T21:00:00+08:00", founder_quote: "扫了", draft_title: "标题二", draft_updated_at: "2026-10-24 10:00" })).toMatchObject({ ok: true, phase: "scheduled" });
    expect((await readPublishState(id, env.dir)).foundDraft).toEqual({ title: "标题二", updatedAt: "2026-10-24 10:00" });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: true, reused: true });
    await run({ op: "choose_title", index: 1, founder_quote: "换回第一个" });
    await approve();
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: false, code: "already_committed" });
  });

  it("P1-6 begin_editor 给出草稿身份：media_id、更新时间、首末段", async () => {
    await run({ op: "push_draft" });
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    const r = await run({ op: "begin_editor" });
    expect(r.draft_identity).toMatchObject({ media_id: "MID-1", updated_at: "2026-10-24T10:00:00+08:00", first_paragraph: expect.stringMatching(/^字+$/), last_paragraph: "官方页面长这样" });
  });

  it("P1-7 编辑器收尾期间包变了：final_check 不许点发表；mark_editor_done 复核不过进 unknown", async () => {
    await run({ op: "push_draft" });
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    await run({ op: "begin_editor" });
    await run({ op: "choose_title", index: 1, founder_quote: "换第一个" });
    expect(await run({ op: "final_check" })).toMatchObject({ ok: false, may_click_publish: false, code: "article_not_approved" });
    expect(await run({ op: "mark_editor_done", scheduled_for: "2026-10-24T12:00:00+08:00" })).toMatchObject({ ok: false, phase: "unknown" });
    expect((await readPublishState(id, env.dir)).phase).toBe("unknown");
  });

  it("P2-8 record_absent 确认草稿也不在 → 清掉身份，再推真推一份", async () => {
    await run({ op: "push_draft" });
    await run({ op: "record_unknown", raw: "草稿箱里找不到" });
    await run({ op: "record_absent", raw: "三处都没有" });
    expect(await run({ op: "push_draft" })).toMatchObject({ ok: true, reused: false, media_id: "MID-2" });
  });

  it("P2-9 已定时 → 到点后记已发表", async () => {
    await run({ op: "push_draft" });
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    await run({ op: "begin_editor" });
    await run({ op: "final_check", channels_card_visible: "true" });
    await run({ op: "mark_editor_done", scheduled_for: "2026-10-24T12:00:00+08:00" });
    await run({ op: "record_scheduled", scheduled_at: "2026-10-24T12:00:00+08:00", founder_quote: "扫了" });
    expect(await run({ op: "record_scheduled", scheduled_at: "2026-10-24T12:00:00+08:00", founder_quote: "发出来了", published: "true" })).toMatchObject({ ok: true, phase: "published" });
  });

  it("P2-10 别的文章结果不明也占着那天", async () => {
    await run({ op: "push_draft" });
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    const other = await videoContent(env, "另一条", "draft_ready", "x", { topicId: "topic-3-abc" });
    await setContent(env, other.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
    const a2 = String((await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: other.id })).content_id);
    await writePublishState(a2, { phase: "unknown", slot: { at: "2026-10-24T20:00:00+08:00", basis: "x" }, superseded: [], attempts: [] }, env.dir);
    expect(await run({ op: "begin_editor" })).toMatchObject({ ok: true, slot: { at: "2026-10-25T12:00:00+08:00" } });
  });

  it("P2-11 不带时区的时间按北京时间解释（本机时区是 UTC 也一样）", async () => {
    const tz = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      expect(parseShanghai("2026-10-24T09:00:00")).toBe(Date.parse("2026-10-24T09:00:00+08:00"));
      expect(parseShanghai("2026-10-24 09:00")).toBe(Date.parse("2026-10-24T09:00:00+08:00"));
      await run({ op: "push_draft" });
      await videoChannel("published", "2026-10-24T09:00:00");
      expect(await run({ op: "begin_editor" })).toMatchObject({ ok: true, slot: { at: "2026-10-24T12:00:00+08:00" } });
    } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
  });

  it("批后改封面 / 创作来源 → 退回等你拍板，认稿那件重新出现并写明原因", async () => {
    const r = await run({ op: "set_creation_source", creation_source: "个人观点，仅供参考", founder_quote: "改成个人观点" });
    expect(r).toMatchObject({ ok: true, reopened_for_review: expect.any(String) });
    const item = (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === id);
    expect(item).toBeTruthy();
    expect(await approve()).toMatchObject({ ok: true });
  });
});

describe("verifier fixes: final_check re-checks 视频号; unpicking 公众号 stops every exit (spec §9.2)", () => {
  beforeEach(async () => { await complete(); await approve(); await run({ op: "push_draft" }); });

  it("Codex P2：final_check 要宿主在编辑器视频号选择框里确认过原片还列着（channels_card_visible），不带就拒", async () => {
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    expect(await run({ op: "begin_editor" })).toMatchObject({ ok: true });
    expect(await run({ op: "final_check" })).toMatchObject({ ok: false, code: "confirm_channels_card", may_click_publish: false, required_confirmation: "channels_card_visible" });
    expect(await run({ op: "final_check", channels_card_visible: false })).toMatchObject({ ok: false, code: "confirm_channels_card" });
    expect(await run({ op: "final_check", channels_card_visible: true })).toMatchObject({ ok: true, may_click_publish: true });
    expect((await readPublishState(id, env.dir)).channelsCardConfirmedAt).toBeTruthy();
  });

  it("视频号原片 begin_editor 之后被撤下：final_check 不许点发表", async () => {
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    expect(await run({ op: "begin_editor" })).toMatchObject({ ok: true });
    await videoChannel("scheduled");
    expect(await run({ op: "final_check" })).toMatchObject({ ok: false, code: "video_not_live", may_click_publish: false });
  });

  it("取消勾选公众号：push / begin_editor / final_check / mark_editor_done / 复制件都拒，原因一致；重新勾上接着走", async () => {
    await videoChannel("published", "2026-10-24T09:00:00+08:00");
    expect(await run({ op: "begin_editor" })).toMatchObject({ ok: true });
    await updateProfile({ platforms: ["douyin"] }, env.dir);
    const reason = /你取消了勾选「公众号」.*重新勾上/;
    for (const op of [{ op: "push_draft" }, { op: "final_check" }]) {
      const r = await run(op);
      expect(r).toMatchObject({ ok: false });
      expect(String(r.error)).toMatch(reason);
    }
    const { executePrePublish } = await import("../../tools/pre-publish.js");
    expect(await executePrePublish({ content_id: id, _dataDir: env.dir, platform: "wechat_mp" })).toMatchObject({ ok: false, code: "line_unpicked" });
    const { boardData } = await import("../../desktop/board-data.js");
    expect((await boardData(env.dir)).items.find((i) => i.id === id)!.alerts.join("\n")).toMatch(reason);
    await updateProfile({ platforms: ["douyin", "wechat_mp"] }, env.dir);
    expect(await run({ op: "final_check", channels_card_visible: "true" })).toMatchObject({ ok: true, may_click_publish: true });
    // 点了发表之后才取消勾选：复核不过（进 unknown，先别扫码），原因同一句
    await updateProfile({ platforms: ["douyin"] }, env.dir);
    const done = await run({ op: "mark_editor_done", scheduled_for: "2026-10-24T12:00:00+08:00" });
    expect(done).toMatchObject({ ok: false, phase: "unknown" });
    expect(String(done.error)).toMatch(reason);
  });
});
