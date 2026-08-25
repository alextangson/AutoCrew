/**
 * service.test.ts —— 门面契约与全链状态走查。
 * 一条 content 从 startBuild 走到 done：每一步的 phase/state、产物版本链、乐观锁、事件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listAssets, saveContent } from "../../storage/local-store.js";
import { addAssets, getAsset } from "../../storage/library-store.js";
import { createVideoService, VideoConflictError, type VideoService } from "./service.js";
import {
  ensureArollFixture,
  fakeRenderSpawn,
  fakeRunLoop,
  fakeUvSpawn,
  fixtureDenseTranscript,
  fixtureLongTranscript,
  routedSpawn,
  seedBrollAsset,
  seedEngineConfig,
  seedVideoContent,
} from "./testkit.js";
import { runProcess } from "./proc.js";
import { readVersioned, videoDir, writeVersioned } from "./video-store.js";
import type { RenderManifest, VideoCut, VideoEditUnits, VideoState } from "./types.js";

let dir: string;
let contentId: string;
let events: string[];
let service: VideoService;

const SETTLED = new Set(["awaiting_human", "failed", "blocked", "done", "idle"]);

function describeState(s: VideoState): string {
  const suffix = s.state === "failed" || s.state === "blocked" ? `(${s.errorCode}: ${s.failReason})` : "";
  return `${s.phase}/${s.state}${suffix}`;
}

/** 等管线跑到一个「不会再自己动」的状态；失败/阻塞时把原因带进断言消息 */
async function settled(): Promise<VideoState> {
  await expect
    .poll(async () => SETTLED.has((await service.getStatus(contentId))?.state.state ?? ""), { timeout: 60_000, interval: 40 })
    .toBe(true);
  return (await service.getStatus(contentId))!.state;
}

/**
 * 走完成片计划这道门（默认全留）。种子稿件没有 broll 素材，所以 plan 恒为空——
 * 「空 plan 也能确认，出纯口播」正是横屏 spec §4 #1/#7 要的行为。
 */
async function passEditorGate(): Promise<VideoState> {
  const at = await settled();
  expect(describeState(at)).toBe("edit/awaiting_human");
  const view = (await service.getEditorPlan(contentId))!;
  return service.confirmEditorPlan(contentId, {
    planRevision: view.revision,
    keptOverlayIds: view.plan.overlays.map((o) => o.overlayId),
  });
}

function build(
  routes?: Parameters<typeof routedSpawn>[0],
  turns: Array<Record<string, unknown>> = [],
): VideoService {
  return createVideoService({
    dataDir: dir,
    // 模型调用一律注入假实现——这一层测的是状态与版本链，不是模型说了什么
    deps: {
      spawnImpl: routedSpawn(routes ?? { uv: fakeUvSpawn("ok"), npm: fakeRenderSpawn() }),
      runLoopImpl: fakeRunLoop(turns),
    },
    onEvent: (e) => events.push(e.contentId),
    onError: () => {},
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-service-"));
  contentId = (await seedVideoContent(dir)).contentId;
  await seedEngineConfig(dir);
  events = [];
  service = build();
});

afterEach(async () => {
  await service.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("startBuild", () => {
  it("不合格的稿件直接拒（抛人话错误，不留半个状态）", async () => {
    const c = await saveContent({ title: "t", body: "b", platform: "wechat_mp", status: "approved", tags: [], hashtags: [] }, dir);
    await expect(service.startBuild(c.id)).rejects.toThrow(/只服务视频平台/);
    expect(await service.getStatus(c.id)).toBeNull();
  });

  it("投递即返回 queued，不等 ASR", async () => {
    const state = await service.startBuild(contentId);
    expect(describeState(state)).toBe("ingest/queued");
  });

  it("重复投递合并成一次，不重置进度", async () => {
    await service.startBuild(contentId);
    const first = await settled();
    const again = await service.startBuild(contentId);
    expect(describeState(again)).toBe(describeState(first));
    expect(again.revisions).toEqual(first.revisions);
  }, 60_000);
});

describe("全链走查", () => {
  it("startBuild → 转写 → 选段人工门 → 组装 → 渲染 → 审片 → done", async () => {
    await service.startBuild(contentId);
    const afterAsr = await settled();
    expect(describeState(afterAsr)).toBe("cut/awaiting_human");
    // cut.v1 = 转写写的全留版；cut.v2 = 粗剪步的产物（夹具词覆盖不足，降级成全留 + warning）
    expect(afterAsr.revisions).toEqual({ transcript: 1, clean: 1, cut: 2 });

    const loaded = await service.getTranscript(contentId);
    expect(loaded?.cut).toMatchObject({ origin: "default_all", keeps: ["seg-0001", "seg-0002"] });
    expect(loaded?.transcript.scriptAlignment?.matchedRatio).toBeGreaterThan(0);
    expect(loaded?.editUnits).toMatchObject({ origin: "raw" });
    expect(loaded?.editUnits?.warning).toBeTruthy();
    // 假模型一个工具都不调 → 清洗整体降级成原样转写。这句降级必须**单独**冒到选段卡上，
    // 不许被粗剪那句 warning 顶掉：两种降级说的不是一回事（转写纠错 spec §8 #4）
    expect(loaded?.cleanWarning).toContain("清洗");
    expect(loaded?.cleanWarning).not.toBe(loaded?.editUnits?.warning);

    const confirmed = await service.confirmCut(contentId, {
      keeps: ["seg-0001", "seg-0002"],
      flags: [{ segmentId: "seg-0002", flag: "repeat" }],
      baseTranscriptRevision: 1,
      baseCutRevision: 2,
    });
    // 选段定稿后接的是剪辑师，不是组装（横屏 spec §3.1）
    expect(describeState(confirmed)).toBe("edit/queued");
    expect(describeState(await passEditorGate())).toBe("assemble/queued");

    const afterRender = await settled();
    expect(describeState(afterRender)).toBe("review/awaiting_human");
    // editor 走到 2 是**确认本身也派生一版 plan**（lifecycle §2.1）：
    // v1 是剪辑师排的，v2 是人确认下来的那一份，决策就写在 v2 上
    expect(afterRender.revisions).toEqual({ transcript: 1, clean: 1, cut: 3, editor: 2, timeline: 1, rendered: 1 });
    expect(afterRender.confirmedEditorRevision).toBe(2);

    // 单元表随 cut 进新版本，warning 不跟着走（人已经处理过了）
    const carried = await readVersioned<VideoEditUnits>(videoDir(dir, contentId), "edit-units", 3);
    expect(carried).toMatchObject({ origin: "raw", flags: [{ segmentId: "seg-0002", flag: "repeat" }] });
    expect(carried?.warning).toBeUndefined();

    // 冻结的 manifest 字段齐全，AI 标注判定走 false 路径
    const manifest = (await readVersioned<RenderManifest>(videoDir(dir, contentId), "render-manifest", 1))!;
    expect(manifest).toMatchObject({ cutRevision: 3, transcriptRevision: 1, durationMs: 2000, provenance: { hasAiClips: false, hasClonedVoice: false } });
    expect(manifest.captions.style).toBe("plain");
    expect(manifest.captions.cues.length).toBeGreaterThan(0);

    // 成片就位并登记回稿件素材
    await fs.access(path.join(videoDir(dir, contentId), "final.v1.mp4"));
    expect((await listAssets(contentId, dir)).some((a) => a.filename === "final-v1.mp4")).toBe(true);

    const done = await service.confirmReview(contentId, { renderedRevision: 1, verdict: "approve" });
    expect(describeState(done)).toBe("done/done");
    // 每次落盘都有事件（SSE 的源头）
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(new Set(events)).toEqual(new Set([contentId]));
  }, 90_000);

  it("打回 → 重剪 → 再渲染：revision 链一致且旧成片留档", async () => {
    await service.startBuild(contentId);
    await settled();
    await service.confirmCut(contentId, { keeps: ["seg-0001", "seg-0002"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 });
    await passEditorGate();
    await settled();

    const bounced = await service.confirmReview(contentId, { renderedRevision: 1, verdict: "reject" });
    expect(describeState(bounced)).toBe("cut/awaiting_human");

    // 改了 keeps，输出域时间全变 → 必须重新过一遍剪辑师（边界 #8）
    const recut = await service.confirmCut(contentId, { keeps: ["seg-0001"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 3 });
    expect(describeState(recut)).toBe("edit/queued");
    await passEditorGate();
    const after = await settled();
    expect(describeState(after)).toBe("review/awaiting_human");
    // editor：v1 剪辑师 → v2 确认 → v3 按新选段重排 → v4 再确认
    expect(after.revisions).toEqual({ transcript: 1, clean: 1, cut: 4, editor: 4, timeline: 2, rendered: 2 });

    const cut4 = await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 4);
    expect(cut4).toMatchObject({ origin: "human", baseCutRevision: 3, keeps: ["seg-0001"], cleanRevision: 1 });
    const m2 = (await readVersioned<RenderManifest>(videoDir(dir, contentId), "render-manifest", 2))!;
    expect(m2.cutRevision).toBe(4);
    // 追溯链闭到成片：这一版字幕的字是哪来的，manifest 自己说得清（§1）
    expect(m2.cleanRevision).toBe(1);
    expect(m2.durationMs).toBe(1000);
    // 旧成片不许被覆盖——「按哪版剪的」永远说得清
    await fs.access(path.join(videoDir(dir, contentId), "final.v1.mp4"));
    await fs.access(path.join(videoDir(dir, contentId), "final.v2.mp4"));
  }, 120_000);

  it("重开：done 的内容提交新选段 → 重排 B-roll 再重组装", async () => {
    await service.startBuild(contentId);
    await settled();
    await service.confirmCut(contentId, { keeps: ["seg-0001"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 });
    await passEditorGate();
    await settled();
    await service.confirmReview(contentId, { renderedRevision: 1, verdict: "approve" });

    const reopened = await service.confirmCut(contentId, { keeps: ["seg-0001", "seg-0002"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 3 });
    expect(describeState(reopened)).toBe("edit/queued");
    await passEditorGate();
    expect(describeState(await settled())).toBe("review/awaiting_human");
  }, 120_000);
});

describe("AI 粗剪（LLM 一律注入假实现）", () => {
  const dense = { uv: fakeUvSpawn("ok", fixtureDenseTranscript()), npm: fakeRenderSpawn() };
  const drops = [{ startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "今天聊" }];

  async function withSuggestion(): Promise<void> {
    await service.shutdown();
    service = build(dense, [{ drops }]);
    await service.startBuild(contentId);
    await settled();
  }

  it("建议落进 cut.v2，面板拿到重分后的单元；确认后按单元组装出更短的成片", async () => {
    await withSuggestion();
    const loaded = (await service.getTranscript(contentId))!;
    expect(loaded.editUnits).toMatchObject({ origin: "llm", suggestedDrops: ["unit-0001"] });
    expect(loaded.editUnits?.warning).toBeUndefined();
    // 预勾的就是补集
    expect(loaded.cut.keeps).toEqual(["unit-0002", "unit-0003"]);
    // 转写本身一个字都没被改（I2：事实与派生分家）
    expect(loaded.transcript.segments.map((s) => s.id)).toEqual(["seg-0001", "seg-0002"]);

    await service.confirmCut(contentId, {
      keeps: loaded.cut.keeps,
      flags: loaded.cut.flags,
      baseTranscriptRevision: 1,
      baseCutRevision: 2,
    });
    await passEditorGate();
    expect(describeState(await settled())).toBe("review/awaiting_human");
    const manifest = (await readVersioned<RenderManifest>(videoDir(dir, contentId), "render-manifest", 1))!;
    // 留下 unit-0002(300ms) + unit-0003(600ms)
    expect(manifest.durationMs).toBe(900);
    expect(manifest.arollVideo.segments).toEqual([
      { sourceStartMs: 300, sourceEndMs: 600, outputStartMs: 0 },
      { sourceStartMs: 1000, sourceEndMs: 1600, outputStartMs: 300 },
    ]);
  }, 90_000);

  it("恢复全留：勾回单元全集照样能组装（单元 id 与 cut 同版本，不会对不上）", async () => {
    await withSuggestion();
    const loaded = (await service.getTranscript(contentId))!;
    const all = loaded.editUnits!.segments.map((s) => s.id);
    await service.confirmCut(contentId, {
      keeps: all,
      flags: loaded.cut.flags,
      baseTranscriptRevision: 1,
      baseCutRevision: 2,
    });
    await passEditorGate();
    expect(describeState(await settled())).toBe("review/awaiting_human");
    // AI 的 flag 作为只读证据留着，没被「恢复全留」清掉
    const carried = await readVersioned<VideoEditUnits>(videoDir(dir, contentId), "edit-units", 3);
    expect(carried?.suggestedDrops).toEqual(["unit-0001"]);
    expect(carried?.flags).toEqual([{ segmentId: "unit-0001", flag: "repeat" }]);
  }, 90_000);

  it("重跑 AI 粗剪：在人工门上可用，跑完仍停在人工门并产出新一版", async () => {
    await withSuggestion();
    expect(describeState(await service.rerunRoughCut(contentId))).toBe("cut/queued");
    const after = await settled();
    expect(describeState(after)).toBe("cut/awaiting_human");
    expect(after.revisions.cut).toBe(3);
    expect((await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 3))?.origin).toBe("llm");
  }, 90_000);

  it("人工终裁过的那一版禁止被后台建议覆盖", async () => {
    await withSuggestion();
    await service.confirmCut(contentId, { keeps: ["unit-0003"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 });
    await passEditorGate();
    await settled();
    await service.confirmReview(contentId, { renderedRevision: 1, verdict: "reject" });
    await expect(service.rerunRoughCut(contentId)).rejects.toThrow(/你自己确认过/);
    // 但「重跑转写」在同一格上是放行的（§7）：它作废的正是这一版终裁与手改，
    // 而且是人自己按的按钮，不是后台悄悄盖——两条边防的是不同的事
    expect(describeState(await service.rerunTranscribe(contentId))).toBe("transcribe/queued");
  }, 120_000);

  it("不在选段门上时重跑被拒（不把跑着的任务顶掉）", async () => {
    await service.startBuild(contentId);
    await expect(service.rerunRoughCut(contentId)).rejects.toThrow(/还轮不到/);
  });
});

/**
 * 重跑转写（转写纠错 spec §7）：门上看见错字时唯一能回到转写的出口。
 * 它作废的正是当前这一版文字与选段，所以判定与「重跑粗剪」刚好相反——那条边防的是
 * 后台悄悄盖掉人的决定，这条边是人自己要求换一版事实。
 */
describe("重跑转写", () => {
  it("从选段门退回转写：跑完仍停在选段门，转写/清洗/选段三条 revision 一起前进，旧版留盘", async () => {
    await service.startBuild(contentId);
    const before = await settled();
    expect(describeState(before)).toBe("cut/awaiting_human");

    expect(describeState(await service.rerunTranscribe(contentId))).toBe("transcribe/queued");
    const after = await settled();
    expect(describeState(after)).toBe("cut/awaiting_human");
    expect(after.revisions).toMatchObject({ transcript: 2, clean: 2 });
    expect(after.revisions.cut).toBeGreaterThan(before.revisions.cut!);
    // 旧版是审计凭证，一版都不许被顶掉
    const vdir = videoDir(dir, contentId);
    expect(await readVersioned(vdir, "transcript", 1)).not.toBeNull();
    expect(await readVersioned(vdir, "transcript-clean", 1)).not.toBeNull();
  }, 120_000);

  it("不在选段门上时被拒（不把跑着的任务顶掉）", async () => {
    await service.startBuild(contentId);
    await expect(service.rerunTranscribe(contentId)).rejects.toThrow(/只有停在选段这道门上/);
  });
});

describe("乐观锁", () => {
  beforeEach(async () => {
    await service.startBuild(contentId);
    await settled();
  });

  it("base revision 过期 → VideoConflictError，状态不动", async () => {
    await expect(
      service.confirmCut(contentId, { keeps: ["seg-0001"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 0 }),
    ).rejects.toThrow(VideoConflictError);
    expect(describeState((await service.getStatus(contentId))!.state)).toBe("cut/awaiting_human");
  }, 60_000);

  it("引用不存在的分句 → 打回，不产出 cut", async () => {
    await expect(
      service.confirmCut(contentId, { keeps: ["seg-9999"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 }),
    ).rejects.toThrow(/不存在的分句/);
    expect(await readVersioned(videoDir(dir, contentId), "cut", 3)).toBeNull();
  }, 60_000);

  it("一句都不留 → 当场拒，不用等到组装才发现", async () => {
    await expect(
      service.confirmCut(contentId, { keeps: [], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 }),
    ).rejects.toThrow(/至少留一句/);
  }, 60_000);

  it("还没渲染就审片 → 拒", async () => {
    await expect(service.confirmReview(contentId, { renderedRevision: 1, verdict: "approve" })).rejects.toThrow(/还轮不到审片/);
  }, 60_000);

  it("审的不是当前那版成片 → VideoConflictError", async () => {
    await service.confirmCut(contentId, { keeps: ["seg-0001"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 });
    await passEditorGate();
    await settled();
    await expect(service.confirmReview(contentId, { renderedRevision: 99, verdict: "approve" })).rejects.toThrow(VideoConflictError);
  }, 90_000);
});

describe("失败与重试", () => {
  it("ASR 崩了 → failed 带 failedPhase；retry 只重投那一步", async () => {
    await service.shutdown();
    service = build({ uv: fakeUvSpawn("crash"), npm: fakeRenderSpawn() });
    await service.startBuild(contentId);
    const failed = await settled();
    expect(failed).toMatchObject({ phase: "transcribe", state: "failed", failedPhase: "transcribe" });

    // 换成能跑通的 sidecar 再重试：从 transcribe 重来，不用从头 ingest
    await service.shutdown();
    service = build();
    const retried = await service.retry(contentId);
    expect(describeState(retried)).toBe("transcribe/queued");
    expect(describeState(await settled())).toBe("cut/awaiting_human");
  }, 90_000);

  it("blocked 也能重试（阻因消除后就该能继续）", async () => {
    await service.shutdown();
    service = build({ uv: fakeUvSpawn("model_missing"), npm: fakeRenderSpawn() });
    await service.startBuild(contentId);
    expect((await settled()).blockedReason).toBe("asr_not_ready");

    await service.shutdown();
    service = build();
    await service.retry(contentId);
    expect(describeState(await settled())).toBe("cut/awaiting_human");
  }, 90_000);

  it("没失败的时候点重试 → 拒（避免把跑着的任务重投一遍）", async () => {
    await service.startBuild(contentId);
    await settled();
    await expect(service.retry(contentId)).rejects.toThrow(/没有可重试的失败/);
  }, 60_000);
});

describe("查询口", () => {
  it("没开始剪 → getStatus/getTranscript 都是 null", async () => {
    expect(await service.getStatus(contentId)).toBeNull();
    expect(await service.getTranscript(contentId)).toBeNull();
  });

  it("getStatus 带上本条 content 的 job 视图", async () => {
    await service.startBuild(contentId);
    await settled();
    const status = (await service.getStatus(contentId))!;
    expect(status.jobs.every((j) => j.contentId === contentId)).toBe(true);
    expect(status.jobs.some((j) => j.phase === "transcribe" && j.status === "succeeded")).toBe(true);
  }, 60_000);

  it("ASR 预热状态可查", async () => {
    expect(await service.asrStatus()).toEqual({ status: "absent" });
    expect((await service.warmupAsr()).status).toBe("warming");
    await expect.poll(async () => (await service.asrStatus()).status, { timeout: 5000 }).toBe("ready");
  });
});

