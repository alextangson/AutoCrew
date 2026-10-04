/** autocrew_draft：每个动作的正常路径 + 规格「边界」表逐行（docs/2026-10-04-idea-to-aroll-replan.md，含「再收窄」） */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "./draft.js";
import { setQuoteFetch } from "../modules/draft/verify-quote.js";
import { appendOutcomes } from "../modules/flywheel/outcome-store.js";
import { getContent, getTopic, saveContent, saveTopic } from "../storage/local-store.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";
import { contentFile } from "../storage/content-project.js";
import { newDraftAngleRefusal } from "../modules/research/angle-gate.js";
import { buildIpcHandlers } from "../desktop/ipc.js";

let dir: string;
const URL = "https://example.com/report";
const PAGE = "研究显示，参与调查的 1200 名职场人里，有 37% 每天用 AI 写周报。很多人说省下来的时间又被开会吃掉了。";
const BODY = "你是不是也觉得用了 AI 以后反而更忙了？我先说结论：省下来的时间，被你自己又填满了。有份调查问了 1200 名职场人，37% 每天用 AI 写周报。可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的时间写进日历，标成不许约会。";

const run = (action: string, args: Record<string, unknown> = {}, host = "claude-code") =>
  executeDraft({ action, ...args, _dataDir: dir, _host: host, _session: "s1" });

const ANGLE = {
  main_line: "AI 省下的时间会被你自己填满，要管的是日程不是工具",
  for_whom: "天天用 AI 写东西的职场人",
  opening: "你是不是也觉得用了 AI 以后反而更忙了？",
  why_viral: "账号近 90 天播放第一的那条讲的就是「AI 让人更累」",
  chain: ["用了 AI 反而更忙", "省下的时间没消失", "被会议和杂事填满", "所以要把时间先占住"],
  founder_words: "就第二个",
};

async function started(): Promise<{ id: string; version: number }> {
  const r = await run("start", { inspiration: "用了 AI 反而更忙，想聊聊为什么" });
  expect(r.ok).toBe(true);
  return { id: r.content_id as string, version: (r.progress as { version: number }).version };
}
async function angled(): Promise<{ id: string; version: number }> {
  const s = await started();
  expect((await run("angle", { content_id: s.id, base_version: s.version, ...ANGLE })).ok).toBe(true);
  return s;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-tool-"));
  setQuoteFetch(async (url) => ({ finalUrl: url, title: "调查", text: PAGE }));
});
afterEach(async () => { setQuoteFetch(undefined); await fs.rm(dir, { recursive: true, force: true }); });

describe("start", () => {
  it("一句灵感建选题和抖音稿（写稿中），返回三份上下文、一手材料与版本号", async () => {
    await appendOutcomes([
      { contentId: null, platform: "douyin", platformTitle: "爆款A", publishedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), metricDate: "2026-10-03", metrics: { views: 90000, completion5s: 40 }, source: "auto", recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [] },
      { contentId: null, platform: "douyin", platformTitle: "老作品", publishedAt: new Date(Date.now() - 200 * 86_400_000).toISOString(), metricDate: "2026-10-03", metrics: { views: 999999 }, source: "auto", recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [] },
      { contentId: null, platform: "douyin", platformTitle: "只有播放", publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), metricDate: "2026-10-02", metrics: { views: 100 }, source: "auto", recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [] },
    ], dir);
    const r = await run("start", { inspiration: "用了 AI 反而更忙" });
    const content = await getContent(r.content_id as string, dir);
    expect(content).toMatchObject({ platform: "douyin", status: "drafting", body: "" });
    const ctx = r.context as Record<string, Record<string, unknown>>;
    expect(ctx.hits.sample_size).toBe(2);
    expect((ctx.hits.by_views as Array<{ title: string }>).map((h) => h.title)).toEqual(["爆款A", "只有播放"]);
    expect((ctx.hits.by_completion5s as unknown[]).length).toBe(1);
    expect(ctx.firsthand.founder_words).toBe("用了 AI 反而更忙");
    expect(r.progress).toMatchObject({ needs_angle: true, version: 1 });
  });

  it("边界：平台不是 douyin → 拒绝并指向旧流程", async () => {
    expect(await run("start", { inspiration: "x", platform: "wechat_mp" })).toMatchObject({ ok: false, code: "platform_not_supported", next_action: { tool: "autocrew_workflow" } });
  });

  it("边界：会话中断后 start{content_id} 返回当前进度", async () => {
    const { id, version } = await angled();
    await run("save", { content_id: id, base_version: version, body: BODY });
    const r = await run("start", { content_id: id });
    expect(r).toMatchObject({ ok: true, resumed: true, content_id: id, progress: { angle: { version: 1 }, needs_angle: false, version: 2, has_body: true } });
  });

  it("边界：接手旧流程的真稿可以直接 save，不强制补立意", async () => {
    const topic = await saveTopic({ title: "卡帕西", description: "卡帕西", tags: [] }, dir);
    const old = await saveContent({ title: "卡帕西", body: "旧流程写好的正文".repeat(10), platform: "douyin", topicId: topic.id, status: "draft_ready", tags: [], _provenance: HUMAN_WRITE }, dir);
    const s = await run("start", { content_id: old.id });
    expect((await run("save", { content_id: old.id, base_version: (s.progress as { version: number }).version, body: BODY })).ok).toBe(true);
    expect((await getContent(old.id, dir))!.status).toBe("drafting");
  });

  it("接手只存了选题的稿：推进到写作中，之后能定稿", async () => {
    const topic = await saveTopic({ title: "只有选题", description: "只有选题", tags: [] }, dir);
    const bare = await saveContent({ title: "只有选题", body: "", platform: "douyin", topicId: topic.id, status: "topic_saved", tags: [], _provenance: HUMAN_WRITE }, dir);
    expect((await run("start", { content_id: bare.id })).progress).toMatchObject({ status: "drafting", needs_angle: true });
    await run("angle", { content_id: bare.id, base_version: 1, ...ANGLE });
    expect((await run("save", { content_id: bare.id, base_version: 1, body: BODY })).ok).toBe(true);
    expect(await run("prepare_final", { content_id: bare.id, base_version: 2, citations: [] })).toMatchObject({ ok: true, status: "draft_ready" });
  });

  it("边界：已发布不接手；已进剪辑返回重开说明；已定稿让创始人先拉回", async () => {
    const pub = (await saveContent({ title: "t", body: "正文".repeat(50), platform: "douyin", status: "drafting", tags: [], _provenance: HUMAN_WRITE }, dir)).id;
    const c = (await getContent(pub, dir))!;
    const meta = contentFile(pub, dir, "meta.json");
    for (const [status, code] of [["published", "published"], ["editing", "script_frozen"], ["approved", "finalized"]] as const) {
      await fs.writeFile(meta, JSON.stringify({ ...c, status }));
      expect(await run("start", { content_id: pub })).toMatchObject({ ok: false, code });
    }
  });
});

describe("verify_quote", () => {
  it("逐字对上：进证据台账、回编号；重复登记幂等", async () => {
    const { id } = await started();
    expect(await run("verify_quote", { content_id: id, url: URL, quote: "有 37% 每天用 AI 写周报", claim: "37% 用 AI 写周报" })).toMatchObject({ ok: true, evidence_id: "ev-d1", duplicate: false });
    expect(await run("verify_quote", { content_id: id, url: URL, quote: "有 37% 每天用 AI 写周报" })).toMatchObject({ ok: true, evidence_id: "ev-d1", duplicate: true });
    expect(await run("verify_quote", { content_id: id, url: URL, quote: "参与调查的 1200 名职场人" })).toMatchObject({ evidence_id: "ev-d2" });
    expect((await getContent(id, dir))!.evidenceLedger!.entries[0]).toMatchObject({ id: "ev-d1", source: "verified_quote", sourceUrl: URL });
  });

  it("边界：引文对不上原网页 → 拒绝并说明，不进台账", async () => {
    const { id } = await started();
    const r = await run("verify_quote", { content_id: id, url: URL, quote: "有 50% 的人每天用 AI" });
    expect(r).toMatchObject({ ok: false, code: "quote_not_found" });
    expect(String(r.error)).toContain("找不到");
    expect((await getContent(id, dir))!.evidenceLedger).toBeUndefined();
  });

  it("抓页失败给出可见原因；不存抓取快照", async () => {
    const { id } = await started();
    setQuoteFetch(async () => { throw new Error("HTTP 403"); });
    expect(await run("verify_quote", { content_id: id, url: URL, quote: "有 37%" })).toMatchObject({ ok: false, code: "fetch_failed", error: expect.stringContaining("403") });
    await expect(fs.access(contentFile(id, dir, "draft-research.json"))).rejects.toThrow();
  });
});

describe("angle", () => {
  it("记创始人立意：存盘入口守卫认这条决定记录；重调即改立意、版本 +1", async () => {
    const { id } = await angled();
    const topicId = (await getContent(id, dir))!.topicId!;
    expect(await newDraftAngleRefusal(topicId, dir)).toBeNull();
    expect((await getTopic(topicId, dir))!.founderAngle).toMatchObject({ direction: ANGLE.main_line, founderWords: "就第二个" });
    const again = await run("angle", { content_id: id, base_version: 1, ...ANGLE, main_line: "改过的主线", founder_words: "你定" });
    expect(again.angle_version).toBe(2);
    expect((await getContent(id, dir))!.draftPath!.angle).toMatchObject({ main_line: "改过的主线", chain: ANGLE.chain });
  });

  it("chain 被序列化成字符串也能用；行数不对、缺原话都拒", async () => {
    const { id } = await started();
    expect(await run("angle", { content_id: id, base_version: 1, ...ANGLE, chain: JSON.stringify(ANGLE.chain) })).toMatchObject({ ok: true });
    expect(await run("angle", { content_id: id, base_version: 1, ...ANGLE, chain: ["一", "二"] })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("angle", { content_id: id, base_version: 1, ...ANGLE, founder_words: "" })).toMatchObject({ ok: false, code: "bad_param" });
  });
});

describe("save", () => {
  it("立意之后存第一版：记为 AI 写入，回新版本号", async () => {
    const { id, version } = await angled();
    const first = await run("save", { content_id: id, base_version: version, body: BODY, title: "AI 越用越忙" });
    expect(first).toMatchObject({ ok: true, version: 2, format_warnings: [] });
    expect((await getContent(id, dir))!.writtenBy).toEqual({ kind: "host", host: "claude-code" });
  });

  it("review_notes：结构或文字都存到当前版上，工作台读得到；解析不了就拒", async () => {
    const { id, version } = await angled();
    await run("save", { content_id: id, base_version: version, body: BODY });
    const verdicts = { main_line: { verdict: "pass", reason: "清楚" }, payoff: { verdict: "fail", reason: "太虚", quotes: ["今天就试一件事"] }, opening: { verdict: "pass", reason: "抓人" } };
    expect(await run("save", { content_id: id, base_version: 2, body: BODY, review_notes: JSON.stringify(verdicts) })).toMatchObject({ ok: true, version: 2 });
    expect(await run("save", { content_id: id, base_version: 2, body: BODY, review_notes: "{坏的" })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("save", { content_id: id, base_version: 2, body: `${BODY}再补一句。`, review_notes: "codex 没登录：Not logged in" })).toMatchObject({ ok: true, version: 3 });
    const panel = await buildIpcHandlers()["draft:final_get"]({ id, _dataDir: dir }, { authMethod: "session" });
    expect((panel.data as { review_notes: unknown[] }).review_notes).toEqual([
      expect.objectContaining({ version: 2, notes: verdicts }),
      expect.objectContaining({ version: 3, notes: "codex 没登录：Not logged in" }),
    ]);
  });

  it("边界：没选立意就存第一版 AI 正文 → 被守卫拒绝，指向 angle", async () => {
    const { id, version } = await started();
    expect(await run("save", { content_id: id, base_version: version, body: BODY })).toMatchObject({ ok: false, code: "needs_angle", next_action: { params: { action: "angle" } } });
  });

  it("边界：正文为空或明显被截断 → 拒绝", async () => {
    const { id, version } = await angled();
    expect(await run("save", { content_id: id, base_version: version, body: "  " })).toMatchObject({ ok: false, code: "empty_body" });
    expect(await run("save", { content_id: id, base_version: version, body: "太短了。" })).toMatchObject({ ok: false, code: "truncated_body" });
    expect(await run("save", { content_id: id, base_version: version, body: `${BODY}然后我们……` })).toMatchObject({ ok: false, code: "truncated_body" });
  });

  it("格式提醒：停顿和画面标注只提醒不拦", async () => {
    const { id, version } = await angled();
    const r = await run("save", { content_id: id, base_version: version, body: `【画面：办公室】${BODY}[停顿]最后一句。` });
    expect(r.ok).toBe(true);
    expect((r.format_warnings as string[]).length).toBe(2);
  });
});

describe("乐观版本号（边界：两个写入方同时改）", () => {
  it("缺 base_version 拒；版本对不上回 version_conflict、最新版本号与正文差异", async () => {
    const { id, version } = await angled();
    expect(await run("save", { content_id: id, body: BODY })).toMatchObject({ ok: false, code: "bad_param" });
    await run("save", { content_id: id, base_version: version, body: BODY });
    const stale = await run("save", { content_id: id, base_version: version, body: `${BODY}旧版本上改的。` });
    expect(stale).toMatchObject({ ok: false, code: "version_conflict", latest_version: 2, diff: { added: [BODY] } });
  });

  it("创始人在工作台手改后，agent 拿旧版本号存稿被拒，不会盖掉他的改动", async () => {
    const { id, version } = await angled();
    await run("save", { content_id: id, base_version: version, body: BODY });
    const founderBody = `${BODY}\n创始人亲手加的一句。`;
    expect((await buildIpcHandlers()["content:update"]({ id, body: founderBody, _dataDir: dir }, { authMethod: "session" })).ok).toBe(true);
    const r = await run("save", { content_id: id, base_version: 2, body: `${BODY}agent 的改法。` });
    expect(r).toMatchObject({ ok: false, code: "version_conflict", latest_version: 3, diff: { added: ["创始人亲手加的一句。"] } });
    expect((await getContent(id, dir))!.body).toBe(founderBody);
    for (const action of ["angle", "prepare_final"]) {
      expect(await run(action, { content_id: id, base_version: 2, ...ANGLE, citations: [] })).toMatchObject({ code: "version_conflict" });
    }
    expect((await run("save", { content_id: id, base_version: 3, body: `${founderBody}\nagent 在最新版上改。` })).ok).toBe(true);
  });

  it("两个调用拿同一个版本号同时存：只有一个成", async () => {
    const { id, version } = await angled();
    const [a, b] = await Promise.all([
      run("save", { content_id: id, base_version: version, body: `${BODY}甲。` }),
      run("save", { content_id: id, base_version: version, body: `${BODY}乙。` }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: "version_conflict" });
  });
});
