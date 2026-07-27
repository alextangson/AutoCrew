/**
 * runner.test.ts —— 执行模型：串行推进、自动接续、lease/心跳、启动回收、settle CAS。
 * ASR 与 render 用假进程，ffmpeg/ffprobe 用真的——被测的是「状态怎么变」，不是「ffmpeg 会不会」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingestAroll } from "./ingest.js";
import { createVideoRunner } from "./runner.js";
import { fakeRenderSpawn, fakeUvSpawn, routedSpawn, seedVideoContent } from "./testkit.js";
import {
  appendVideoJob,
  readVersioned,
  readVideoJobs,
  readVideoState,
  videoDir,
  videoJobsPath,
} from "./video-store.js";
import type { VideoCut, VideoJob, VideoState } from "./types.js";

let dir: string;
let contentId: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-runner-"));
  contentId = (await seedVideoContent(dir)).contentId;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeRunner(routes: Parameters<typeof routedSpawn>[0], extra?: { onStateWritten?: (id: string) => void }) {
  return createVideoRunner({
    dataDir: dir,
    deps: { spawnImpl: routedSpawn(routes) },
    launchId: "test",
    onError: () => {},
    ...extra,
  });
}

/** 直写 state.json（绕过状态机）——只用来伪造「上次崩在半路」的现场 */
async function forceState(patch: Partial<VideoState>): Promise<void> {
  const dirPath = videoDir(dir, contentId);
  await fs.mkdir(dirPath, { recursive: true });
  const base: VideoState = {
    schemaVersion: 1,
    entryType: "aroll",
    phase: "ingest",
    state: "queued",
    revisions: {},
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dirPath, "state.json"), JSON.stringify({ ...base, ...patch }, null, 2));
}

async function currentRef(): Promise<string> {
  const { state } = await readVideoState(dir, contentId);
  return `${state?.phase}/${state?.state}`;
}

/** jobs.jsonl 的全部历史行（latest-wins 视图会盖掉中间态，回收断言要看原始账） */
async function rawJobs(): Promise<VideoJob[]> {
  const raw = await fs.readFile(videoJobsPath(dir), "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as VideoJob);
}

describe("阶段推进", () => {
  it("ingest → transcribe 自动接续 → 停在 cut 的人工门，cut.v1 全 keep", async () => {
    await forceState({ phase: "ingest", state: "queued" });
    const runner = makeRunner({ uv: fakeUvSpawn("ok") });
    runner.enqueue(contentId);
    await runner.whenIdle();

    expect(await currentRef()).toBe("cut/awaiting_human");
    const { state } = await readVideoState(dir, contentId);
    expect(state?.revisions).toEqual({ transcript: 1, cut: 1 });

    const cut = await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 1);
    expect(cut).toMatchObject({ transcriptRevision: 1, origin: "default_all", flags: [] });
    expect(cut?.keeps).toEqual(["seg-0001", "seg-0002"]);
  }, 30_000);

  it("转写 job 带 lease 与心跳，结算成 succeeded 并记录 outputRevision", async () => {
    await forceState({ phase: "ingest", state: "queued" });
    const runner = makeRunner({ uv: fakeUvSpawn("ok") });
    runner.enqueue(contentId);
    await runner.whenIdle();

    const jobs = await readVideoJobs(dir);
    const transcribe = jobs.filter((j) => j.phase === "transcribe");
    expect(transcribe.some((j) => j.status === "running" && j.leaseOwner === runner.leaseOwner)).toBe(true);
    const settled = transcribe.at(-1)!;
    expect(settled).toMatchObject({ status: "succeeded", outputRevision: 1, attempts: 1 });
    expect(settled.heartbeatAt).toBeTruthy();
    expect(settled.inputKey).toMatch(/^aroll:[0-9a-f]{12}$/);
  }, 30_000);

  it("ASR 模型未就绪 → blocked: asr_not_ready，job 记 failed，人话指引落在 failReason", async () => {
    await forceState({ phase: "ingest", state: "queued" });
    const runner = makeRunner({ uv: fakeUvSpawn("model_missing") });
    runner.enqueue(contentId);
    await runner.whenIdle();

    const { state } = await readVideoState(dir, contentId);
    expect(state).toMatchObject({ phase: "transcribe", state: "blocked", blockedReason: "asr_not_ready" });
    expect(state?.failedPhase).toBeUndefined();
    expect(state?.failReason).toContain("预热");
    expect((await readVideoJobs(dir)).at(-1)).toMatchObject({ phase: "transcribe", status: "failed" });
  }, 30_000);

  it("A-roll 在转写前被改动 → blocked: aroll_drifted", async () => {
    await ingestAroll(dir, contentId);
    await fs.appendFile(path.join(dir, "contents", contentId, "assets", "aroll.mp4"), Buffer.alloc(2048, 3));
    await forceState({ phase: "transcribe", state: "queued" });
    const runner = makeRunner({ uv: fakeUvSpawn("ok") });
    runner.enqueue(contentId);
    await runner.whenIdle();

    const { state } = await readVideoState(dir, contentId);
    expect(state).toMatchObject({ state: "blocked", blockedReason: "aroll_drifted" });
  }, 30_000);

  it("非可执行阶段被投递 → failed，不静默停住", async () => {
    await forceState({ phase: "cut", state: "queued", revisions: { transcript: 1, cut: 1 } });
    const runner = makeRunner({});
    runner.enqueue(contentId);
    await runner.whenIdle();
    const { state } = await readVideoState(dir, contentId);
    expect(state).toMatchObject({ state: "failed", errorCode: "not_runnable", failedPhase: "cut" });
  }, 30_000);
});

describe("启动回收", () => {
  it("心跳过期的 running job → 重排 + attempts+1，并真的被重跑", async () => {
    await forceState({ phase: "transcribe", state: "running", revisions: {} });
    const stale = new Date(Date.now() - 40 * 60_000).toISOString();
    await appendVideoJob(dir, {
      jobId: "vjob-stale",
      contentId,
      phase: "transcribe",
      inputKey: "aroll:deadbeef1234",
      status: "running",
      attempts: 1,
      leaseOwner: "pid-999-old",
      claimedAt: stale,
      heartbeatAt: stale,
    });

    const runner = makeRunner({ uv: fakeUvSpawn("ok") });
    const recovered = await runner.recoverExpired();
    expect(recovered).toBe(1);
    const requeued = (await rawJobs()).find((j) => j.jobId === "vjob-stale" && j.status === "queued");
    expect(requeued).toMatchObject({ attempts: 2 });
    expect(requeued?.leaseOwner).toBeUndefined();

    await runner.whenIdle();
    // 素材没 ingest 过 → 重跑后可见失败，证明它确实被重新执行而不是只改了台账
    expect(await currentRef()).toBe("transcribe/failed");
  }, 30_000);

  it("崩在 ingest（无 job 行）也能被 state.json 的 updatedAt 兜底回收", async () => {
    await forceState({ phase: "ingest", state: "running", updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    const runner = makeRunner({ uv: fakeUvSpawn("ok") });
    expect(await runner.recoverExpired()).toBe(1);
    await runner.whenIdle();
    expect(await currentRef()).toBe("cut/awaiting_human");
  }, 30_000);

  it("心跳还新鲜的 running 不动它（长渲染不该被自己人回收）", async () => {
    await forceState({ phase: "render", state: "running", revisions: { transcript: 1, cut: 1, timeline: 1 } });
    await appendVideoJob(dir, {
      jobId: "vjob-live",
      contentId,
      phase: "render",
      inputKey: "timeline:1",
      status: "running",
      attempts: 1,
      leaseOwner: "pid-999-old",
      heartbeatAt: new Date().toISOString(),
    });
    const runner = makeRunner({});
    expect(await runner.recoverExpired()).toBe(0);
    expect(await currentRef()).toBe("render/running");
  }, 30_000);
});

describe("settle CAS", () => {
  it("执行期间 revisions 前移 → 产物留盘、状态不动、台账记「历史产物」", async () => {
    // 先把管线推到 assemble 之前
    await forceState({ phase: "ingest", state: "queued" });
    const prep = makeRunner({ uv: fakeUvSpawn("ok") });
    prep.enqueue(contentId);
    await prep.whenIdle();

    // 组装真跑（产出 timeline.v1 + manifest.v1），渲染这一步先让它失败，把现场留给下面的 CAS
    await forceState({ phase: "assemble", state: "queued", revisions: { transcript: 1, cut: 1 } });
    const assembleRunner = makeRunner({ npm: fakeRenderSpawn({ exitCode: 1 }) });
    assembleRunner.enqueue(contentId);
    await assembleRunner.whenIdle();
    expect(await currentRef()).toBe("render/failed");
    await forceState({ phase: "render", state: "queued", revisions: { transcript: 1, cut: 1, timeline: 1 } });

    // 渲染跑到一半时有人把 timeline 推到了 v2 —— 这一版渲染结果已经是历史
    const runner = makeRunner({
      npm: fakeRenderSpawn({
        onStart: async () => {
          const file = path.join(videoDir(dir, contentId), "state.json");
          const state = JSON.parse(await fs.readFile(file, "utf-8")) as VideoState;
          await fs.writeFile(file, JSON.stringify({ ...state, revisions: { ...state.revisions, timeline: 2 } }));
        },
      }),
    });
    runner.enqueue(contentId);
    await runner.whenIdle();

    const { state } = await readVideoState(dir, contentId);
    expect(`${state?.phase}/${state?.state}`).toBe("render/running");
    expect(state?.revisions.rendered).toBeUndefined();
    // 产物留在盘上，只是不推进状态
    await fs.access(path.join(videoDir(dir, contentId), "final.v1.mp4"));
    const last = (await readVideoJobs(dir)).at(-1)!;
    expect(last).toMatchObject({ phase: "render", status: "failed", errorCode: "stale_settle" });
    expect(last.failReason).toContain("历史产物");
  }, 60_000);

  it("lease 被别人接管 → 同样只作历史留档，状态不动", async () => {
    await ingestAroll(dir, contentId);
    await forceState({ phase: "transcribe", state: "queued" });
    const ok = fakeUvSpawn("ok");
    const runner = makeRunner({
      uv: (args) => {
        const child = ok(args);
        // 转写跑着的时候，另一个进程抢走了这条 job 的 lease
        if (!args.includes("--version")) {
          void (async () => {
            const mine = (await readVideoJobs(dir)).find((j) => j.phase === "transcribe" && j.status === "running");
            if (mine) await appendVideoJob(dir, { ...mine, leaseOwner: "pid-999-other" });
          })();
        }
        return child;
      },
    });
    runner.enqueue(contentId);
    await runner.whenIdle();

    expect(await currentRef()).toBe("transcribe/running");
    const last = (await readVideoJobs(dir)).at(-1)!;
    expect(last.errorCode).toBe("stale_settle");
    expect(last.failReason).toContain("lease");
  }, 30_000);
});

describe("停机", () => {
  it("shutdown 后不再接新任务", async () => {
    const runner = makeRunner({ uv: fakeUvSpawn("ok") });
    await runner.shutdown();
    await forceState({ phase: "ingest", state: "queued" });
    runner.enqueue(contentId);
    await runner.whenIdle();
    expect(await currentRef()).toBe("ingest/queued");
  }, 30_000);
});
