/** 对账自己去找（1b §4 收件箱自动挪、§5 监视文件夹、§6 导出目录）：假转写器、合成正文 */
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoardHandler } from "../../desktop/board-route.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact } from "../../storage/production-types.js";
import { founderDecision } from "./decisions.js";
import { setMatchDeps } from "./match/deps.js";
import { listMatchJobs, matchWorkerIdle, MAX_RETRIES, RETRY_DELAY_MS } from "./match/queue.js";
import type { TranscribeOutcome } from "./match/transcribe.js";
import { synth } from "./match/synth-fixture.js";
import { reconcileAll } from "./reconcile.js";
import { exists, makeEnv, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
let calls: string[];
let clock: number;
beforeEach(async () => { env = await makeEnv({ enabled: true }); calls = []; clock = Date.now(); });
afterEach(async () => { await matchWorkerIdle(env.dir); await env.cleanup(); });

const CAL = { calibrated: true, floor: 0.3, margin: 0.2 };
const A = synth(21, 500), B = synth(22, 500);

function asr(answer: (file: string) => Promise<TranscribeOutcome> | TranscribeOutcome, paused = false): void {
  setMatchDeps({ thresholds: CAL, now: () => clock, paused: async () => paused, transcriber: { notReady: async () => null, transcribe: async (f) => { calls.push(path.basename(f)); return answer(f); } } });
}
const heardFrom = (map: Record<string, string>) => (f: string): TranscribeOutcome => ({ ok: true, text: map[path.basename(f)] ?? synth(99, 200) });

async function tick(): Promise<Awaited<ReturnType<typeof reconcileAll>>> {
  await reconcileAll(env.dir);
  await matchWorkerIdle(env.dir);
  return reconcileAll(env.dir);
}
async function facts(id: string, kind: Fact["kind"] = "aroll"): Promise<Fact[]> {
  const d = await readProductionDocOrEmpty(id, env.dir);
  return d.facts.filter((f) => f.kind === kind);
}

describe("§4 收件箱自动挪", () => {
  it("开头转写对上等原片的稿 → 自动挂上、挪进项目、标 auto_attached，badge 说不对就点「不是这条」", async () => {
    asr(heardFrom({ "IMG_1.mov": A.slice(20, 160) }));
    const a = await videoContent(env, "甲稿收件箱测试", "draft_ready", A);
    await videoContent(env, "乙稿收件箱测试", "draft_ready", B);
    const src = await put(path.join(env.inbox, "IMG_1.mov"), "take-1");
    await tick();
    expect(await facts(a.id)).toMatchObject([{ state: "accepted", auto_attached: true, source: "reconcile", source_path: src }]);
    expect(await exists(src)).toBe(false);
  });

  it("同一批两个文件都指向同一条 → 全部候选，不自动认（B29 / 多 take）", async () => {
    asr(heardFrom({ "IMG_1.mov": A.slice(20, 160), "IMG_2.mov": A.slice(200, 340) }));
    const a = await videoContent(env, "甲稿多take测试", "draft_ready", A);
    await videoContent(env, "乙稿多take测试", "draft_ready", B);
    await put(path.join(env.inbox, "IMG_1.mov"), "take-1");
    await put(path.join(env.inbox, "IMG_2.mov"), "take-2");
    await tick();
    const fs1 = await facts(a.id);
    expect(fs1.map((f) => f.state)).toEqual(["candidate", "candidate"]);
    expect(fs1[0].evidence).toContain("多 take");
  });

  it("按批判定：批里还有在核对的，文件名已唯一对上的也先不挪（§14-5）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    asr(async () => { await gate; return { ok: true, text: synth(99, 200) }; });
    const a = await videoContent(env, "甲稿按批判定测试", "draft_ready", A);
    const named = await put(path.join(env.inbox, "甲稿按批判定测试-原片.mov"), "named");
    await put(path.join(env.inbox, "IMG_9.mov"), "unknown");
    await reconcileAll(env.dir);
    expect(await exists(named)).toBe(true);
    expect(await facts(a.id)).toEqual([]);
    release();
    await matchWorkerIdle(env.dir);
    await reconcileAll(env.dir);
    expect(await facts(a.id)).toMatchObject([{ state: "accepted", auto_attached: true }]);
  });

  it("这条已有本轮原片 → 后来的只做候选（E25）；点过「不是这条」的字节不再自动挪回来（B10）", async () => {
    asr(heardFrom({ "IMG_1.mov": A.slice(20, 160), "IMG_2.mov": A.slice(250, 390) }));
    const a = await videoContent(env, "甲稿已有原片测试", "draft_ready", A);
    await put(path.join(env.inbox, "IMG_1.mov"), "take-1");
    await tick();
    await put(path.join(env.inbox, "IMG_2.mov"), "take-2");
    await tick();
    expect((await facts(a.id)).map((f) => f.state)).toEqual(["accepted", "candidate"]);
    const cand = (await facts(a.id))[1];
    await founderDecision(a.id, "reject_candidate", { fact_id: cand.id, sha256: cand.sha256 }, env.dir);
    await tick();
    expect((await facts(a.id)).map((f) => f.state)).toEqual(["accepted", "rejected"]);
  });

  it("一个也不像 → 留原处、计入列头；像但分不开 → 前三名里像的做候选", async () => {
    asr(heardFrom({ "IMG_x.mov": synth(77, 200) }));
    await videoContent(env, "甲稿列头测试", "draft_ready", A);
    const src = await put(path.join(env.inbox, "IMG_x.mov"), "noise");
    const r = await tick();
    expect(r.inbox?.unmatched).toEqual([expect.objectContaining({ name: "IMG_x.mov", path: src })]);
    expect(await exists(src)).toBe(true);
  });

  it("没能比完（转写一直失败）与没对上分开：退避到头后进「没核对成」并进对账警告（B36、§14-14）", async () => {
    asr(() => ({ ok: false, unavailable: false, reason: "sidecar 崩了" }));
    await videoContent(env, "甲稿失败测试", "draft_ready", A);
    await put(path.join(env.inbox, "IMG_f.mov"), "bad");
    let r = await tick();
    expect(r.inbox).toMatchObject({ checking: 1, failed: [] });
    for (let i = 0; i < MAX_RETRIES; i++) { clock += RETRY_DELAY_MS; r = await tick(); }
    expect(r.inbox?.failed).toEqual([expect.objectContaining({ name: "IMG_f.mov", reason: expect.stringContaining("sidecar 崩了") })]);
    expect(r.warnings.join()).toContain("1 个视频没核对成");
    expect(r.inbox?.unmatched).toEqual([]);
  });

  it("暂停自动找原片：收件箱的转写不跑，文件留在「在核对」（B13）", async () => {
    asr(heardFrom({}), true);
    await videoContent(env, "甲稿暂停测试", "draft_ready", A);
    await put(path.join(env.inbox, "IMG_p.mov"), "p");
    const r = await tick();
    expect(calls).toEqual([]);
    expect(r.inbox?.checking).toBe(1);
  });
});

async function addWatch(dir: string, opts: Record<string, unknown> = {}): Promise<void> {
  const handler = createBoardHandler({ authorize: () => "session", originAllowed: () => true, resolveDataDir: async () => env.dir, readBody: async () => JSON.stringify({ op: "add_folder", path: dir, ...opts }) });
  let text = "";
  const res = { writeHead: () => res, end: (t?: string) => { text = t ?? ""; } } as unknown as http.ServerResponse;
  await handler({ method: "POST" } as http.IncomingMessage, res, new URL("http://x/api/board/aroll-sources"));
  expect(JSON.parse(text)).toMatchObject({ ok: true });
}

describe("Codex 审 segB P1：锁外发现、锁内提交之间池变了", () => {
  it("扫描后标题 / 正文改了 → 提交时按当前池用缓存转写重判，不按旧 winner 搬、不按新标题改名", async () => {
    const { autoAttach } = await import("./auto-attach.js");
    const { discoverExternal } = await import("./discover.js");
    const { withFileOwnership } = await import("./mutex.js");
    const { setContent } = await import("./testkit.js");
    asr(heardFrom({ "IMG_s.mov": A.slice(20, 160) }));
    const a = await videoContent(env, "甲稿快照测试", "draft_ready", A);
    const src = await put(path.join(env.inbox, "IMG_s.mov"), "take-s");
    await discoverExternal(env.dir);
    await matchWorkerIdle(env.dir);
    const found = await discoverExternal(env.dir);
    expect(found.autoMoves).toHaveLength(1);
    await setContent(env, a.id, { title: "改过的标题完全不同", body: synth(88, 500) });
    await withFileOwnership(() => autoAttach(env.dir, found.autoMoves[0]));
    expect(await exists(src)).toBe(true);
    expect((await facts(a.id)).filter((f) => f.state === "accepted")).toEqual([]);
  });
});

describe("Codex 审 segB2 与真实数据预演", () => {
  it("[P1] 读不出时长的视频（坏的 / 没拷完）不自动挪：留原处，进「没核对成」、列头与对账警告", async () => {
    asr(heardFrom({ "IMG_broken.mov": A.slice(20, 160) }));
    const a = await videoContent(env, "甲稿完整性测试", "draft_ready", A);
    const src = await put(path.join(env.inbox, "IMG_broken.mov"), "half");
    const r = await tick();
    expect(await exists(src)).toBe(true);
    expect(await facts(a.id)).toEqual([]);
    expect(r.inbox?.failed).toEqual([expect.objectContaining({ name: "IMG_broken.mov", reason: expect.stringContaining("moov atom not found") })]);
    expect(r.warnings.join()).toContain("IMG_broken.mov");
  });

  it("1a 留下的收件箱候选（对账建的、还在原处、字节没变、没被拒）→ 进 §4 批判定，原地升级同一条事实，不另建", async () => {
    const { withFileOwnership } = await import("./mutex.js");
    const { mutateProduction } = await import("./service.js");
    const { newId } = await import("../../storage/production-store.js");
    const { cachedSha } = await import("./observe.js");
    asr(heardFrom({}));
    const a = await videoContent(env, "一期留下的候选稿", "draft_ready", A);
    const src = await put(path.join(env.inbox, "一期留下的候选稿-原片.mov"), "old-candidate");
    const h = await cachedSha(src);
    const id = newId("fact");
    await withFileOwnership(() => mutateProduction(a.id, env.dir, (doc) => {
      doc.facts.push({ id, kind: "aroll", round: doc.round, state: "candidate", availability: "present", source: "reconcile", at: new Date().toISOString(),
        path: src, sha256: h.sha256, size: h.size, mtime_ms: h.mtime_ms, evidence: "文件名前缀对上标题（原片收件箱）" });
      return { value: null, events: [] };
    }));
    await tick();
    const fs1 = await facts(a.id);
    expect(fs1).toHaveLength(1);
    expect(fs1[0]).toMatchObject({ id, state: "accepted", auto_attached: true, path: "02-aroll/一期留下的候选稿-原片.mov" });
    expect(await exists(src)).toBe(false);
  });

  it("创始人 / agent 建的候选不在此列：照旧等人点", async () => {
    asr(heardFrom({}));
    const a = await videoContent(env, "人建候选的稿子", "draft_ready", A);
    const src = await put(path.join(env.inbox, "人建候选的稿子-原片.mov"), "x");
    await record(env, { content_id: a.id, kind: "aroll", path: await put(path.join(env.outside, "别处.mov"), "y"), request_id: "r0" });
    const { withFileOwnership } = await import("./mutex.js");
    const { mutateProduction } = await import("./service.js");
    const { cachedSha } = await import("./observe.js");
    const h = await cachedSha(src);
    await withFileOwnership(() => mutateProduction(a.id, env.dir, (doc) => {
      doc.facts.push({ id: "fact-agent-1", kind: "aroll", round: doc.round, state: "candidate", availability: "present", source: "record", at: new Date().toISOString(),
        path: src, sha256: h.sha256, size: h.size, mtime_ms: h.mtime_ms, evidence: "agent 报的" });
      return { value: null, events: [] };
    }));
    await tick();
    expect((await facts(a.id)).find((f) => f.id === "fact-agent-1")?.state).toBe("candidate");
    expect(await exists(src)).toBe(true);
  });
});

describe("§5 监视文件夹只出建议", () => {
  let watch: string;
  beforeEach(async () => { watch = path.join(path.dirname(env.dir), "downloads"); await fs.mkdir(watch); });

  it("对上等原片的稿 → 候选（从不自动挪，allow_move 也不挪）；对不上的静默跳过、不计入列头", async () => {
    asr(heardFrom({ "clip.mov": A.slice(20, 160) }));
    const a = await videoContent(env, "甲稿监视测试", "draft_ready", A);
    await addWatch(watch, { allow_move: true });
    const hit = await put(path.join(watch, "clip.mov"), "c");
    await put(path.join(watch, "cat.mov"), "cat");
    const r = await tick();
    expect(await facts(a.id)).toMatchObject([{ state: "candidate", path: hit }]);
    expect(await exists(hit)).toBe(true);
    expect(r.inbox?.unmatched ?? []).toEqual([]);
    expect(r.watch).toEqual([expect.objectContaining({ files: 2, suggested: 1 })]);
  });

  it("没有等原片的稿就不转写（B14）；超过 14 天的不看", async () => {
    asr(heardFrom({}));
    await addWatch(watch);
    await put(path.join(watch, "clip.mov"), "c");
    await tick();
    expect(calls).toEqual([]);
  });

  it("转写退避到头还失败 → 该行与对账警告写原因，不和「没对上」一起静默（Codex 审 segB P2）", async () => {
    asr(() => ({ ok: false, unavailable: false, reason: "sidecar 崩了" }));
    await videoContent(env, "甲稿监视失败", "draft_ready", A);
    await addWatch(watch);
    await put(path.join(watch, "clip.mov"), "c");
    let r = await tick();
    for (let i = 0; i < MAX_RETRIES; i++) { clock += RETRY_DELAY_MS; r = await tick(); }
    expect(r.watch?.[0].error).toContain("sidecar 崩了");
    expect(r.warnings.join()).toContain("sidecar 崩了");
  });

  it("读不了（EACCES）→ 该行给授权提示，看板警告同样列出（E30）", async () => {
    asr(heardFrom({}));
    await addWatch(watch);
    await fs.chmod(watch, 0o000);
    try {
      const r = await tick();
      expect(r.watch?.[0].error).toContain("隐私与安全性");
      expect(r.warnings.join()).toContain("隐私与安全性");
    } finally { await fs.chmod(watch, 0o755); }
  });
});

describe("§6 导出目录的新版本", () => {
  it("前缀认出 → 成片候选（已发布标 post_publish）；同名 .srt → 字幕候选绑这版成片；.wav 忽略", async () => {
    asr(heardFrom({}));
    const done = await videoContent(env, "已经发布的导出测试稿", "published", A);
    const cut = await put(path.join(env.chatcut, "已经发布的导出测试稿-v2.mp4"), "cut");
    await put(path.join(env.chatcut, "已经发布的导出测试稿-v2.srt"), "1\n00:00:00,000 --> 00:00:01,000\n字\n");
    await put(path.join(env.chatcut, "已经发布的导出测试稿-v2.wav"), "wav");
    await tick();
    const [c] = await facts(done.id, "cut");
    expect(c).toMatchObject({ state: "candidate", post_publish: true, path: cut });
    expect(await facts(done.id, "srt")).toMatchObject([{ state: "candidate", for_cut: c.sha256 }]);
    expect(calls).toEqual([]);
  });

  it("导出文件转写退避到头还失败 → 对账警告写原因（Codex 审 segB P2）", async () => {
    asr(() => ({ ok: false, unavailable: false, reason: "sidecar 崩了" }));
    await videoContent(env, "甲稿导出失败", "editing", A);
    await put(path.join(env.jianying, "export_x.mp4"), "e");
    let r = await tick();
    for (let i = 0; i < MAX_RETRIES; i++) { clock += RETRY_DELAY_MS; r = await tick(); }
    expect(r.warnings.join()).toContain("export_x.mp4");
    expect(r.warnings.join()).toContain("sidecar 崩了");
  });

  it("认不出名字 → 转写兜底（低优先级）；对上 → 成片候选；都不像 → 跳过", async () => {
    asr(heardFrom({ "export_001.mp4": B.slice(30, 170), "noise.mp4": synth(55, 200) }));
    await videoContent(env, "甲稿导出兜底", "editing", A);
    const b = await videoContent(env, "乙稿导出兜底", "editing", B);
    await put(path.join(env.jianying, "export_001.mp4"), "e1");
    await put(path.join(env.jianying, "noise.mp4"), "n");
    await tick();
    expect(await facts(b.id, "cut")).toMatchObject([{ state: "candidate", evidence: expect.stringContaining("剪辑软件导出") }]);
    expect((await listMatchJobs(env.dir)).every((j) => j.priority === "background")).toBe(true);
  });
});
