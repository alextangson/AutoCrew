/**
 * spec §9.1 rebind（创始人 2026-10-24）：源视频成片换版后，派生稿绑到新成片——草稿留着、给逐句对比、批准撤掉重审。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

vi.mock("../publish/wechat-mp.js", () => ({ generateWechatImageAsset: vi.fn(), publishWechatMpDraft: vi.fn() }));
// 审阅页的真排版要 uv + 排版脚本，这里只测包与审阅页其余部分（真排版见 preview-format.test.ts）
vi.mock("../wechat-article/preview-format.js", () => ({ formatArticleBodyCached: async (i: { theme: string }) => ({ ok: true, theme: i.theme, html: "<p>排版后的正文</p>" }) }));

import { getContent } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderDecision } from "../production/decisions.js";
import { png, put, record, setContent, waiveSliverCheck, type Env } from "../production/testkit.js";
import { readInbox } from "../production/inbox-read.js";
import { listForChat } from "../production/chat-approval/present.js";
import { executeWechatArticle } from "../../tools/wechat-article.js";
import { executeEnEdition } from "../../tools/en-edition.js";
import { readArticlePackage, writeArticlePackage, approvePackage } from "../wechat-article/package.js";
import { readEnScript } from "../en-edition/script.js";
import { approveEnScript, EN_SRT_40S, enSourceVideo, SEGMENTS } from "../en-edition/en-test-fixtures.js";
import { staleReason } from "./lineage.js";
import { diffCues } from "./rebind-diff.js";
import { parseTimedSrt } from "../en-edition/source.js";

let env: Env;
afterEach(async () => { await env?.cleanup(); });

/** 源视频剪了新的一版并审过（字幕第 2 句改了、末尾加了一句） */
const SRT_V2 = EN_SRT_40S.replace("腾讯的同事刚发了一个测试", "Anthropic 的同事刚发了一个测试") + "\n5\n00:00:40,000 --> 00:00:45,000\n所以别再无脑开最大了\n";
async function recut(srcId: string, srt = SRT_V2) {
  const cut = await record(env, { content_id: srcId, kind: "cut", path: await put(path.join(env.chatcut, "深度思考-v2.mp4"), "cut-v2"), request_id: "c2", review: true });
  await record(env, { content_id: srcId, kind: "srt", path: await put(path.join(env.chatcut, "b.srt"), srt), for_cut: cut.fact_id, request_id: "s2" });
  const sha = (await readProductionDoc(srcId, env.dir))!.facts.find((f) => f.id === cut.fact_id)!.sha256!;
  await waiveSliverCheck(env, srcId, sha);
  expect(await founderDecision(srcId, "approve_cut", { fact_id: cut.fact_id, sha256: sha }, env.dir)).toMatchObject({ ok: true });
  // 成片换版后无字幕母版也要从新时间线重新导出、重新登记（英文版画面来源，2026-10-25）
  expect(await record(env, { content_id: srcId, kind: "clean_master", path: await put(path.join(env.chatcut, "深度思考-v2-无字幕.mp4"), "master-v2"), request_id: "m2", captions_off: true })).toMatchObject({ ok: true });
}

describe("diffCues", () => {
  it("pairs a changed line, lists added and removed lines, counts the same ones", () => {
    const d = diffCues(parseTimedSrt(EN_SRT_40S), parseTimedSrt(SRT_V2));
    expect(d.summary).toEqual({ same: 3, changed: 1, added: 1, removed: 0 });
    expect(d.lines[0]).toMatchObject({ op: "changed", old: "腾讯的同事刚发了一个测试", new: "Anthropic 的同事刚发了一个测试" });
    expect(d.lines[1]).toMatchObject({ op: "added", new: "所以别再无脑开最大了" });
  });
});

describe("wechat_article rebind", () => {
  it("keeps the drafts, swaps the binding, drops the approval, back to review with the diff in the brief", async () => {
    const src = await enSourceVideo(["douyin", "wechat_mp"], EN_SRT_40S);
    env = src.env;
    const id = String((await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
    await setContent(env, id, { body: "正文草稿", status: "approved" });
    const pkg = await readArticlePackage(id, env.dir);
    await writeArticlePackage(id, approvePackage({ ...pkg, titleOptions: ["一", "二", "三"], chosenTitle: "二" }, "h", { name: "newspaper", sha: "x" }), env.dir);
    expect(await executeWechatArticle({ _dataDir: env.dir, op: "rebind", content_id: id })).toMatchObject({ ok: true, rebound: false });
    await recut(src.id);
    const stale = await staleReason((await getContent(id, env.dir))!, env.dir, { fresh: true });
    expect(stale).toMatch(/rebind/);
    // derive 拿回旧的那条、指路 rebind（不另建）
    expect(await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id })).toMatchObject({ ok: true, created: false, stale: expect.stringMatching(/rebind/), next_action: { params: { article: { op: "rebind" } } } });
    const r = await executeWechatArticle({ _dataDir: env.dir, op: "rebind", content_id: id });
    expect(r).toMatchObject({ ok: true, rebound: true, diff: { changed: 1, added: 1 } });
    const after = (await getContent(id, env.dir))!;
    expect(after).toMatchObject({ body: "正文草稿", status: "draft_ready" });
    expect(after.derivedFrom!.rebound).toBeDefined();
    expect(await staleReason(after, env.dir, { fresh: true })).toBeNull();
    const p2 = await readArticlePackage(id, env.dir);
    expect(p2.approval).toBeUndefined();
    expect(p2.chosenTitle).toBe("二");
    const brief = String(((await listForChat(env.dir, { content_id: id })).items as Array<Record<string, unknown>>).find((i) => String(i.item_id).startsWith("draft:"))!.brief);
    expect(brief).toContain("源视频成片换了一版");
    expect(brief).toContain("Anthropic 的同事刚发了一个测试");
    // 审阅页里也有对比
    const st = await executeWechatArticle({ _dataDir: env.dir, op: "status", content_id: id });
    expect(await fs.readFile(String(st.preview_page), "utf8")).toContain("Anthropic 的同事刚发了一个测试");
  });
});

describe("en_edition rebind", () => {
  it("keeps unchanged segments, flags the changed one, drops the script approval and the old English cut round", async () => {
    const src = await enSourceVideo(["douyin", "youtube"], EN_SRT_40S);
    env = src.env;
    const id = String((await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
    const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env.dir, content_id: id, ...p });
    await run({ op: "set_script", segments: SEGMENTS });
    expect(await approveEnScript(env, id)).toMatchObject({ ok: true });
    await run({ op: "set_thumbnail", path: await put(path.join(env.outside, "t.png"), png(1280, 720, "t")) });
    await recut(src.id);
    const r = await run({ op: "rebind" });
    expect(r).toMatchObject({ ok: true, rebound: true, changed_segments: [2, 3], dropped_segments: [] });
    const script = (await readEnScript(id, env.dir))!;
    expect(script.approval).toBeUndefined();
    expect(script.segments.map((s) => s.en)).toEqual(SEGMENTS.map((s) => s.en));
    expect(script.segments[1]).toMatchObject({ zh: "Anthropic 的同事刚发了一个测试", changed: expect.stringMatching(/变了/) });
    expect(script.segments[2]).toMatchObject({ cueFrom: 3, cueTo: 5, changed: expect.any(String) });
    expect(script.segments[0].changed).toBeUndefined();
    const status = await run({ op: "status" });
    expect((status.problems as string[]).join("\n")).toMatch(/第 2 段成片换版后这段中文变了/);
    expect(status.thumbnail).toBeTruthy();
    expect((await getContent(id, env.dir))!.status).toBe("draft_ready");
    const draft = (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === id);
    expect(draft).toBeDefined();
  });
});

describe("en_edition rebind after the English cut was approved", () => {
  it("ends the English production round (lip-sync / captions redone on the new cut) and re-dubs only segments whose English changed", async () => {
    const { fakeElevenLabs } = await import("../en-edition/en-test-fixtures.js");
    const { setElevenLabsFetch, setKeychainReader } = await import("../voice/elevenlabs.js");
    const { setDurationProbe } = await import("../en-edition/dub.js");
    const src = await enSourceVideo(["douyin", "youtube"], EN_SRT_40S);
    env = src.env;
    process.env.ELEVENLABS_API_KEY = "sk-test"; process.env.ELEVENLABS_VOICE_ID = "v";
    setKeychainReader(async () => null);
    try {
      const id = String((await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
      const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env.dir, content_id: id, ...p });
      await run({ op: "set_script", segments: SEGMENTS });
      expect(await approveEnScript(env, id)).toMatchObject({ ok: true });
      fakeElevenLabs([9, 9, 19]);
      expect(await run({ op: "dub" })).toMatchObject({ ok: true });
      const cut = await record(env, { content_id: id, kind: "cut", path: await put(path.join(env.chatcut, "english.mp4"), "en-cut-v1"), request_id: "c-en", review: true });
      await record(env, { content_id: id, kind: "srt", path: await put(path.join(env.chatcut, "english.srt"), "1\n00:00:00,000 --> 00:00:02,000\nBe honest.\n"), for_cut: cut.fact_id, request_id: "s-en" });
      const sha = (await readProductionDoc(id, env.dir))!.facts.find((f) => f.id === cut.fact_id)!.sha256!;
      await waiveSliverCheck(env, id, sha);
      expect(await founderDecision(id, "approve_cut", { fact_id: cut.fact_id, sha256: sha }, env.dir)).toMatchObject({ ok: true });
      const round = (await readProductionDoc(id, env.dir))!.round;
      await recut(src.id);
      expect(await run({ op: "rebind" })).toMatchObject({ ok: true, rebound: true });
      expect((await readProductionDoc(id, env.dir))!.round).toBe(round + 1);
      const changed = [SEGMENTS[0], { ...SEGMENTS[1], en: "Tariq at Anthropic just published a test." }, { ...SEGMENTS[2], cues: "3-5" }];
      expect(await run({ op: "set_script", segments: changed })).toMatchObject({ ok: true, problems: [] });
      expect(await approveEnScript(env, id)).toMatchObject({ ok: true });
      const calls = fakeElevenLabs([9, 9, 19]);
      expect(await run({ op: "dub" })).toMatchObject({ ok: true });
      expect(calls.map((c) => c.text)).toEqual(["Tariq at Anthropic just published a test."]);
    } finally {
      setElevenLabsFetch(null); setDurationProbe(null); setKeychainReader(null);
      delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID;
    }
  });
});

describe("stale wording right after the source cut is written", () => {
  it("within the settle minute says 等一分钟, not 要重做", async () => {
    const { setSettleMs } = await import("../production/hash-cache.js");
    const src = await enSourceVideo(["douyin", "wechat_mp"], EN_SRT_40S);
    env = src.env;
    const id = String((await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
    setSettleMs(60_000);
    try {
      const file = path.join(env.chatcut, "深度思考.mp4");
      await fs.utimes(file, new Date(), new Date());
      const doc = (await readProductionDoc(src.id, env.dir))!;
      const cutFact = doc.facts.find((f) => f.kind === "cut")!;
      const abs = path.isAbsolute(cutFact.path!) ? cutFact.path! : path.join((await import("../../storage/content-project.js")).contentRoot(src.id, env.dir), cutFact.path!);
      await fs.utimes(abs, new Date(), new Date());
      expect(await staleReason((await getContent(id, env.dir))!, env.dir, { fresh: true })).toBe("成片文件刚写完，等一分钟再判断（先不发）");
    } finally { setSettleMs(null); }
  });
});

describe("Codex P1: wechat rebind interrupted after switching the binding", () => {
  it("a retry finishes the job (back to review, marker cleared) and the old approval can't pass under the new cut", async () => {
    const { planRebind, commitRebind } = await import("./rebind.js");
    const { packageApprovalCheck } = await import("../wechat-article/package.js");
    const { getArticleImageReview } = await import("../publish/article-images.js");
    const src = await enSourceVideo(["douyin", "wechat_mp"], EN_SRT_40S);
    env = src.env;
    const id = String((await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
    await setContent(env, id, { body: "正文草稿", status: "approved" });
    const pkg = await readArticlePackage(id, env.dir);
    const { packageHash } = await import("../wechat-article/package.js");
    const hash = await packageHash((await getContent(id, env.dir))!, pkg, await getArticleImageReview(id, env.dir), { name: "newspaper", sha: "x" });
    await writeArticlePackage(id, approvePackage(pkg, hash, { name: "newspaper", sha: "x" }), env.dir);
    await recut(src.id);
    // 模拟崩在 ② 之后：绑定换了，批准还在（撤批准那一步没写成），状态还是 approved
    const plan = await planRebind((await getContent(id, env.dir))!, env.dir);
    if ("ok" in plan || plan.noop) throw new Error("expected a rebind plan");
    await commitRebind(id, plan, env.dir);
    const c = (await getContent(id, env.dir))!;
    expect((await packageApprovalCheck(c, await readArticlePackage(id, env.dir), await getArticleImageReview(id, env.dir), { name: "newspaper", sha: "x" })).ok).toBe(false);
    // 带着 rebindPending 再调：收尾，而不是回「不用 rebind」
    await writeArticlePackage(id, { ...(await readArticlePackage(id, env.dir)), rebindPending: { toCut: plan.to, at: "x" } }, env.dir);
    expect(await executeWechatArticle({ _dataDir: env.dir, op: "rebind", content_id: id })).toMatchObject({ ok: true, rebound: true, resumed: true });
    expect((await getContent(id, env.dir))!.status).toBe("draft_ready");
    const after = await readArticlePackage(id, env.dir);
    expect(after.rebindPending).toBeUndefined();
    expect(after.approval).toBeUndefined();
  });
});

describe("Codex P1/P2: en rebind lock order and script approval", () => {
  it("rebind racing the founder's inbox approval finishes (no deadlock), and an approved script with no production facts loses its production approval", async () => {
    const { scriptApprovalFor } = await import("../../storage/production-store.js");
    const src = await enSourceVideo(["douyin", "youtube"], EN_SRT_40S);
    env = src.env;
    const id = String((await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
    const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env.dir, content_id: id, ...p });
    await run({ op: "set_script", segments: SEGMENTS });
    expect(await approveEnScript(env, id)).toMatchObject({ ok: true });
    await recut(src.id);
    await run({ op: "set_script", segments: SEGMENTS.map((s) => ({ ...s, en: `${s.en} ` + "Again." })) }).catch(() => null);
    // 认稿那条路的锁序：先文件归属、再英文版锁（inbox-decide）。它先拿到文件归属、过一会儿再要英文版锁
    const { withFileOwnership } = await import("../production/mutex.js");
    const { withEnLock } = await import("../en-edition/script.js");
    const approval = withFileOwnership(async () => { await new Promise((r) => setTimeout(r, 150)); return withEnLock(id, async () => "approved"); });
    const race = Promise.all([approval, run({ op: "rebind" })]);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("deadlock: rebind and approval waited on each other")), 5000));
    await Promise.race([race, timeout]);
    const after = await run({ op: "rebind" });
    expect(after).toMatchObject({ ok: true });
    const c = (await getContent(id, env.dir))!;
    expect(scriptApprovalFor((await readProductionDoc(id, env.dir))!, c.body ?? "")).toBeFalsy();
    expect(c.status).toBe("draft_ready");
  }, 15_000);
});
