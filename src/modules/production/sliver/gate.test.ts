/**
 * 抽帧检查的触发、快照、拦截与放行（spec 2026-09-30 §5–§8、§12；E1–E5、E12–E18、E20、E21、E27、E28）。
 * 假的 ChatCut 工程目录建在临时库旁边，探针注入；不碰真实 ChatCut 目录。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../../storage/local-store.js";
import { readProductionDoc } from "../../../storage/production-store.js";
import { executeContentSave } from "../../../tools/content-save.js";
import { founderDecision } from "../decisions.js";
import { cardPanel } from "../panel.js";
import { explainContent } from "../read.js";
import { reconcileAll } from "../reconcile.js";
import { founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "../testkit.js";
import { setChatcutDeps, type MediaInfo } from "./chatcut-read.js";
import { runSliverCheck, snapshotRel } from "./check.js";
import { ASSETS, aroll, broll, timeline } from "./fixtures.js";
import type { Json, SnapshotAsset } from "./snapshot-types.js";
import { SUGGEST } from "./suggest.js";
import { hostPolicy } from "../../../../mcp/host-policy.js";

let env: Env, ccRoot: string;
let media: (f: string) => Promise<MediaInfo | { error: string }>;
const PID = "proj-test-1";
const CUT_FRAMES = 300;
const defaultMedia = async (f: string): Promise<MediaInfo> => (f.startsWith("/fake/") ? { pix_fmt: f.endsWith(".png") ? "rgb24" : "yuv420p" } : { r_frame_rate: "30/1", nb_frames: CUT_FRAMES });

beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  ccRoot = path.join(path.dirname(env.dir), "chatcut-projects");
  media = defaultMedia;
  setChatcutDeps({ projectsRoot: () => ccRoot, media: (f) => media(f) });
});
afterEach(async () => { setChatcutDeps(null); await env.cleanup(); });

/** 原片素材时长 = 假探针给的 12 秒：路径 / sha 对不上时按时长唯一认（与真实工程一样，原片被挪进项目后路径变了） */
const CC_ASSETS: Record<string, SnapshotAsset> = { ...ASSETS, A: { ...ASSETS.A, path: "/elsewhere/raw.mov", duration: 12_000_000 } };

/** 在假 ChatCut 目录写一个工程；mtimeAgoMs = 时间线文件的修改时间离现在多久 */
async function writeProject(tls: Json[], o: { schema?: number; mtimeAgoMs?: number; assets?: Record<string, SnapshotAsset> } = {}): Promise<void> {
  const dir = path.join(ccRoot, PID, "project.chatcutproject");
  await fs.mkdir(path.join(dir, "timelines"), { recursive: true });
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  const assets = o.assets ?? CC_ASSETS;
  const entries = [];
  for (const [i, tl] of tls.entries()) {
    const rel = `timelines/Timeline_${i}abc.json`;
    await fs.writeFile(path.join(dir, rel), JSON.stringify(tl));
    const t = new Date(Date.now() - (o.mtimeAgoMs ?? 120_000));
    await fs.utimes(path.join(dir, rel), t, t);
    entries.push({ id: tl.id, resourcePath: rel });
  }
  const byKind: Record<string, Json[]> = { videoAssets: [], imageAssets: [], motionGraphicAssets: [] };
  for (const a of Object.values(assets)) {
    const rel = `assets/${a.id}_x.json`;
    const { pix_fmt: _drop, ...meta } = a;
    await fs.writeFile(path.join(dir, rel), JSON.stringify(meta));
    byKind[a.type === "image" ? "imageAssets" : a.type === "motion-graphic" ? "motionGraphicAssets" : "videoAssets"].push({ id: a.id, name: a.name, resourcePath: rel });
  }
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify({ projectId: PID, schemaVersion: o.schema ?? 4, timelines: entries, ...byKind }));
}

const gapTimeline = (gap: number, id = "tl-1") => ({ ...timeline({ videoItems: [aroll("ar", 0, 300), broll("b1", 30, 70), broll("b2", 100 + gap, 100 - gap)] }), id });
const decide = (id: string, action: string, p: Record<string, unknown> = {}) => founderDecision(id, action, p, env.dir);

/** 认过稿、原片、（可选）ChatCut 工程、成片、（可选）字幕 */
async function setup(o: { chatcut?: boolean; srt?: string | null; cutBytes?: string; timelineId?: string } = {}) {
  const c = await videoContent(env, "AI 又忘了怎么办");
  await founderApprove(env, c.id);
  const ar = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
  if (o.chatcut !== false) await record(env, { content_id: c.id, kind: "chatcut_project", chatcut_project_id: PID, uses_aroll: [ar.fact_id], ...(o.timelineId ? { timeline_id: o.timelineId } : {}), request_id: "cc" });
  const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "抽帧测试.mp4"), o.cutBytes ?? "cut-v1"), request_id: "c" });
  if (o.srt !== null) await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "抽帧测试.srt"), o.srt ?? "1\n00:00:01,000 --> 00:00:02,000\n你好\n"), for_cut: cut.fact_id, request_id: "s" });
  const doc = (await readProductionDoc(c.id, env.dir))!;
  const sha = doc.facts.find((f) => f.id === cut.fact_id)!.sha256!;
  return { c, cut, sha, approve: { fact_id: cut.fact_id as string, sha256: sha } };
}
const checks = async (id: string) => (await readProductionDoc(id, env.dir))!.sliver_checks ?? [];
type Panel = { slivers: { status: string; reason: string | null; fingerprint: string; whole_waivable: boolean; items: Array<{ key: string; suggestion: string; waived: boolean; frames: number }> } };

describe("有缝：拦、逐处放行（§6、§12-1、§12-8）", () => {
  it("成片报上来就查并拍快照；有缝拒「成片通过」；模型放行被拒；逐处放行后才能通过", async () => {
    await writeProject([gapTimeline(5)]);
    const s = await setup();
    expect(await fs.stat(path.join(projectRoot(env, s.c.id), snapshotRel(s.sha))).then(() => true)).toBe(true);
    const [check] = await checks(s.c.id);
    expect(check).toMatchObject({ status: "slivers", slivers: [{ start_frame: 100, end_frame: 105, frames: 5 }] });
    expect(await decide(s.c.id, "approve_cut", s.approve)).toMatchObject({ ok: false, code: "sliver_blocked" });
    const exp = await explainContent((await getContent(s.c.id, env.dir))!, env.dir);
    expect(exp.missing).toContain("抽帧缝 1 处");
    expect(exp.alerts).toContain("抽帧缝 1 处");
    const panel = (await cardPanel(s.c.id, env.dir)) as unknown as Panel;
    const item = panel.slivers.items[0];
    expect(panel.slivers).toMatchObject({ status: "slivers", whole_waivable: false });
    const params = { cut_sha: s.sha, fingerprint: panel.slivers.fingerprint, sliver_key: item.key };
    expect(await founderDecision(s.c.id, "waive_sliver", { ...params, _host: "codex" }, env.dir)).toMatchObject({ ok: false, code: "founder_only" });
    expect(await decide(s.c.id, "waive_sliver", { ...params, sliver_key: "1-2-x-y" })).toMatchObject({ ok: false, code: "stale" });
    expect(await decide(s.c.id, "waive_sliver_check", { cut_sha: s.sha })).toMatchObject({ ok: false, code: "not_unchecked" }); // E13
    expect(await decide(s.c.id, "waive_sliver", params)).toMatchObject({ ok: true });
    expect(((await cardPanel(s.c.id, env.dir)) as unknown as Panel).slivers.items[0].waived).toBe(true);
    expect(await decide(s.c.id, "approve_cut", s.approve)).toMatchObject({ ok: true });
  });

  it("没有缝：直接通过", async () => {
    await writeProject([gapTimeline(30)]);
    const s = await setup();
    expect((await checks(s.c.id))[0]).toMatchObject({ status: "clean" });
    expect(await decide(s.c.id, "approve_cut", s.approve)).toMatchObject({ ok: true });
  });

  it("E28 放行只对当前结果那一处：快照变了（指纹变）→ 旧放行不算，重新拦", async () => {
    await writeProject([gapTimeline(5)]);
    const s = await setup();
    const p = ((await cardPanel(s.c.id, env.dir)) as unknown as Panel).slivers;
    await decide(s.c.id, "waive_sliver", { cut_sha: s.sha, fingerprint: p.fingerprint, sliver_key: p.items[0].key });
    const snapFile = path.join(projectRoot(env, s.c.id), snapshotRel(s.sha));
    const j = JSON.parse(await fs.readFile(snapFile, "utf8")) as { meta: Json };
    j.meta.taken_at = "changed";
    await fs.writeFile(snapFile, JSON.stringify(j));
    expect(await decide(s.c.id, "approve_cut", s.approve)).toMatchObject({ ok: false, code: "sliver_blocked" });
  });

  it("E12 换成片（sha 变）→ 放行不继承", async () => {
    await writeProject([gapTimeline(5)]);
    const s = await setup();
    const p = ((await cardPanel(s.c.id, env.dir)) as unknown as Panel).slivers;
    await decide(s.c.id, "waive_sliver", { cut_sha: s.sha, fingerprint: p.fingerprint, sliver_key: p.items[0].key });
    const v2 = await record(env, { content_id: s.c.id, kind: "cut", path: await put(path.join(env.chatcut, "抽帧测试-v2.mp4"), "cut-v2"), request_id: "c2" });
    const sha2 = (await readProductionDoc(s.c.id, env.dir))!.facts.find((f) => f.id === v2.fact_id)!.sha256!;
    expect(await decide(s.c.id, "approve_cut", { fact_id: v2.fact_id, sha256: sha2 })).toMatchObject({ ok: false, code: "sliver_blocked" });
    expect(await decide(s.c.id, "waive_sliver", { cut_sha: s.sha, fingerprint: p.fingerprint, sliver_key: p.items[0].key })).toMatchObject({ ok: false, code: "stale" });
  });

  it("E27 修法按字幕：缝里有字幕 → 拖长；没有 → 剪气口；没有字幕事实 → 请人工判断；结论不变", async () => {
    await writeProject([gapTimeline(5)]);
    const noSrt = await setup({ srt: null });
    expect((await checks(noSrt.c.id)).at(-1)).toMatchObject({ status: "slivers", slivers: [{ suggestion: SUGGEST.manual }] });
    // 字幕后到：同一结果只刷新建议，不新增检查、不换指纹（放行不失效）
    const fp = (await checks(noSrt.c.id)).at(-1)!.fingerprint;
    await record(env, { content_id: noSrt.c.id, kind: "srt", path: await put(path.join(env.chatcut, "后到.srt"), "1\n00:00:03,000 --> 00:00:04,000\n话\n"), for_cut: noSrt.cut.fact_id, request_id: "s2" });
    expect(await checks(noSrt.c.id)).toHaveLength(1);
    expect((await checks(noSrt.c.id))[0]).toMatchObject({ fingerprint: fp, slivers: [{ suggestion: SUGGEST.hold }] });
  });
  it("E27 缝里没有字幕 → 剪气口", async () => {
    await writeProject([gapTimeline(5)]);
    const quiet = await setup({ srt: "1\n00:00:05,000 --> 00:00:06,000\n话\n" });
    expect((await checks(quiet.c.id)).at(-1)).toMatchObject({ status: "slivers", slivers: [{ suggestion: SUGGEST.trim }] });
  });
});

describe("没跑成：拦、写原因、整条放行（§8、E1–E5、E14、E17、E21）", () => {
  const reasonOf = async (id: string) => (await checks(id)).at(-1);

  it("E1 没有 chatcut_project 事实 → 未检查；拦；整条放行后能通过", async () => {
    const s = await setup({ chatcut: false });
    expect(await reasonOf(s.c.id)).toMatchObject({ status: "unchecked", reason: expect.stringContaining("没有 ChatCut 工程记录") });
    expect(await decide(s.c.id, "approve_cut", s.approve)).toMatchObject({ ok: false, code: "sliver_blocked" });
    expect(await founderDecision(s.c.id, "waive_sliver_check", { cut_sha: s.sha, _modelCall: true }, env.dir)).toMatchObject({ ok: false, code: "founder_only" });
    expect(await decide(s.c.id, "waive_sliver_check", { cut_sha: s.sha })).toMatchObject({ ok: true });
    expect(await decide(s.c.id, "approve_cut", s.approve)).toMatchObject({ ok: true });
  });

  it("E2 工程目录不存在 → 未检查（不是 ChatCut 剪的 / 没装）", async () => {
    const s = await setup();
    expect(await reasonOf(s.c.id)).toMatchObject({ status: "unchecked", reason: expect.stringContaining("本机找不到这个 ChatCut 工程") });
  });

  it("E3 schemaVersion 不认识 → 未检查", async () => {
    await writeProject([gapTimeline(5)], { schema: 5 });
    expect(await reasonOf((await setup()).c.id)).toMatchObject({ status: "unchecked", reason: expect.stringContaining("格式版本（5）不认识") });
  });

  it("E4 多条时间线且没指定 → 未检查；带 timeline_id 就查那条", async () => {
    await writeProject([gapTimeline(5, "tl-a"), gapTimeline(30, "tl-b")]);
    expect(await reasonOf((await setup()).c.id)).toMatchObject({ status: "unchecked", reason: expect.stringContaining("不知道是哪条") });
  });
  it("E4 带 timeline_id 就查那条", async () => {
    await writeProject([gapTimeline(5, "tl-a"), gapTimeline(30, "tl-b")]);
    expect(await reasonOf((await setup({ timelineId: "tl-b" })).c.id)).toMatchObject({ status: "clean" });
  });

  it("E5 时长对不上 → 未检查", async () => {
    await writeProject([gapTimeline(5)]);
    media = async (f) => (f.startsWith("/fake/") ? defaultMedia(f) : { r_frame_rate: "30/1", nb_frames: 250 });
    expect(await reasonOf((await setup()).c.id)).toMatchObject({ status: "unchecked", reason: expect.stringContaining("对不上") });
  });

  it("E21 导出后时间线又保存过 → 未检查，不拍快照", async () => {
    await writeProject([gapTimeline(5)], { mtimeAgoMs: 0 });
    const s = await setup();
    expect(await reasonOf(s.c.id)).toMatchObject({ status: "unchecked", reason: expect.stringContaining("导出后时间线又保存过") });
    expect(await fs.stat(path.join(projectRoot(env, s.c.id), snapshotRel(s.sha))).then(() => true, () => false)).toBe(false);
  });

  it("E17 认不出 A-roll → 未检查", async () => {
    await writeProject([gapTimeline(5)], { assets: { ...CC_ASSETS, A: { ...CC_ASSETS.A, duration: 99_000_000 } } });
    expect(await reasonOf((await setup()).c.id)).toMatchObject({ status: "unchecked", reason: expect.stringContaining("认不出 A-roll") });
  });

  it("E14 帧率读取出错 → 未检查（临时，不缓存）；修好后下次触发重试出结论；从不当 clean", async () => {
    await writeProject([gapTimeline(5)]);
    media = async (f) => (f.startsWith("/fake/") ? defaultMedia(f) : { error: "ffprobe 读不了这个文件" });
    const s = await setup();
    expect(await reasonOf(s.c.id)).toMatchObject({ status: "unchecked", transient: true, reason: expect.stringContaining("读不出成片帧率") });
    media = defaultMedia;
    await runSliverCheck(s.c.id, env.dir);
    expect(await reasonOf(s.c.id)).toMatchObject({ status: "slivers" });
  });
});

describe("触发、缓存与范围（E15、E16、E18、E20）", () => {
  it("E18 同一成片 + 同一快照只查一次（对账反复跑不追加）", async () => {
    await writeProject([gapTimeline(5)]);
    const s = await setup();
    await reconcileAll(env.dir);
    await reconcileAll(env.dir);
    expect(await checks(s.c.id)).toHaveLength(1);
  });

  it("E16 当前成片已通过 / 本体没启用：不查", async () => {
    await writeProject([gapTimeline(30)]);
    const s = await setup();
    await decide(s.c.id, "approve_cut", s.approve);
    expect(await runSliverCheck(s.c.id, env.dir)).toBeNull();
  });

  it("E20 没有结果默认拦：结果被清掉后推导写「还没有结果」，批准时服务端重跑", async () => {
    await writeProject([gapTimeline(5)]);
    const s = await setup();
    const file = path.join(projectRoot(env, s.c.id), "00-project", "autocrew", "production.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Json;
    raw.sliver_checks = [];
    await fs.writeFile(file, JSON.stringify(raw));
    expect((await explainContent((await getContent(s.c.id, env.dir))!, env.dir)).missing).toContain("抽帧检查还没有结果");
    expect(await decide(s.c.id, "approve_cut", s.approve)).toMatchObject({ ok: false, code: "sliver_blocked", error: expect.stringContaining("抽帧缝 1 处") });
  });

  it("E15 check_slivers：返回同样的缝，不写任何记录；codex 白名单放行", async () => {
    await writeProject([gapTimeline(5)]);
    const s = await setup();
    const before = (await readProductionDoc(s.c.id, env.dir))!.revision;
    const r = await executeContentSave({ _dataDir: env.dir, _host: "codex", action: "check_slivers", content_id: s.c.id }) as Json;
    expect(r).toMatchObject({ ok: true, status: "slivers", written: false, slivers: [{ start_frame: 100, end_frame: 105 }] });
    expect((await readProductionDoc(s.c.id, env.dir))!.revision).toBe(before);
    expect(hostPolicy("codex", "autocrew_content", { action: "check_slivers" }, true)).toEqual({ ok: true });
  });
});
