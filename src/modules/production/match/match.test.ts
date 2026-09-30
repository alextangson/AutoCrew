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

  it("失败的去重记录不被终态历史挤掉：超过 200 条已判之后，同一文件仍停在失败、不重新计次（Codex 审 segB2 P2）", async () => {
    registerMatchHandler("test_fail2", async (): Promise<JobResult> => ({ state: "failed", error: "坏了" }));
    registerMatchHandler("test_ok", async () => ({ state: "done", outcome: "ok" }));
    const bad = spec({ purpose: "test_fail2" });
    await enqueueMatchJob(dir, bad);
    await matchWorkerIdle(dir);
    for (let i = 0; i < 205; i++) { clock += 1000; await enqueueMatchJob(dir, spec({ sha256: i.toString(16).padStart(64, "0"), target: `t${i}` })); await matchWorkerIdle(dir); }
    const again = await enqueueMatchJob(dir, bad);
    expect(again.state).toBe("failed");
    await matchWorkerIdle(dir);
    expect((await listMatchJobs(dir)).filter((j) => j.key === jobKey(bad))).toEqual([expect.objectContaining({ state: "failed" })]);
  });

  it("同一份字节换了位置再被发现：作业改指新路径；因旧路径没了而退避的，安全地重新排上（Codex 审 segB3 P2）", async () => {
    registerMatchHandler("test_path", async ({ job }): Promise<JobResult> => (job.path === "/new.mov" ? { state: "done", outcome: "ok" } : { state: "retry", error: "文件不见了" }));
    await enqueueMatchJob(dir, spec({ purpose: "test_path", path: "/old.mov" }));
    await matchWorkerIdle(dir);
    expect((await listMatchJobs(dir))[0]).toMatchObject({ state: "queued", attempts: 1 });
    const moved = await enqueueMatchJob(dir, spec({ purpose: "test_path", path: "/new.mov", size: 2, mtime_ms: 2 }));
    expect(moved).toMatchObject({ path: "/new.mov", size: 2, next_at: 0 });
    await matchWorkerIdle(dir);
    expect((await listMatchJobs(dir))[0]).toMatchObject({ state: "done", path: "/new.mov" });
  });

  it("同一份字节的另一份拷贝（旧路径还在）交替出现：不清退避、不重计次（Codex 审 segB4 P2）", async () => {
    const a = path.join(dir, "inbox-copy.mov"), b = path.join(dir, "watch-copy.mov");
    await fs.writeFile(a, "same"); await fs.writeFile(b, "same");
    const t = new Date(1_700_000_000_000);
    await fs.utimes(a, t, t); await fs.utimes(b, t, t);
    const meta = { size: 4, mtime_ms: t.getTime() };
    let runs = 0;
    registerMatchHandler("test_copy", async (): Promise<JobResult> => { runs += 1; return { state: "retry", error: "ASR 坏了" }; });
    await enqueueMatchJob(dir, spec({ purpose: "test_copy", path: a, ...meta }));
    await matchWorkerIdle(dir);
    for (const p of [b, a, b, a]) { await enqueueMatchJob(dir, spec({ purpose: "test_copy", path: p, ...meta })); await matchWorkerIdle(dir); }
    expect(runs).toBe(1);
    expect((await listMatchJobs(dir))[0]).toMatchObject({ attempts: 1, next_at: clock + RETRY_DELAY_MS });
  });

  it("认领作业时落盘失败：内存里不留「跑到一半」，错误看得见；盘恢复后作业照跑，错误这才清掉（Codex 审 segB11 P2）", async () => {
    const { kickMatchWorker, matchWorkerError } = await import("./queue.js");
    let paused = true;
    setMatchDeps({ now: () => clock, paused: async () => paused });
    registerMatchHandler("test_ok", async () => ({ state: "done", outcome: "ok" }));
    await enqueueMatchJob(dir, spec());
    await matchWorkerIdle(dir);
    const cacheDir = path.dirname(path.join(transcriptCacheDir(dir), "x"));
    const qdir = path.dirname(cacheDir);
    await fs.chmod(qdir, 0o555);
    try {
      paused = false;
      kickMatchWorker(dir);
      await matchWorkerIdle(dir);
      expect(matchWorkerError(dir)).toBeTruthy();
      expect((await listMatchJobs(dir))[0].state).toBe("queued");
    } finally { await fs.chmod(qdir, 0o755); }
    kickMatchWorker(dir);
    await matchWorkerIdle(dir);
    expect((await listMatchJobs(dir))[0].state).toBe("done");
    expect(matchWorkerError(dir)).toBeNull();
  });

  it("作业跑完、落结果时写盘失败：结果留在内存待写，下次叫醒先补写、不重跑；写上之前错误一直在", async () => {
    const { kickMatchWorker, matchWorkerError } = await import("./queue.js");
    const qdir = path.dirname(transcriptCacheDir(dir));
    let runs = 0;
    registerMatchHandler("test_settle", async () => { runs += 1; await fs.chmod(qdir, 0o555); return { state: "done", outcome: "ok" }; });
    try {
      await enqueueMatchJob(dir, spec({ purpose: "test_settle" }));
      await matchWorkerIdle(dir);
      expect(matchWorkerError(dir)).toBeTruthy();
      kickMatchWorker(dir);
      await matchWorkerIdle(dir);
      expect(matchWorkerError(dir)).toBeTruthy();
    } finally { await fs.chmod(qdir, 0o755); }
    kickMatchWorker(dir);
    await matchWorkerIdle(dir);
    expect(runs).toBe(1);
    expect((await listMatchJobs(dir))[0]).toMatchObject({ state: "done", outcome: "ok" });
    expect(matchWorkerError(dir)).toBeNull();
  });

  it("终态失败的回调抛错：不丢，错误一直在，每次叫醒重试回调，送达后才清（Codex 审 segB12 P2）", async () => {
    const { kickMatchWorker, matchWorkerError } = await import("./queue.js");
    let hookCalls = 0;
    registerMatchHandler("test_hook", async (): Promise<JobResult> => ({ state: "failed", error: "坏了" }), async () => {
      hookCalls += 1;
      if (hookCalls === 1) throw new Error("制作记录暂时写不了");
    });
    await enqueueMatchJob(dir, spec({ purpose: "test_hook" }));
    await matchWorkerIdle(dir);
    expect(hookCalls).toBe(1);
    expect(matchWorkerError(dir)).toContain("制作记录暂时写不了");
    kickMatchWorker(dir);
    await matchWorkerIdle(dir);
    expect(hookCalls).toBe(2);
    expect(matchWorkerError(dir)).toBeNull();
    kickMatchWorker(dir);
    await matchWorkerIdle(dir);
    expect(hookCalls).toBe(2);
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
