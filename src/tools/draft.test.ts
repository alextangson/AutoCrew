/** autocrew_draft：每个动作的正常路径 + 规格「边界」表逐行（docs/2026-10-04-idea-to-aroll-replan.md） */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "./draft.js";
import { setDraftFetch } from "../modules/draft/draft-research.js";
import { resetDraftTokens } from "../modules/draft/draft-claims.js";
import { resetReviewQueue, reviewsIdle, setCodexRunner } from "../modules/draft/codex-review-queue.js";
import { appendOutcomes } from "../modules/flywheel/outcome-store.js";
import { getContent, getTopic, saveContent, saveTopic, updateContent } from "../storage/local-store.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";
import { contentFile } from "../storage/content-project.js";
import { newDraftAngleRefusal } from "../modules/research/angle-gate.js";

let dir: string;
const URL = "https://example.com/report";
const PAGE = "研究显示，参与调查的 1200 名职场人里，有 37% 每天用 AI 写周报。很多人说省下来的时间又被开会吃掉了。";
const BODY = "你是不是也觉得用了 AI 以后反而更忙了？我先说结论：省下来的时间，被你自己又填满了。有份调查问了 1200 名职场人，37% 每天用 AI 写周报。可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的半小时，写进日历，标成不许约会。";

const run = (action: string, args: Record<string, unknown> = {}, session = "s1", host = "claude-code") =>
  executeDraft({ action, ...args, _dataDir: dir, _host: host, _session: session });

const ANGLE = {
  main_line: "AI 省下的时间会被你自己填满，要管的是日程不是工具",
  for_whom: "天天用 AI 写东西的职场人",
  opening: "你是不是也觉得用了 AI 以后反而更忙了？",
  why_viral: "账号近 90 天播放第一的那条讲的就是「AI 让人更累」",
  chain: ["用了 AI 反而更忙", "省下的时间没消失", "被会议和杂事填满", "所以要把时间先占住"],
  founder_words: "就第二个",
};

async function started(): Promise<string> {
  const r = await run("start", { inspiration: "用了 AI 反而更忙，想聊聊为什么" });
  expect(r.ok).toBe(true);
  return r.content_id as string;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-tool-"));
  resetDraftTokens();
  resetReviewQueue();
  setCodexRunner(async () => ({ code: 0, stdout: JSON.stringify({ main_line: { verdict: "pass", reason: "清楚", quotes: [] }, payoff: { verdict: "pass", reason: "有", quotes: [] }, opening: { verdict: "pass", reason: "抓人", quotes: [] }, advisories: [] }), stderr: "", timedOut: false }));
  setDraftFetch(async (url) => ({ finalUrl: url, title: "调查", text: PAGE, imageCandidates: [] }));
});
afterEach(async () => {
  await reviewsIdle();
  setDraftFetch(undefined);
  setCodexRunner(null);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("start", () => {
  it("一句灵感建选题和抖音稿（写稿中），返回三份上下文与一手材料", async () => {
    await appendOutcomes([
      { contentId: null, platform: "douyin", platformTitle: "爆款A", publishedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), metricDate: "2026-10-03", metrics: { views: 90000, completion5s: 40 }, source: "auto", recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [] },
      { contentId: null, platform: "douyin", platformTitle: "老作品", publishedAt: new Date(Date.now() - 200 * 86_400_000).toISOString(), metricDate: "2026-10-03", metrics: { views: 999999 }, source: "auto", recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [] },
      { contentId: null, platform: "douyin", platformTitle: "只有播放", publishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), metricDate: "2026-10-02", metrics: { views: 100 }, source: "auto", recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [] },
    ], dir);
    const r = await run("start", { inspiration: "用了 AI 反而更忙" });
    const content = await getContent(r.content_id as string, dir);
    expect(content).toMatchObject({ platform: "douyin", status: "drafting", body: "" });
    expect(content!.draftPath?.kind).toBe("thin");
    const ctx = r.context as Record<string, Record<string, unknown>>;
    expect(ctx.hits.sample_size).toBe(2);
    expect((ctx.hits.by_views as Array<{ title: string }>).map((h) => h.title)).toEqual(["爆款A", "只有播放"]);
    expect((ctx.hits.by_completion5s as unknown[]).length).toBe(1);
    expect(ctx.hits.snapshot_date).toBe("2026-10-03");
    expect(ctx.firsthand.founder_words).toBe("用了 AI 反而更忙");
    expect(ctx.profile).toBeDefined();
    expect(Array.isArray(ctx.series)).toBe(true);
    expect((r.progress as Record<string, unknown>).needs_angle).toBe(true);
  });

  it("边界：平台不是 douyin → 拒绝并指向旧流程", async () => {
    const r = await run("start", { inspiration: "x", platform: "wechat_mp" });
    expect(r).toMatchObject({ ok: false, code: "platform_not_supported", next_action: { tool: "autocrew_workflow" } });
  });

  it("边界：会话中断后 start{content_id} 返回当前进度", async () => {
    const id = await started();
    await run("angle", { content_id: id, ...ANGLE });
    await run("save", { content_id: id, body: BODY });
    const r = await run("start", { content_id: id }, "s1");
    expect(r).toMatchObject({ ok: true, resumed: true, content_id: id });
    expect(r.progress).toMatchObject({ angle: { version: 1 }, needs_angle: false, versions: 2 });
  });

  it("边界：接手旧流程的真稿可以直接 save，不强制补立意", async () => {
    const topic = await saveTopic({ title: "卡帕西", description: "卡帕西", tags: [] }, dir);
    const old = await saveContent({ title: "卡帕西", body: "旧流程写好的正文".repeat(10), platform: "douyin", topicId: topic.id, status: "draft_ready", tags: [], _provenance: HUMAN_WRITE }, dir);
    expect((await run("start", { content_id: old.id })).ok).toBe(true);
    const saved = await run("save", { content_id: old.id, body: BODY });
    expect(saved.ok).toBe(true);
    expect((await getContent(old.id, dir))!.status).toBe("drafting");
  });

  it("边界：已发布不接手；已进剪辑返回重开说明；已定稿让创始人先拉回", async () => {
    const pub = (await saveContent({ title: "t", body: "正文".repeat(50), platform: "douyin", status: "drafting", tags: [], _provenance: HUMAN_WRITE }, dir)).id;
    const c = (await getContent(pub, dir))!;
    // 直接改盘上状态模拟各阶段（状态机推进不是本测试的对象）
    const meta = contentFile(pub, dir, "meta.json");
    for (const [status, code] of [["published", "published"], ["editing", "script_frozen"], ["approved", "finalized"]] as const) {
      await fs.writeFile(meta, JSON.stringify({ ...c, status }));
      expect(await run("start", { content_id: pub })).toMatchObject({ ok: false, code });
    }
  });
});

describe("read / cite", () => {
  it("read 返回原文片段与 page_id；cite 逐字核对后进证据台账，重复登记幂等", async () => {
    const id = await started();
    const page = await run("read", { content_id: id, url: URL });
    expect(page).toMatchObject({ ok: true, page_id: "p1", text: PAGE, truncated: false });
    const cited = await run("cite", { content_id: id, page_id: "p1", quote: "有 37% 每天用 AI 写周报", claim: "37% 用 AI 写周报" });
    expect(cited).toMatchObject({ ok: true, evidence_id: "ev-d1", duplicate: false });
    expect(await run("cite", { content_id: id, page_id: "p1", quote: "有 37% 每天用 AI 写周报" })).toMatchObject({ ok: true, evidence_id: "ev-d1", duplicate: true });
    const ledger = (await getContent(id, dir))!.evidenceLedger!.entries;
    expect(ledger[0]).toMatchObject({ id: "ev-d1", source: "verified_quote", sourceUrl: URL });
  });

  it("边界：引文对不上原网页 → cite 拒绝并说明", async () => {
    const id = await started();
    await run("read", { content_id: id, url: URL });
    const r = await run("cite", { content_id: id, page_id: "p1", quote: "有 50% 的人每天用 AI" });
    expect(r).toMatchObject({ ok: false, code: "quote_not_found" });
    expect(String(r.error)).toContain("找不到");
  });

  it("抓页快照持久化：page_id 序号跨实例延续", async () => {
    const id = await started();
    await run("read", { content_id: id, url: URL });
    const second = await run("read", { content_id: id, url: "https://example.com/other" });
    expect(second.page_id).toBe("p2");
    const cached = await run("read", { content_id: id, url: URL });
    expect(cached).toMatchObject({ page_id: "p1", cached: true });
  });

  it("抓页失败给出可见原因", async () => {
    const id = await started();
    setDraftFetch(async () => { throw new Error("HTTP 403"); });
    expect(await run("read", { content_id: id, url: URL })).toMatchObject({ ok: false, code: "read_failed" });
  });
});

describe("angle", () => {
  it("记创始人立意：存盘入口守卫认这条决定记录；重调即改立意、版本 +1", async () => {
    const id = await started();
    const r = await run("angle", { content_id: id, ...ANGLE });
    expect(r).toMatchObject({ ok: true, angle_version: 1 });
    const topicId = (await getContent(id, dir))!.topicId!;
    expect(await newDraftAngleRefusal(topicId, dir)).toBeNull();
    expect((await getTopic(topicId, dir))!.founderAngle).toMatchObject({ direction: ANGLE.main_line, founderWords: "就第二个" });
    const again = await run("angle", { content_id: id, ...ANGLE, main_line: "改过的主线", founder_words: "你定" });
    expect(again.angle_version).toBe(2);
    expect((await getContent(id, dir))!.draftPath!.angle).toMatchObject({ main_line: "改过的主线", chain: ANGLE.chain });
  });

  it("chain 被序列化成字符串也能用；行数不对、缺原话都拒", async () => {
    const id = await started();
    expect(await run("angle", { content_id: id, ...ANGLE, chain: JSON.stringify(ANGLE.chain) })).toMatchObject({ ok: true });
    expect(await run("angle", { content_id: id, ...ANGLE, chain: ["一", "二"] })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("angle", { content_id: id, ...ANGLE, founder_words: "" })).toMatchObject({ ok: false, code: "bad_param" });
  });
});

describe("save", () => {
  it("立意之后存第一版：记为 AI 写入，排一次 Codex 审稿；第二版不再自动审", async () => {
    const id = await started();
    await run("angle", { content_id: id, ...ANGLE });
    const first = await run("save", { content_id: id, body: BODY, title: "AI 越用越忙" });
    expect(first).toMatchObject({ ok: true, format_warnings: [] });
    expect(["queued", "running", "done"]).toContain((first.review as Record<string, unknown>).status);
    const c = (await getContent(id, dir))!;
    expect(c.writtenBy).toEqual({ kind: "host", host: "claude-code" });
    expect(c.draftPath!.autoReviewQueued).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const second = await run("save", { content_id: id, body: `${BODY}再补一句。` });
    expect((second.review as Record<string, unknown>).current).toBe(false);
  });

  it("边界：没选立意就存第一版 AI 正文 → 被守卫拒绝，指向 angle", async () => {
    const id = await started();
    const r = await run("save", { content_id: id, body: BODY });
    expect(r).toMatchObject({ ok: false, code: "needs_angle", next_action: { params: { action: "angle" } } });
  });

  it("边界：正文为空或明显被截断 → 拒绝", async () => {
    const id = await started();
    await run("angle", { content_id: id, ...ANGLE });
    expect(await run("save", { content_id: id, body: "  " })).toMatchObject({ ok: false, code: "empty_body" });
    expect(await run("save", { content_id: id, body: "太短了。" })).toMatchObject({ ok: false, code: "truncated_body" });
    expect(await run("save", { content_id: id, body: `${BODY}然后我们……` })).toMatchObject({ ok: false, code: "truncated_body" });
  });

  it("格式提醒：停顿和画面标注只提醒不拦", async () => {
    const id = await started();
    await run("angle", { content_id: id, ...ANGLE });
    const r = await run("save", { content_id: id, body: `【画面：办公室】${BODY}[停顿]最后一句。` });
    expect(r.ok).toBe(true);
    expect((r.format_warnings as string[]).length).toBe(2);
  });

  it("边界：两个会话同时写 → 后来的收到被占用与闲置分钟；闲置 10 分钟后可接管，旧会话迟到写入被拒", async () => {
    const id = await started();
    await run("angle", { content_id: id, ...ANGLE }, "s1");
    const held = await run("save", { content_id: id, body: BODY }, "s2");
    expect(held).toMatchObject({ ok: false, code: "claim_held", idle_minutes: 0 });
    expect(await run("save", { content_id: id, body: BODY }, "s2", "claude-code")).toMatchObject({ ok: false });
    // 把持有者的最近写入挪到 11 分钟前
    const c = (await getContent(id, dir))!;
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    await updateContent(id, { claim: { ...c.claim!, lastWriteAt: old, at: old } }, dir);
    const idle = await run("save", { content_id: id, body: BODY }, "s2");
    expect(idle).toMatchObject({ ok: false, code: "claim_held", next_action: expect.anything() });
    expect((await run("save", { content_id: id, body: BODY, takeover: true }, "s2")).ok).toBe(true);
    expect(await run("save", { content_id: id, body: `${BODY}迟到。` }, "s1")).toMatchObject({ ok: false, code: "claim_held" });
  });
});

describe("review", () => {
  it("rerun 审当前版；没正文不审", async () => {
    const id = await started();
    expect(await run("review", { content_id: id, rerun: true })).toMatchObject({ ok: false, code: "empty_body" });
    await run("angle", { content_id: id, ...ANGLE });
    await run("save", { content_id: id, body: BODY });
    await new Promise((r) => setTimeout(r, 50));
    const r = await run("review", { content_id: id });
    expect(r.review).toMatchObject({ status: "done", current: true, result: { main_line: { verdict: "pass" } } });
    const again = await run("review", { content_id: id, rerun: true });
    expect(again.ok).toBe(true);
  });
});
