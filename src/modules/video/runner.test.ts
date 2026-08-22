/**
 * runner.test.ts —— 执行模型：串行推进、自动接续、lease/心跳、启动回收、settle CAS。
 * ASR 与 render 用假进程，ffmpeg/ffprobe 用真的——被测的是「状态怎么变」，不是「ffmpeg 会不会」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateContent } from "../../storage/local-store.js";
import { ingestAroll } from "./ingest.js";
import { createVideoRunner } from "./runner.js";
import {
  fakeRenderSpawn,
  fakeRunLoop,
  fakeUvSpawn,
  fixtureDenseTranscript,
  routedSpawn,
  seedEngineConfig,
  seedVideoContent,
} from "./testkit.js";
import {
  appendVideoJob,
  readVersioned,
  readVideoJobs,
  readVideoState,
  videoDir,
  videoJobsPath,
  writeVersioned,
} from "./video-store.js";
import type { VideoCut, VideoEditUnits, VideoJob, VideoState } from "./types.js";

let dir: string;
let contentId: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-runner-"));
  contentId = (await seedVideoContent(dir)).contentId;
  await seedEngineConfig(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

type Deps = NonNullable<Parameters<typeof createVideoRunner>[0]["deps"]>;

function makeRunner(
  routes: Parameters<typeof routedSpawn>[0],
  extra?: { onStateWritten?: (id: string) => void; runLoopImpl?: Deps["runLoopImpl"] },
) {
  const { runLoopImpl, ...rest } = extra ?? {};
  return createVideoRunner({
    dataDir: dir,
    // 模型调用一律注入假实现，测试永不真调模型
    deps: { spawnImpl: routedSpawn(routes), runLoopImpl: runLoopImpl ?? fakeRunLoop([]) },
    launchId: "test",
    onError: () => {},
    ...rest,
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
  it("ingest → transcribe → cut 计算步 → 停在 cut 的人工门；两版 cut 都是全 keep", async () => {
    await forceState({ phase: "ingest", state: "queued" });
    const runner = makeRunner({ uv: fakeUvSpawn("ok") });
    runner.enqueue(contentId);
    await runner.whenIdle();

    expect(await currentRef()).toBe("cut/awaiting_human");
    const { state } = await readVideoState(dir, contentId);
    expect(state?.revisions).toEqual({ transcript: 1, cut: 2 });

    const cut = await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 1);
    expect(cut).toMatchObject({ transcriptRevision: 1, origin: "default_all", flags: [] });
    expect(cut?.keeps).toEqual(["seg-0001", "seg-0002"]);
    // 夹具的「聊聊」没有词时间戳（覆盖率 83%），AI 粗剪被健康检查挡下 → 降级全留 + warning
    const units = await readVersioned<VideoEditUnits>(videoDir(dir, contentId), "edit-units", 2);
    expect(units).toMatchObject({ origin: "raw", suggestedDrops: [] });
    expect(units?.warning).toContain("覆盖率");
    expect((await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 2))?.keeps).toEqual(["seg-0001", "seg-0002"]);
  }, 30_000);

  it("词流健康时 AI 建议真的落进 cut.v2：staging 先落盘，CAS 通过后才定版本", async () => {
    await forceState({ phase: "ingest", state: "queued" });
    const drops = [{ startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "今天聊" }];
    const runner = makeRunner(
      { uv: fakeUvSpawn("ok", fixtureDenseTranscript()) },
      { runLoopImpl: fakeRunLoop([{ drops }]) },
    );
    runner.enqueue(contentId);
    await runner.whenIdle();

    expect(await currentRef()).toBe("cut/awaiting_human");
    const units = await readVersioned<VideoEditUnits>(videoDir(dir, contentId), "edit-units", 2);
    expect(units).toMatchObject({ origin: "llm", suggestedDrops: ["unit-0001"] });
    const cut = await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 2);
    expect(cut).toMatchObject({ origin: "llm", baseCutRevision: 1, keeps: ["unit-0002", "unit-0003"] });
    // staging 已经改名走了，不留半成品
    const names = await fs.readdir(videoDir(dir, contentId));
    expect(names.filter((n) => n.includes(".staging."))).toEqual([]);

    const cutJob = (await readVideoJobs(dir)).filter((j) => j.phase === "cut").at(-1)!;
    expect(cutJob).toMatchObject({ status: "succeeded", outputRevision: 2 });
    expect(cutJob.warning).toBeUndefined();
    // inputKey 含转写版本、稿件、prompt 版本与模型路由（§3.2）
    expect(cutJob.inputKey).toMatch(/^transcript:1\+body:[0-9a-f]{8}\+algo:[\w.-]+\+route:[0-9a-f]{8}$/);
  }, 30_000);

  it("AI 降级 → job 记 succeeded 但带 warning（跑完了，只是没结果）", async () => {
    await forceState({ phase: "ingest", state: "queued" });
    const runner = makeRunner({ uv: fakeUvSpawn("ok") });
    runner.enqueue(contentId);
    await runner.whenIdle();
    const cutJob = (await readVideoJobs(dir)).filter((j) => j.phase === "cut").at(-1)!;
    expect(cutJob.status).toBe("succeeded");
    expect(cutJob.warning).toContain("覆盖率");
  }, 30_000);

  it("执行期间稿件正文被改 → 输入快照对不上，产物只作历史留档", async () => {
    // 直接种转写与首版 cut：这里要测的是 settle 的输入核对，不是前面那两步
    const vdir = videoDir(dir, contentId);
    await writeVersioned(vdir, "transcript", 1, fixtureDenseTranscript());
    await writeVersioned(vdir, "cut", 1, { transcriptRevision: 1, keeps: [], flags: [], origin: "default_all" });
    await forceState({ phase: "cut", state: "queued", revisions: { transcript: 1, cut: 1 } });

    const runner = makeRunner(
      { uv: fakeUvSpawn("ok", fixtureDenseTranscript()) },
      {
        runLoopImpl: (async () => {
          await updateContent(contentId, { body: "换了一份完全不同的稿子" }, dir);
          return { finalMessage: "", turns: 0, totalTokens: 0, toolCallCount: 0, stopReason: "no_tool_calls" as const };
        }) as Deps["runLoopImpl"],
      },
    );
    runner.enqueue(contentId);
    await runner.whenIdle();

    expect(await currentRef()).toBe("cut/running");
    const last = (await readVideoJobs(dir)).at(-1)!;
    expect(last.errorCode).toBe("stale_settle");
    expect(last.failReason).toContain("输入在执行期间被改动");
    // CAS 没过 → 不定版本，产物停在 staging（可安全覆盖，重跑不会撞文件）
    expect(await readVersioned(videoDir(dir, contentId), "cut", 2)).toBeNull();
    const names = await fs.readdir(videoDir(dir, contentId));
    expect(names.some((n) => n.startsWith("cut.") && n.endsWith(".staging.json"))).toBe(true);
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

  it("上次崩在 staging 之后 → 重跑安全覆盖半成品，不撞不可覆盖文件", async () => {
    const vdir = videoDir(dir, contentId);
    await writeVersioned(vdir, "transcript", 1, fixtureDenseTranscript());
    await writeVersioned(vdir, "cut", 1, { transcriptRevision: 1, keeps: [], flags: [], origin: "default_all" });
    await forceState({ phase: "cut", state: "queued", revisions: { transcript: 1, cut: 1 } });
    // 先跑一次让它写出 staging，再把状态拨回 queued 伪造「崩在定版之前」
    const first = makeRunner({ uv: fakeUvSpawn("ok", fixtureDenseTranscript()) });
    first.enqueue(contentId);
    await first.whenIdle();
    await fs.rm(path.join(vdir, "cut.v2.json"), { force: true });
    await fs.rm(path.join(vdir, "edit-units.v2.json"), { force: true });
    await forceState({ phase: "cut", state: "queued", revisions: { transcript: 1, cut: 1 } });

    const again = makeRunner({ uv: fakeUvSpawn("ok", fixtureDenseTranscript()) });
    again.enqueue(contentId);
    await again.whenIdle();
    expect(await currentRef()).toBe("cut/awaiting_human");
    expect(await readVersioned(videoDir(dir, contentId), "cut", 2)).not.toBeNull();
  }, 30_000);

  it("非可执行阶段被投递 → failed，不静默停住", async () => {
    await forceState({ phase: "review", state: "queued", revisions: { transcript: 1, cut: 1, timeline: 1, rendered: 1 } });
    const runner = makeRunner({});
    runner.enqueue(contentId);
    await runner.whenIdle();
    const { state } = await readVideoState(dir, contentId);
    expect(state).toMatchObject({ state: "failed", errorCode: "not_runnable", failedPhase: "review" });
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
