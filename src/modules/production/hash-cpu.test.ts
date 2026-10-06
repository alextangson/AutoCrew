/**
 * 读路径不再全量重算多 GB 媒体（fix/hash-cpu）：读 / 看走元数据缓存，提交点照常现算、一分钟内还在写的拒绝；
 * 登记核失败退避；缓存跨重启、清掉已删文件。计数缝 = manifest.sha256File 被调用的次数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { productionServiceDir, readProductionDoc } from "../../storage/production-store.js";
import { createProjectReviewHandler } from "../../desktop/project-review-route.js";
import { executeStatus } from "../../tools/status.js";
import { executeReviewInbox } from "../../tools/review-inbox.js";
import { fullHashCount } from "../video/handoff/manifest.js";
import { founderDecision } from "./decisions.js";
import { cachedSha, hashCacheSize, loadHashCache, resetHashCacheMemory, saveHashCache, setSettleMs, STILL_SETTLING, sweepHashCache } from "./hash-cache.js";
import { readInbox } from "./inbox-read.js";
import { registeredPackage } from "./publish-gate.js";
import { reconcileAll } from "./reconcile.js";
import { commitRegistration } from "./registration.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, SRT, videoContent, waiveSliverCheck, type Env } from "./testkit.js";
import { getContent } from "../../storage/local-store.js";
import { acquireLibraryLock } from "../../storage/library-lock.js";
import { syncMyContentView } from "../../storage/my-content-view.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { setSettleMs(null); vi.restoreAllMocks(); await env.cleanup(); });

/** 认过稿、报齐成片 / 字幕 / 一对封面；返回各事实（含项目内的绝对路径） */
async function edited(title = "缓存验收稿") {
  const c = await videoContent(env, title);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${title}-原片.mov`), "raw"), request_id: "a" });
  const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, `${title}.mp4`), "cut-v1"), request_id: "c", review: true });
  const srt = await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), SRT), for_cut: cut.fact_id, request_id: "s" });
  const c34 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c34.png"), png(900, 1200)), request_id: "p1" });
  const c43 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c43.png"), png(1200, 900)), version: 1, request_id: "p2" });
  const doc = (await readProductionDoc(c.id, env.dir))!;
  const fact = (id: unknown) => { const f = doc.facts.find((x) => x.id === id)!; return { fact_id: f.id, sha256: f.sha256!, abs: path.join(projectRoot(env, c.id), f.path!) }; };
  return { c, cut: fact(cut.fact_id), srt: fact(srt.fact_id), c34: fact(c34.fact_id), c43: fact(c43.fact_id) };
}
type Setup = Awaited<ReturnType<typeof edited>>;

const approveCut = async (s: Setup) => {
  await waiveSliverCheck(env, s.c.id, s.cut.sha256);
  return founderDecision(s.c.id, "approve_cut", { fact_id: s.cut.fact_id, sha256: s.cut.sha256 }, env.dir);
};
const pickCover = (s: Setup) => founderDecision(s.c.id, "pick_cover", {
  cover_3x4_fact_id: s.c34.fact_id, cover_3x4_sha: s.c34.sha256, cover_4x3_fact_id: s.c43.fact_id, cover_4x3_sha: s.c43.sha256,
}, env.dir);

/** 同样大小、同样修改时间、不同字节：元数据缓存认不出来，只有现算才逮得住 */
async function swapBytes(file: string, bytes: string | Buffer): Promise<void> {
  const st = await fs.stat(file);
  expect(Buffer.byteLength(bytes)).toBe(st.size);
  await fs.writeFile(file, bytes);
  await fs.utimes(file, st.atimeMs / 1000, st.mtimeMs / 1000);
  expect(Math.trunc((await fs.stat(file)).mtimeMs)).toBe(Math.trunc(st.mtimeMs));
}

const delta = async (fn: () => Promise<unknown>) => { const n = fullHashCount(); await fn(); return fullHashCount() - n; };

async function withArtifactServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const route = createProjectReviewHandler({ authorize: () => "session", originAllowed: () => true, resolveDataDir: async () => env.dir, readBody: async () => "" });
  const server = http.createServer((req, res) => { void route(req, res, new URL(req.url!, "http://x")).then((ok) => { if (!ok) res.writeHead(404).end(); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`); }
  finally { await new Promise<void>((r) => server.close(() => r())); }
}

describe("读路径：热身之后零次全量哈希", () => {
  it("收件箱 / status brief / review_inbox list / 对账 / 发布出口（读）/ 产物 Range 请求都不重算", async () => {
    const s = await edited();
    expect(await approveCut(s)).toMatchObject({ ok: true });
    expect(await pickCover(s)).toMatchObject({ ok: true });
    expect((await readProductionDoc(s.c.id, env.dir))!.registrations).toHaveLength(1);
    const content = (await getContent(s.c.id, env.dir))!;
    const rel = path.relative(projectRoot(env, s.c.id), s.cut.abs);
    const url = (base: string) => `${base}/api/project-artifact?content_id=${s.c.id}&path=${encodeURIComponent(rel)}&sha256=${s.cut.sha256}`;
    const readAll = async () => {
      await reconcileAll(env.dir);
      await readInbox(env.dir);
      await executeStatus({ _dataDir: env.dir, brief: true });
      await executeReviewInbox({ _dataDir: env.dir, action: "list" });
      expect(await registeredPackage(content, env.dir)).toMatchObject({ ok: true });
      await withArtifactServer(async (base) => {
        for (const range of ["bytes=0-1", "bytes=2-3", "bytes=4-5"]) expect((await fetch(url(base), { headers: { range } })).status).toBe(206);
      });
    };
    await readAll(); // 热身：第一次见可以算一次
    expect(await delta(readAll)).toBe(0);
  });
});

describe("「我的内容」同步：库没变就零次全量哈希", () => {
  it("syncMyContentView 第二次不重算登记文件", async () => {
    const s = await edited();
    await approveCut(s);
    await pickCover(s);
    const lib = path.dirname(env.dir), machine = path.join(lib, "machine");
    await fs.mkdir(machine, { recursive: true });
    await fs.writeFile(path.join(machine, "storage.json"), JSON.stringify({ version: 1, id: "lib-deadbeef", root: lib }));
    await fs.writeFile(path.join(lib, "autocrew-library.json"), JSON.stringify({ version: 1, id: "lib-deadbeef" }));
    vi.stubEnv("AUTOCREW_LOCAL_DIR", machine);
    const release = acquireLibraryLock(lib);
    try {
      const first = await syncMyContentView(env.dir);
      expect(first.skipped).toBeUndefined();
      expect((await getContent(s.c.id, env.dir))!.status).toBe("publish_ready");
      expect(await delta(() => syncMyContentView(env.dir))).toBe(0);
    } finally { release(); vi.unstubAllEnvs(); }
  });
});

describe("提交点：照常现算，字节被换（大小、修改时间不变）也逮得住", () => {
  it("批成片：现算并拒绝被换过的字节", async () => {
    const s = await edited();
    await reconcileAll(env.dir);
    await swapBytes(s.cut.abs, "cut-XX");
    await reconcileAll(env.dir); // 元数据没变：对账看不出来
    const n = fullHashCount();
    expect(await approveCut(s)).toMatchObject({ ok: false, code: "cut_replaced" });
    expect(fullHashCount()).toBeGreaterThan(n);
  });

  it("选封面：现算并拒绝被换过的字节", async () => {
    const s = await edited();
    await swapBytes(s.c34.abs, png(900, 1200, "y"));
    expect(await pickCover(s)).toMatchObject({ ok: false, code: "cover_replaced" });
  });

  it("登记提交：字幕被换过 → 不登记、说原因", async () => {
    const s = await edited();
    await swapBytes(s.srt.abs, SRT.replace("你好", "再见"));
    expect(await approveCut(s)).toMatchObject({ ok: true });
    const r = await pickCover(s);
    expect(r).toMatchObject({ ok: true });
    const doc = (await readProductionDoc(s.c.id, env.dir))!;
    expect(doc.registrations).toHaveLength(0);
    expect(doc.commit_failure?.reason).toContain("字幕被改过");
  });

  it("发布出口：读路径走缓存，发布前（fresh）现算并拦下被换过的成片", async () => {
    const s = await edited();
    await approveCut(s);
    await pickCover(s);
    const content = (await getContent(s.c.id, env.dir))!;
    const registered = await registeredPackage(content, env.dir);
    expect(registered).toMatchObject({ ok: true });
    const video = (registered as { files: { video: string } }).files.video;
    await swapBytes(video, "cut-XX");
    let fresh: unknown;
    expect(await delta(async () => { fresh = await registeredPackage(content, env.dir, { fresh: true }); })).toBeGreaterThan(0);
    expect(fresh).toMatchObject({ ok: false, code: "registered_file_changed" });
  });
});

describe("一分钟内还在写的文件", () => {
  it("扫描这轮跳过、之后再收；提交点拒绝并说「还在写」", async () => {
    setSettleMs(60_000);
    const c = await videoContent(env, "还在写稿");
    await founderApprove(env, c.id);
    const file = await put(path.join(projectRoot(env, c.id), "04-edit", "还在写稿.mp4"), "exporting", true);
    await reconcileAll(env.dir);
    expect((await readProductionDoc(c.id, env.dir))?.facts.filter((f) => f.kind === "cut") ?? []).toHaveLength(0);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(file, old, old);
    await reconcileAll(env.dir);
    const cut = (await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.kind === "cut")!;
    expect(cut).toBeTruthy();
    const now = new Date();
    await fs.utimes(file, now, now);
    await waiveSliverCheck(env, c.id, cut.sha256!);
    const n = fullHashCount();
    expect(await founderDecision(c.id, "approve_cut", { fact_id: cut.id, sha256: cut.sha256 }, env.dir)).toMatchObject({ ok: false, code: "file_unsettled", error: STILL_SETTLING });
    expect(fullHashCount()).toBe(n);
  });
});

describe("登记核失败退避", () => {
  it("相关文件元数据没变就不再重算；变了才重算", async () => {
    const s = await edited();
    await reconcileAll(env.dir); // 缓存热身：之后换字节（元数据不变）对账看不出来
    await swapBytes(s.srt.abs, SRT.replace("你好", "再见"));
    await approveCut(s);
    await pickCover(s); // 决定触发登记：现算、核失败，记下当时的元数据
    expect((await readProductionDoc(s.c.id, env.dir))!.commit_failure?.reason).toContain("字幕被改过");
    let r: unknown;
    expect(await delta(async () => { r = await commitRegistration(s.c.id, env.dir, { backoff: true }); })).toBe(0);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("字幕被改过") });
    const later = new Date(Date.now() - 30_000);
    await fs.utimes(s.srt.abs, later, later);
    expect(await delta(() => commitRegistration(s.c.id, env.dir, { backoff: true }))).toBeGreaterThan(0);
  });
});

describe("哈希缓存落盘", () => {
  it("跨重启还在；文件删了下一轮清掉", async () => {
    const file = await put(path.join(env.outside, "big.mp4"), "bytes");
    await loadHashCache(env.dir);
    await cachedSha(file);
    await saveHashCache(env.dir);
    resetHashCacheMemory();
    await loadHashCache(env.dir);
    expect(await delta(() => cachedSha(file))).toBe(0);
    await fs.rm(file);
    expect(await sweepHashCache()).toBeGreaterThanOrEqual(1);
    await saveHashCache(env.dir);
    resetHashCacheMemory();
    await loadHashCache(env.dir);
    const saved = JSON.parse(await fs.readFile(productionServiceDir(env.dir, "hash-cache.json"), "utf8")) as Record<string, unknown>;
    expect(saved[file]).toBeUndefined();
    expect(hashCacheSize()).toBe(Object.keys(saved).length);
  });
});
