/**
 * video-store.test.ts —— 存储层纪律（spec §2.1 / §2.6 / §3）。
 *
 * 这里测的都是「并发与崩溃之后还说不说得清」的性质：
 * 原子写、逐 content 串行、版本化产物不可覆盖、台账 latest-wins、心跳回收判定。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addAssets } from "../../storage/library-store.js";
import {
  VIDEO_LEASE_MS,
  appendVideoJob,
  jobKey,
  latestJobsView,
  latestRevision,
  readVideoAssets,
  readVideoJobs,
  readVersioned,
  readVideoState,
  recoverExpiredJobs,
  resolveAssetRef,
  serializeVideoWrite,
  transitionVideoState,
  videoAssetsDir,
  videoDir,
  videoJobsPath,
  writeVersioned,
  writeVideoAssets,
  writeVideoState,
} from "./video-store.js";
import type { VideoAssetEntry, VideoJob, VideoState } from "./types.js";

const CID = "content-1770000000000-abc123";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-store-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function state(over: Partial<VideoState> = {}): VideoState {
  return {
    schemaVersion: 1,
    entryType: "aroll",
    phase: "ingest",
    state: "idle",
    revisions: {},
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...over,
  };
}

const dir = () => videoDir(dataDir, CID);

describe("路径与 contentId 校验", () => {
  it("非法 contentId 直接抛（路径穿越在这里就断掉）", () => {
    expect(() => videoDir(dataDir, "../../etc")).toThrow(/非法 contentId/);
    expect(() => videoAssetsDir(dataDir, "not-a-content-id")).toThrow(/非法 contentId/);
  });

  it("任务台账落 <dataDir>/video/jobs.jsonl", () => {
    expect(videoJobsPath(dataDir)).toBe(path.join(dataDir, "video", "jobs.jsonl"));
  });
});

describe("state.json 读写", () => {
  it("没写过 → state 为 null 且不报警（未开始不是故障）", async () => {
    expect(await readVideoState(dataDir, CID)).toEqual({ state: null });
  });

  it("首写落盘并读回；写完目录里不留 tmp 残渣", async () => {
    await writeVideoState(dataDir, CID, state());
    expect((await readVideoState(dataDir, CID)).state).toMatchObject({ phase: "ingest", state: "idle" });
    expect(await fs.readdir(dir())).toEqual(["state.json"]);
  });

  it("凭空跳到管线中段被拒（无状态时按 ingest/idle 起算）", async () => {
    await expect(writeVideoState(dataDir, CID, state({ phase: "render", state: "running" })))
      .rejects.toThrow(/迁移非法/);
    expect((await readVideoState(dataDir, CID)).state).toBeNull();
  });

  it("非法迁移被拒且盘上旧状态一字不动", async () => {
    await writeVideoState(dataDir, CID, state());
    await expect(writeVideoState(dataDir, CID, state({ phase: "cut", state: "awaiting_human" })))
      .rejects.toThrow(/迁移非法/);
    expect((await readVideoState(dataDir, CID)).state).toMatchObject({ phase: "ingest", state: "idle" });
  });

  it("残留的 .tmp 垃圾不影响读", async () => {
    await writeVideoState(dataDir, CID, state());
    await fs.writeFile(path.join(dir(), "state.json.tmp-999-1-zz"), "{ 半个 JSON", "utf-8");
    expect((await readVideoState(dataDir, CID)).state).not.toBeNull();
  });

  it("文件损坏 → 视为无状态 + 可见告警，不崩", async () => {
    await writeVideoState(dataDir, CID, state());
    await fs.writeFile(path.join(dir(), "state.json"), "{ 崩在写一半", "utf-8");
    const read = await readVideoState(dataDir, CID);
    expect(read.state).toBeNull();
    expect(read.warning).toContain("损坏");
  });

  it("未来的 schemaVersion → 视为无状态 + 告警说明版本对不上", async () => {
    await writeVideoState(dataDir, CID, state());
    await fs.writeFile(path.join(dir(), "state.json"), JSON.stringify({ ...state(), schemaVersion: 9 }));
    const read = await readVideoState(dataDir, CID);
    expect(read.state).toBeNull();
    expect(read.warning).toContain("schemaVersion=9");
  });

  it("缺 phase/state 的半残记录同样按无状态处理", async () => {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(path.join(dir(), "state.json"), JSON.stringify({ schemaVersion: 1 }));
    expect((await readVideoState(dataDir, CID)).warning).toContain("缺少 phase/state");
  });
});

describe("transitionVideoState", () => {
  it("读-改-写在同一临界区；updatedAt 由本函数盖", async () => {
    await writeVideoState(dataDir, CID, state());
    const next = await transitionVideoState(dataDir, CID, (cur) => {
      expect(cur).toMatchObject({ phase: "ingest", state: "idle" });
      return { ...cur!, phase: "transcribe", state: "queued" };
    });
    expect(next.phase).toBe("transcribe");
    expect(next.updatedAt).not.toBe("2026-07-27T00:00:00.000Z");
    expect(Number.isNaN(Date.parse(next.updatedAt))).toBe(false);
  });

  it("mutator 产出非法迁移 → 抛错且不落盘", async () => {
    await writeVideoState(dataDir, CID, state());
    await expect(
      transitionVideoState(dataDir, CID, (cur) => ({ ...cur!, phase: "review", state: "done" })),
    ).rejects.toThrow(/迁移非法/);
    expect((await readVideoState(dataDir, CID)).state).toMatchObject({ phase: "ingest" });
  });

  it("同 content 并发 20 次：一次不丢、严格按投递顺序执行", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        transitionVideoState(dataDir, CID, (cur) => {
          const base = cur ?? state();
          return { ...base, revisions: { ...base.revisions, cut: (base.revisions.cut ?? 0) + 1 } };
        }),
      ),
    );
    expect(results.map((r) => r.revisions.cut)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await readVideoState(dataDir, CID)).state?.revisions.cut).toBe(20);
  });

  it("失败的写不卡住队列后续", async () => {
    const boom = serializeVideoWrite(CID, () => Promise.reject(new Error("炸了")));
    await expect(boom).rejects.toThrow("炸了");
    await expect(serializeVideoWrite(CID, () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("跨 content 互不阻塞", async () => {
    const other = "content-1770000000001-def456";
    await Promise.all([
      writeVideoState(dataDir, CID, state()),
      writeVideoState(dataDir, other, state()),
    ]);
    expect((await readVideoState(dataDir, other)).state).not.toBeNull();
  });
});

describe("版本化不可变产物", () => {
  it("写一版 → 读得回来", async () => {
    await writeVersioned(dir(), "transcript", 1, { segments: [] });
    expect(await readVersioned(dir(), "transcript", 1)).toEqual({ segments: [] });
    expect(await readVersioned(dir(), "transcript", 2)).toBeNull();
  });

  it("同 revision 重写被拒，原内容不变，且不留 tmp", async () => {
    await writeVersioned(dir(), "cut", 1, { keeps: ["s1"] });
    await expect(writeVersioned(dir(), "cut", 1, { keeps: [] })).rejects.toThrow(/不可覆盖/);
    expect(await readVersioned(dir(), "cut", 1)).toEqual({ keeps: ["s1"] });
    expect((await fs.readdir(dir())).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("非法 revision 被拒", async () => {
    await expect(writeVersioned(dir(), "cut", 0, {})).rejects.toThrow(/≥1 的整数/);
    await expect(writeVersioned(dir(), "cut", 1.5, {})).rejects.toThrow(/≥1 的整数/);
  });

  it("latestRevision 取最大版本；带连字符的 base 也解析得对", async () => {
    for (const rev of [1, 2, 10]) await writeVersioned(dir(), "render-manifest", rev, { rev });
    await writeVersioned(dir(), "timeline", 3, {});
    expect(await latestRevision(dir(), "render-manifest")).toBe(10);
    expect(await latestRevision(dir(), "timeline")).toBe(3);
  });

  it("目录不存在 / 一版都没有 → null", async () => {
    expect(await latestRevision(path.join(dataDir, "nope"), "cut")).toBeNull();
    await fs.mkdir(dir(), { recursive: true });
    expect(await latestRevision(dir(), "cut")).toBeNull();
  });

  it("tmp 残渣与别的 base 不会被算成版本", async () => {
    await writeVersioned(dir(), "cut", 1, {});
    await fs.writeFile(path.join(dir(), "cut.v7.json.tmp-1-2-ab"), "x");
    await fs.writeFile(path.join(dir(), "cut.vX.json"), "x");
    expect(await latestRevision(dir(), "cut")).toBe(1);
  });
});

describe("素材清单与 AssetRef 解析", () => {
  const entry: VideoAssetEntry = {
    assetId: "va-1",
    kind: "screen",
    ref: { kind: "video", file: "screen.mp4" },
    status: "ready",
    fingerprint: { size: 10, mtimeMs: 1, quickHash: "deadbeef" },
  };

  it("没写过 → 空清单（不是故障）", async () => {
    expect(await readVideoAssets(dataDir, CID)).toEqual([]);
  });

  it("写入后原样读回", async () => {
    await writeVideoAssets(dataDir, CID, [entry]);
    expect(await readVideoAssets(dataDir, CID)).toEqual([entry]);
  });

  it("损坏的 assets.json 也返回空清单", async () => {
    await writeVideoAssets(dataDir, CID, [entry]);
    await fs.writeFile(path.join(dir(), "assets.json"), "{坏", "utf-8");
    expect(await readVideoAssets(dataDir, CID)).toEqual([]);
  });

  it("video ref → contents/<id>/video/assets/<file>", async () => {
    const p = await resolveAssetRef(dataDir, CID, { kind: "video", file: "ai-1.mp4" });
    expect(p).toBe(path.join(dir(), "assets", "ai-1.mp4"));
  });

  it("content ref → contents/<id>/assets/<filename>", async () => {
    const p = await resolveAssetRef(dataDir, CID, { kind: "content", filename: "cover.png" });
    expect(p).toBe(path.join(dataDir, "contents", CID, "assets", "cover.png"));
  });

  it("library ref → 素材库记录里的原路径（引用不复制）", async () => {
    const src = path.join(dataDir, "raw.mp4");
    await fs.writeFile(src, "x");
    const { added } = await addAssets([src], null, dataDir);
    expect(added).toHaveLength(1);
    expect(await resolveAssetRef(dataDir, CID, { kind: "library", id: added[0].id })).toBe(src);
  });

  it("素材库里没有这条 → 人话报错，不返回 null 让调用方乱拼路径", async () => {
    await expect(resolveAssetRef(dataDir, CID, { kind: "library", id: "asset-1-zz" }))
      .rejects.toThrow(/素材库里找不到/);
  });

  it("文件名想穿越目录 → 抛错", async () => {
    await expect(resolveAssetRef(dataDir, CID, { kind: "video", file: "../../../etc/passwd" }))
      .rejects.toThrow(/非法素材文件名/);
    await expect(resolveAssetRef(dataDir, CID, { kind: "content", filename: ".." }))
      .rejects.toThrow(/非法素材文件名/);
  });
});

describe("jobs.jsonl 台账", () => {
  const newJob = (over: Partial<VideoJob> = {}) => ({
    contentId: CID,
    phase: "transcribe" as const,
    inputKey: "t1",
    ...over,
  });

  it("空台账 → 空数组", async () => {
    expect(await readVideoJobs(dataDir)).toEqual([]);
  });

  it("append 填默认值（jobId / queued / attempts 0）并落盘", async () => {
    const job = await appendVideoJob(dataDir, newJob());
    expect(job.jobId).toMatch(/^vjob-/);
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
    const raw = await fs.readFile(videoJobsPath(dataDir), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("损坏行跳过，不清空整个读视图", async () => {
    await appendVideoJob(dataDir, newJob());
    await fs.appendFile(videoJobsPath(dataDir), "{半行\n\n", "utf-8");
    await appendVideoJob(dataDir, newJob({ inputKey: "t2" }));
    expect(await readVideoJobs(dataDir)).toHaveLength(2);
  });

  it("latest-wins 按 {contentId, phase, inputKey}：同输入重复投递合并", async () => {
    await appendVideoJob(dataDir, newJob({ jobId: "j1" }));
    await appendVideoJob(dataDir, newJob({ jobId: "j1", status: "running", attempts: 1 }));
    await appendVideoJob(dataDir, newJob({ jobId: "j2", inputKey: "t2" }));
    const view = latestJobsView(await readVideoJobs(dataDir));
    expect(view).toHaveLength(2);
    expect(view[0]).toMatchObject({ jobId: "j1", status: "running" });
    expect(view[1]).toMatchObject({ jobId: "j2", inputKey: "t2" });
  });

  it("不同 phase 各自成队，不互相覆盖", async () => {
    await appendVideoJob(dataDir, newJob({ jobId: "j1" }));
    await appendVideoJob(dataDir, newJob({ jobId: "j2", phase: "render", inputKey: "t1" }));
    expect(latestJobsView(await readVideoJobs(dataDir))).toHaveLength(2);
    expect(jobKey({ contentId: CID, phase: "render", inputKey: "t1" })).toBe(`${CID}|render|t1`);
  });
});

describe("recoverExpiredJobs", () => {
  const now = Date.parse("2026-07-27T12:00:00.000Z");
  const running = (over: Partial<VideoJob>): VideoJob => ({
    jobId: "j", contentId: CID, phase: "render", inputKey: "k",
    status: "running", attempts: 1, ...over,
  });
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();

  it("心跳新鲜（1 分钟前续过租）→ 不回收", () => {
    expect(recoverExpiredJobs([running({ heartbeatAt: iso(60_000) })], now)).toEqual([]);
  });

  it("心跳超过 lease（10 分钟）→ 可回收", () => {
    const job = running({ heartbeatAt: iso(VIDEO_LEASE_MS + 1000) });
    expect(recoverExpiredJobs([job], now)).toEqual([job]);
  });

  it("没心跳时退回 claimedAt / startedAt 判定", () => {
    expect(recoverExpiredJobs([running({ claimedAt: iso(60_000) })], now)).toEqual([]);
    expect(recoverExpiredJobs([running({ startedAt: iso(VIDEO_LEASE_MS * 2) })], now)).toHaveLength(1);
  });

  it("一个时间戳都没有 / 时间戳不可解析 → 回收（它永远等不到续租）", () => {
    expect(recoverExpiredJobs([running({})], now)).toHaveLength(1);
    expect(recoverExpiredJobs([running({ heartbeatAt: "不是时间" })], now)).toHaveLength(1);
  });

  it("非 running 状态一律不回收", () => {
    const jobs = [
      running({ jobId: "a", inputKey: "k1", status: "queued" }),
      running({ jobId: "b", inputKey: "k2", status: "succeeded" }),
      running({ jobId: "c", inputKey: "k3", status: "failed" }),
    ];
    expect(recoverExpiredJobs(jobs, now)).toEqual([]);
  });

  it("按 latest-wins 判定：后来落定的 succeeded 覆盖早先的 running", () => {
    const jobs = [
      running({ jobId: "j1", heartbeatAt: iso(VIDEO_LEASE_MS * 2) }),
      running({ jobId: "j1", status: "succeeded", settledAt: iso(1000) }),
    ];
    expect(recoverExpiredJobs(jobs, now)).toEqual([]);
  });
});
