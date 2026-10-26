/**
 * Phase 3 方案 (b) 验收：英文版按「英文发布包」批一次再发，不走中文登记。
 * 边界：没批 → 所有发布出口拒；批过之后任何一样变了 → 「等你拍板」重新出现那件、写明原因，出口拒；
 * 缩略图要 16:9、字节要对得上；中文视频的登记出口不受影响。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { transitionStatus } from "../../storage/local-store.js";
import { updateProfile } from "../profile/creator-profile.js";
import { founderDecision } from "../production/decisions.js";
import { png, put, record, waiveSliverCheck, type Env } from "../production/testkit.js";
import { readInbox } from "../production/inbox-read.js";
import { decideItem } from "../production/inbox-decide.js";
import { listForChat } from "../production/chat-approval/present.js";
import { executeEnEdition } from "../../tools/en-edition.js";
import { executePrePublish, executePrePublishTool } from "../../tools/pre-publish.js";
import { executePublish } from "../../tools/publish.js";
import { boardData } from "../../desktop/board-data.js";
import { setDurationProbe } from "./dub.js";
import { setElevenLabsFetch, setKeychainReader } from "../voice/elevenlabs.js";
import { approveEnScript, EN_SRT_40S, enSourceVideo, fakeElevenLabs, SEGMENTS } from "./en-test-fixtures.js";

let env: Env;
let id: string;
let srcId: string;
const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env.dir, content_id: id, ...p });
const YT = { post_title: "Why max effort makes AI drift", caption: "The harder the task, the more you want max effort. The data says otherwise.", tags: ["AI", "Claude"], chapters: [{ at: "0:00", title: "The instinct" }, { at: "0:10", title: "The test" }, { at: "0:20", title: "Instead" }] };
const X = { post_text: "Max effort is not a free upgrade.", hashtags: ["AI"] };
const kit = (platform: string, k: unknown) => executePrePublishTool({ _dataDir: env.dir, action: "video_kit", content_id: id, platform, kit: k });
const pkgItem = async () => (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "en_package" && i.content_id === id);

/** 英文成片在英文版这条稿上登记并审过 */
async function approveEnglishCut(bytes = "en-cut-v1") {
  await record(env, { content_id: id, kind: "aroll", path: await put(path.join(env.inbox, `深度思考-英文参考-${bytes}.mov`), `ref-${bytes}`), request_id: `a-${bytes}` });
  const cut = await record(env, { content_id: id, kind: "cut", path: await put(path.join(env.chatcut, `english-${bytes}.mp4`), bytes), request_id: `c-${bytes}`, review: true });
  await record(env, { content_id: id, kind: "srt", path: await put(path.join(env.chatcut, `english-${bytes}.srt`), "1\n00:00:00,000 --> 00:00:02,000\nBe honest.\n"), for_cut: cut.fact_id, request_id: `s-${bytes}` });
  const doc = (await readProductionDoc(id, env.dir))!;
  const sha = doc.facts.find((f) => f.id === cut.fact_id)!.sha256!;
  await waiveSliverCheck(env, id, sha);
  expect(await founderDecision(id, "approve_cut", { fact_id: cut.fact_id, sha256: sha }, env.dir)).toMatchObject({ ok: true });
}

beforeEach(async () => {
  const src = await enSourceVideo(["douyin", "youtube", "x"], EN_SRT_40S);
  env = src.env; srcId = src.id;
  process.env.ELEVENLABS_API_KEY = "sk-test"; process.env.ELEVENLABS_VOICE_ID = "v";
  setKeychainReader(async () => null);
  id = String((await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: srcId })).content_id);
  await run({ op: "set_script", segments: SEGMENTS });
  expect(await approveEnScript(env, id)).toMatchObject({ ok: true });
  fakeElevenLabs([9, 9, 19]);
  expect(await run({ op: "dub" })).toMatchObject({ ok: true });
});
afterEach(async () => {
  setElevenLabsFetch(null); setDurationProbe(null); setKeychainReader(null);
  delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID;
  await env.cleanup();
});

async function completePackage(): Promise<string> {
  await approveEnglishCut();
  expect(await run({ op: "set_thumbnail", path: await put(path.join(env.outside, "thumb.png"), png(1280, 720, "t1")) })).toMatchObject({ ok: true });
  const yk = await kit("youtube", YT); expect(yk, JSON.stringify(yk)).toMatchObject({ ok: true });
  expect(await kit("x", X)).toMatchObject({ ok: true });
  const s = await run({ op: "package_status" });
  expect(s).toMatchObject({ ok: true, problems: [] });
  return String(s.review_page);
}

const approvePackage = async () => { const it = (await pkgItem())!; return decideItem({ item_id: it.item_id, gen: it.gen, action: "approve_en_package", content_id: id }, env.dir); };
const exits = async () => ({
  prepare: await executePublish({ action: "ego_lite_prepare", content_id: id, _dataDir: env.dir }) as Record<string, unknown>,
  clipboard: await executePublish({ action: "clipboard", content_id: id, platform: "x", _dataDir: env.dir }) as Record<string, unknown>,
  check: await executePrePublish({ action: "check", content_id: id, platform: "youtube", _dataDir: env.dir }) as Record<string, unknown>,
  final: await run({ op: "final_check", platform: "youtube" }),
});

describe("英文发布包", () => {
  it("没齐 → 不出那件；齐了 → 出那件，审阅页有缩略图、各平台文案、章节、成片；没批 → 出口全拒", async () => {
    expect(await pkgItem()).toBeUndefined();
    const page = await completePackage();
    const html = await fs.readFile(page, "utf8");
    for (const s of ["Why max effort makes AI drift", "0:10 The test", "Max effort is not a free upgrade.", "english-en-cut-v1.mp4", "1280×720", "file://"]) expect(html).toContain(s);
    expect(await pkgItem()).toMatchObject({ type: "en_package" });
    const list = await listForChat(env.dir, { content_id: id });
    expect((list.items as Array<Record<string, unknown>>).some((i) => String(i.brief).includes("英文发布包审阅页"))).toBe(true);
    // 英文版不出中文的「还差一步才能发（封面）」
    expect((await readInbox(env.dir, { withDrafts: true })).items.some((i) => i.content_id === id && i.type === "register_blocked")).toBe(false);
    const e = await exits();
    for (const r of [e.prepare, e.clipboard, e.check, e.final]) expect(r).toMatchObject({ ok: false, code: "en_package_not_approved" });
  });

  it("批了 → 出口放行：浏览器上传件按包里的文件和文案，final_check 回同一个包指纹", async () => {
    await completePackage();
    expect(await approvePackage()).toMatchObject({ ok: true });
    expect(await pkgItem()).toBeUndefined();
    const e = await exits();
    expect(e.prepare).toMatchObject({ ok: true });
    const data = e.prepare.data as { package_hash: string; packages: Array<Record<string, unknown>> };
    expect(data.packages.map((p) => p.platform)).toEqual(["youtube", "x"]);
    expect(data.packages[0]).toMatchObject({ ai_disclosure: "yes", title: YT.post_title, thumbnail_path: expect.stringContaining("thumb.png"), video_path: expect.stringContaining("english-en-cut-v1.mp4") });
    expect(data.packages[1]).toMatchObject({ post_text: "Max effort is not a free upgrade.\n\n#AI" });
    expect(e.final).toMatchObject({ ok: true, package_hash: data.package_hash });
    expect(e.clipboard).toMatchObject({ ok: true });
    expect(e.check).toMatchObject({ ok: true });
    expect((e.check.checks as Array<{ name: string; status: string }>).find((c) => c.name.startsWith("英文发布包"))).toMatchObject({ status: "pass" });
    expect((e.check.checks as Array<{ name: string }>).some((c) => c.name === "登记（发布出口）")).toBe(false);
  });

  it("批过之后换了文案 / 缩略图字节变了 → 那件重新出现并写明原因，出口拒；缩略图不是 16:9 登记不进去", async () => {
    await completePackage();
    await approvePackage();
    expect(await kit("x", { post_text: "A different post now.", hashtags: ["AI"] })).toMatchObject({ ok: true });
    const again = await pkgItem();
    expect(again).toMatchObject({ type: "en_package", summary: expect.stringMatching(/批过的英文发布包变了/) });
    expect(String(again!.detail.reopened)).toMatch(/英文发布包在批准之后变了/);
    expect((await exits()).prepare).toMatchObject({ ok: false, code: "en_package_not_approved" });
    expect(await approvePackage()).toMatchObject({ ok: true });
    const thumb = String((await run({ op: "status" })).thumbnail);
    await fs.writeFile(thumb, png(1280, 720, "changed"));
    expect((await run({ op: "package_status" })).problems).toEqual([expect.stringMatching(/缩略图在登记之后被改过/)]);
    expect((await pkgItem())?.detail.reopened).toMatch(/缩略图在登记之后被改过/);
    expect((await exits()).final).toMatchObject({ ok: false, code: "en_package_not_approved" });
    expect(await run({ op: "set_thumbnail", path: await put(path.join(env.outside, "t43.png"), png(1200, 900)) })).toMatchObject({ ok: false, code: "thumbnail_not_16x9" });
  });

  it("「还要改」记下原话、撤掉批准；出示后包变了用旧代次批 → stale", async () => {
    await completePackage();
    const shown = (await pkgItem())!;
    await kit("x", { post_text: "Changed before approval.", hashtags: ["AI"] });
    expect(await decideItem({ item_id: shown.item_id, gen: shown.gen, action: "approve_en_package", content_id: id }, env.dir)).toMatchObject({ ok: false, code: "stale" });
    const it2 = (await pkgItem())!;
    expect(await decideItem({ item_id: it2.item_id, gen: it2.gen, action: "revise_en_package", content_id: id, note: "YouTube 标题再短一点" }, env.dir)).toMatchObject({ ok: true });
  });
});

describe("Codex 审 (b) 的回归", () => {
  it("P1-1 批过之后缩略图变了：prepare / final_check 都拒，不拿旧指纹放行", async () => {
    await completePackage();
    await approvePackage();
    await fs.writeFile(String((await run({ op: "status" })).thumbnail), png(1280, 720, "swapped"));
    const e = await exits();
    expect(e.prepare).toMatchObject({ ok: false, code: "en_package_not_approved" });
    expect(e.final).toMatchObject({ ok: false, code: "en_package_not_approved" });
  });

  it("P1-2 批过之后认稿被撤（回到待认稿）：各项指纹都没变也拒", async () => {
    await completePackage();
    await approvePackage();
    expect(await transitionStatus(id, "draft_ready", { force: true }, env.dir)).toMatchObject({ ok: true });
    const e = await exits();
    for (const r of [e.prepare, e.final, e.clipboard]) expect(r).toMatchObject({ ok: false, code: "en_package_not_approved" });
    expect(String(e.prepare.error)).toMatch(/认稿/);
  });

  it("P1-3 取消勾选 X、批一个只有 YouTube 的包：clipboard / final_check 要 x → 拒，不拿留下的旧 x 包", async () => {
    await completePackage();
    await updateProfile({ platforms: ["douyin", "youtube"] }, env.dir);
    expect(await approvePackage()).toMatchObject({ ok: true });
    // spec §9.2：取消勾选的那一路说清是「你取消了勾选」，和看板同一句话
    expect(await executePublish({ action: "clipboard", content_id: id, platform: "x", _dataDir: env.dir })).toMatchObject({ ok: false, code: "line_unpicked", error: expect.stringMatching(/你取消了勾选「X/) });
    expect(await run({ op: "final_check", platform: "x" })).toMatchObject({ ok: false, code: "line_unpicked" });
    expect((await boardData(env.dir)).items.find((i) => i.id === id)!.alerts.join("\n")).toMatch(/你取消了勾选「X/);
    expect((await executePublish({ action: "ego_lite_prepare", content_id: id, _dataDir: env.dir }) as { data: { packages: Array<{ platform: string }> } }).data.packages.map((p) => p.platform)).toEqual(["youtube"]);
  });

  it("verifier P3 英文发布包的 brief 直接写 YouTube 标题、章节和 X 帖子", async () => {
    await completePackage();
    const item = ((await listForChat(env.dir, { content_id: id })).items as Array<Record<string, unknown>>).find((i) => String(i.item_id).startsWith("enpkg:"))!;
    const brief = String(item.brief);
    expect(brief).toContain("YouTube 标题：Why max effort makes AI drift");
    expect(brief).toContain("YouTube 章节：0:00 The instinct / 0:10 The test / 0:20 Instead");
    expect(brief).toMatch(/X 帖子：Max effort is not a free upgrade\./);
  });

  it("spec §9.2 两个英文平台都取消勾选：不拿空包请他重批，出口全拒；重新勾上照旧能发", async () => {
    await completePackage();
    expect(await approvePackage()).toMatchObject({ ok: true });
    await updateProfile({ platforms: ["douyin"] }, env.dir);
    expect(await pkgItem()).toBeUndefined();
    expect(await run({ op: "final_check", platform: "youtube" })).toMatchObject({ ok: false, error: expect.stringMatching(/你取消了勾选 YouTube 和 X/) });
    expect(await executePublish({ action: "ego_lite_prepare", content_id: id, _dataDir: env.dir })).toMatchObject({ ok: false, code: "line_unpicked" });
    await updateProfile({ platforms: ["douyin", "youtube", "x"] }, env.dir);
    expect(await run({ op: "final_check", platform: "youtube" })).toMatchObject({ ok: true });
  });

  it("P2-4 复制件：X 正文只出现一次标签、X 的发布页；YouTube 分标题 / 说明 / tags、YouTube 的发布页", async () => {
    await completePackage();
    await approvePackage();
    const x = (await executePublish({ action: "clipboard", content_id: id, platform: "x", _dataDir: env.dir }) as { data: Record<string, string> }).data;
    expect(x).toMatchObject({ platform: "x", copyText: "Max effort is not a free upgrade.\n\n#AI", publishUrl: "https://x.com/compose/post" });
    const y = (await executePublish({ action: "clipboard", content_id: id, platform: "youtube", _dataDir: env.dir }) as { data: Record<string, string> }).data;
    expect(y).toMatchObject({ platform: "youtube", formattedTitle: YT.post_title, tags: "AI, Claude", publishUrl: "https://studio.youtube.com" });
    expect(y.formattedBody).toContain("0:10 The test");
    expect(JSON.stringify([x, y])).not.toContain("xiaohongshu");
  });

  it("P2-5 退回 A、退回 B（要改回 A）、改回 A：那件照样出现、能批", async () => {
    await completePackage();
    const revise = async (note: string) => { const it = (await pkgItem())!; expect(await decideItem({ item_id: it.item_id, gen: it.gen, action: "revise_en_package", content_id: id, note }, env.dir)).toMatchObject({ ok: true }); };
    await revise("X 文案换一句");
    await kit("x", { post_text: "Version B of the post.", hashtags: ["AI"] });
    await revise("还是改回原来那句");
    await kit("x", X);
    expect(await pkgItem()).toBeDefined();
    expect(await approvePackage()).toMatchObject({ ok: true });
  });
});

describe("中文视频的登记出口不受影响", () => {
  it("源视频（中文）出浏览器包照旧要登记（没封面 → 登记卡住），不读英文发布包", async () => {
    const r = await executePublish({ action: "ego_lite_prepare", content_id: srcId, _dataDir: env.dir }) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: false, code: "check_required" });
    const chk = await executePrePublish({ action: "check", content_id: srcId, platform: "douyin", _dataDir: env.dir }) as Record<string, unknown>;
    expect((chk.checks as Array<{ name: string; status: string }>).find((c) => c.name === "登记（发布出口）")).toMatchObject({ status: "fail" });
  });
});
