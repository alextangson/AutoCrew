/**
 * 统一比对器（1b §2 / §2.1）的纯函数与队列：合成正文 + 注入转写，不跑真模型、不含真实稿件文本。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, type PoolEntry, type Thresholds } from "./decide.js";
import { l1Strong } from "./l1.js";
import { readTranscript, transcriptCacheDir, writeTranscript } from "./cache.js";
import { setMatchDeps } from "./deps.js";
import { synth } from "./synth-fixture.js";
import { notReadyFix } from "./transcribe.js";
import { enqueueMatchJob, jobKey, listMatchJobs, matchWorkerIdle, MAX_RETRIES, registerMatchHandler, resetMatchQueue, RETRY_DELAY_MS, type JobResult, type JobSpec, type MatchJob } from "./queue.js";

const entry = (id: string, title: string, body: string): PoolEntry => ({ content_id: id, title, old_titles: [], round: 1, body_hash: `h-${id}`, body });
const CAL: Thresholds = { calibrated: true, floor: 0.5, margin: 0.15 };
const UNCAL: Thresholds = { ...CAL, calibrated: false };
const SHA = "a".repeat(64);

describe("判定：L1 强命中（统一定义，§2.1 / §14-18）", () => {
  it("1a 的标题前缀规则与 matchL1 全标题强命中都算强命中", () => {
    expect(l1Strong("用户访谈技巧拆解.mp4", "用户访谈技巧拆解：三个坑")).toBe(true);
    expect(l1Strong("用户访谈技巧拆解三个坑-原片.mov", "用户访谈技巧拆解：三个坑")).toBe(true);
    expect(l1Strong("随便.mp4", "用户访谈技巧拆解：三个坑")).toBe(false);
  });

  it("池里唯一强命中 → winner；两条都强命中 → 没有 winner", () => {
    const pool = [entry("a", "用户访谈技巧拆解", synth(1, 300)), entry("b", "另一条完全不同的稿", synth(2, 300))];
    expect(decide({ fileName: "用户访谈技巧拆解.mp4", sha256: SHA, pool, heard: { text: null, why: "x" } }).winner).toBe("a");
    const twin = [...pool, entry("c", "用户访谈技巧拆解（下）", synth(3, 300))];
    const d = decide({ fileName: "用户访谈技巧拆解.mp4", sha256: SHA, pool: twin, heard: { text: null, why: "转写环境没装好" } });
    expect(d.winner).toBeNull();
    expect(d.reason).toContain("只比了文件名");
  });
});

describe("判定：L2（§2.1）", () => {
  const bodies = [synth(11, 400), synth(12, 400), synth(13, 400)];
  const pool = bodies.map((b, i) => entry(`c${i}`, `标题${i}`, b));
  const spoken = bodies[1].slice(20, 140);

  it("校准前 L2 一律不自动认，只给前三名（B17）", () => {
    const d = decide({ fileName: "x.mov", sha256: SHA, pool, heard: { text: spoken } }, UNCAL);
    expect(d.winner).toBeNull();
    expect(d.top3[0].content_id).toBe("c1");
    expect(d.reason).toContain("没校准");
  });

  it("校准后：过下限且领先够多 → winner", () => {
    expect(decide({ fileName: "x.mov", sha256: SHA, pool, heard: { text: spoken } }, CAL).winner).toBe("c1");
  });

  it("短转写（< 80 有效字）与空转写不自动认", () => {
    expect(decide({ fileName: "x.mov", sha256: SHA, pool, heard: { text: bodies[1].slice(0, 40) } }, CAL).winner).toBeNull();
    expect(decide({ fileName: "x.mov", sha256: SHA, pool, heard: { text: "" } }, CAL).reason).toContain("没听到人声");
  });

  it("差距不够（两条正文几乎一样）→ 没有 winner", () => {
    const twin = [entry("a", "甲", bodies[0]), entry("b", "乙", bodies[0])];
    expect(decide({ fileName: "x.mov", sha256: SHA, pool: twin, heard: { text: bodies[0].slice(0, 120) } }, CAL).winner).toBeNull();
  });

  it("池里只有一条：第二名按 0 算，但下限仍要过", () => {
    const one = [entry("a", "甲", bodies[0])];
    expect(decide({ fileName: "x.mov", sha256: SHA, pool: one, heard: { text: bodies[0].slice(0, 120) } }, CAL).winner).toBe("a");
    expect(decide({ fileName: "x.mov", sha256: SHA, pool: one, heard: { text: synth(99, 120) } }, CAL).winner).toBeNull();
  });

  it("结果带作业输入快照：文件 sha、每条稿的 round / 正文哈希 / 标题", () => {
    const d = decide({ fileName: "x.mov", sha256: SHA, pool, heard: { text: spoken } });
    expect(d.snapshot).toEqual({ sha256: SHA, pool: pool.map((p) => ({ content_id: p.content_id, round: 1, body_hash: p.body_hash, title: p.title })) });
  });
});

describe("转写缓存与作业队列（§2，B34 / B36）", () => {
  let dir: string;
  let clock: number;
  let seen: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-matchq-"));
    clock = 1_000_000;
    seen = [];
    resetMatchQueue();
    setMatchDeps({ now: () => clock, paused: async () => false });
  });
  afterEach(async () => {
    await matchWorkerIdle(dir);
    resetMatchQueue();
    setMatchDeps(null);
    await fs.rm(dir, { recursive: true, force: true });
  });

  const spec = (over: Partial<JobSpec> = {}): JobSpec => ({ purpose: "test_ok", priority: "background", sha256: SHA, path: "/x.mov", size: 1, mtime_ms: 1, target: "pool:1", payload: {}, ...over });

  it("缓存按完整 sha256 存，不收短键；不进资料库目录以外的奇怪位置", async () => {
    await writeTranscript(dir, SHA, "开头的话");
    expect((await readTranscript(dir, SHA))?.text).toBe("开头的话");
    await expect(writeTranscript(dir, "abc123", "x")).rejects.toThrow("完整 sha256");
    expect(transcriptCacheDir(dir)).toContain("aroll-transcripts");
  });

  it("同键不重复入队；有人明确要的先跑", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    registerMatchHandler("test_block", async ({ job }) => { seen.push(job.priority); await gate; return { state: "done", outcome: "ok" }; });
    registerMatchHandler("test_ok", async ({ job }) => { seen.push(job.priority); return { state: "done", outcome: "ok" }; });
    await enqueueMatchJob(dir, spec({ purpose: "test_block", target: "t0", priority: "explicit" }));
    await new Promise((r) => setTimeout(r, 20));
    const a = await enqueueMatchJob(dir, spec());
    const again = await enqueueMatchJob(dir, spec());
    expect(again.id).toBe(a.id);
    await enqueueMatchJob(dir, spec({ priority: "explicit", target: "t1" }));
    release();
    await matchWorkerIdle(dir);
    expect(seen).toEqual(["explicit", "explicit", "background"]);
    expect((await listMatchJobs(dir)).filter((j) => j.key === jobKey(spec()))).toHaveLength(1);
  });

  it("暂停只停自己去找的：明确要的照跑，background 留在排队", async () => {
    setMatchDeps({ now: () => clock, paused: async () => true });
    registerMatchHandler("test_ok", async ({ job }) => { seen.push(job.priority); return { state: "done", outcome: "ok" }; });
    await enqueueMatchJob(dir, spec());
    await enqueueMatchJob(dir, spec({ priority: "explicit", target: "t1" }));
    await matchWorkerIdle(dir);
    expect(seen).toEqual(["explicit"]);
    expect((await listMatchJobs(dir)).find((j) => j.priority === "background")?.state).toBe("queued");
  });

  it("失败退避：1 小时后重试，最多 3 次，之后停在可见的失败态；终态的 background 不再入队", async () => {
    let calls = 0;
    registerMatchHandler("test_fail", async (): Promise<JobResult> => { calls += 1; return { state: "retry", error: "转写失败：假的" }; });
    const s = spec({ purpose: "test_fail" });
    await enqueueMatchJob(dir, s);
    await matchWorkerIdle(dir);
    for (let i = 0; i < MAX_RETRIES; i++) {
      const [j] = await listMatchJobs(dir);
      expect(j.state).toBe("queued");
      expect(j.next_at).toBe(clock + RETRY_DELAY_MS);
      clock += RETRY_DELAY_MS;
      await enqueueMatchJob(dir, s); // 同键活作业：只是叫醒工人
      await matchWorkerIdle(dir);
    }
    const [done] = await listMatchJobs(dir);
    expect(done.state).toBe("failed");
    expect(done.error).toContain("转写失败");
    expect(calls).toBe(MAX_RETRIES + 1);
    await enqueueMatchJob(dir, s);
    await matchWorkerIdle(dir);
    expect(calls).toBe(MAX_RETRIES + 1);
  });

  it("重启：跑到一半的作业回到排队，持久化在工作区缓存目录", async () => {
    const file = path.join(transcriptCacheDir(dir), "..", "match-jobs.json");
    const job: MatchJob = { id: "mjob-x", key: jobKey(spec()), purpose: "test_ok", priority: "background", sha256: SHA, path: "/x.mov", size: 1, mtime_ms: 1,
      target: "pool:1", payload: {}, state: "running", attempts: 0, next_at: 0, created_at: "t", updated_at: "t" };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, jobs: [job] }));
    registerMatchHandler("test_ok", async () => ({ state: "done", outcome: "ok" }));
    await enqueueMatchJob(dir, spec({ target: "other" }));
    await matchWorkerIdle(dir);
    expect((await listMatchJobs(dir)).find((j) => j.id === "mjob-x")?.state).toBe("done");
  });
});

describe("doctor 的转写环境提示（§10）", () => {
  it("没就绪的三种原因各给一句怎么装", () => {
    expect(notReadyFix("未装 uv（ASR 的运行器）")).toContain("astral.sh/uv");
    expect(notReadyFix("ASR 依赖环境还没装好")).toMatch(/uv sync --project .*sidecars\/asr/);
    expect(notReadyFix("ASR 模型还没下载（约 1GB）")).toContain("预热");
  });
});
