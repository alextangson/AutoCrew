/**
 * phases.test.ts —— 单步执行体的直接单测（runner 那边测的是调度，这里测「一步之内做了什么」）。
 * 重点在两件事：产出的 next 状态与 revision 对不对；失败到底算 blocked 还是 failed。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executePhase, stepWarning, type PhaseContext } from "./phases.js";
import { ingestAroll } from "./ingest.js";
import {
  fakeRunLoop,
  fakeUvSpawn,
  fixtureDenseTranscript,
  fixtureLongTranscript,
  routedSpawn,
  seedBrollAsset,
  seedEngineConfig,
  seedVideoContent,
  throwingRunLoop,
} from "./testkit.js";
import { readVersioned, readVideoAssets, videoDir, writeVersioned } from "./video-store.js";
import type { VideoCut, VideoEditUnits, VideoEditorPlan, VideoPhase, VideoState, VideoTranscript } from "./types.js";

let dir: string;
let contentId: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-phases-"));
  contentId = (await seedVideoContent(dir)).contentId;
  await seedEngineConfig(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function ctx(
  phase: VideoPhase,
  revisions: VideoState["revisions"] = {},
  routes = { uv: fakeUvSpawn("ok") },
  extra: Partial<PhaseContext> = {},
): PhaseContext {
  return {
    dataDir: dir,
    contentId,
    state: { schemaVersion: 1, entryType: "aroll", phase, state: "running", revisions, updatedAt: new Date().toISOString() },
    // 模型调用一律注入假实现——测试永不真调模型
    deps: { spawnImpl: routedSpawn(routes), runLoopImpl: fakeRunLoop([]) },
    jobId: "vjob-test",
    abortSignal: new AbortController().signal,
    ...extra,
  };
}

describe("executePhase 分派", () => {
  it("人工门阶段不是可执行阶段 → not_runnable（不静默停住）", async () => {
    const r = await executePhase(ctx("review"));
    expect(r.ok === false && r.errorCode).toBe("not_runnable");
    expect(r.ok === false && r.reason).toContain("review");
  });

  it("done 阶段同样不可执行", async () => {
    expect((await executePhase(ctx("done"))).ok).toBe(false);
  });
});

describe("ingest", () => {
  it("成功 → 自动接续到 transcribe/queued，素材登记完成", async () => {
    const r = await executePhase(ctx("ingest"));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "transcribe", state: "queued" });
    expect((await readVideoAssets(dir, contentId))[0]).toMatchObject({ kind: "aroll", status: "ready" });
  });
});

describe("transcribe", () => {
  it("成功 → 排 cut 计算步 + transcript.v1 + cut.v1 全 keep + edit-units.v1 兜底 + 对齐度已算", async () => {
    await ingestAroll(dir, contentId);
    const r = await executePhase(ctx("transcribe"));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "cut", state: "queued" });
    expect(r.ok && r.revisions).toEqual({ transcript: 1, cut: 1 });

    const transcript = await readVersioned<VideoTranscript>(videoDir(dir, contentId), "transcript", 1);
    expect(transcript?.scriptAlignment?.matchedRatio).toBeGreaterThan(0);
    const cut = await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 1);
    expect(cut).toMatchObject({ origin: "default_all", keeps: ["seg-0001", "seg-0002"] });
    const units = await readVersioned<VideoEditUnits>(videoDir(dir, contentId), "edit-units", 1);
    expect(units).toMatchObject({ origin: "raw", suggestedDrops: [] });
    // 兜底单元表就是转写分句原样搬运（I2：事实与派生分家，但派生的第一版等于事实）
    expect(units?.segments.map((s) => s.id)).toEqual(["seg-0001", "seg-0002"]);
  });

  it("重跑转写 → revision 递增，旧版不动", async () => {
    await ingestAroll(dir, contentId);
    await executePhase(ctx("transcribe"));
    const r = await executePhase(ctx("transcribe", { transcript: 1, cut: 1 }));
    expect(r.ok && r.revisions).toEqual({ transcript: 2, cut: 2 });
    expect(await readVersioned(videoDir(dir, contentId), "transcript", 1)).not.toBeNull();
  });

  it("素材还没登记 → aroll_missing（failed，不是 blocked）", async () => {
    const r = await executePhase(ctx("transcribe"));
    expect(r.ok === false && r.errorCode).toBe("aroll_missing");
    expect(r.ok === false && r.blockedReason).toBeUndefined();
  });

  it("sidecar 未就绪 → blocked（阻塞与失败是两种命运）", async () => {
    await ingestAroll(dir, contentId);
    const r = await executePhase(ctx("transcribe", {}, { uv: fakeUvSpawn("model_missing") }));
    expect(r.ok === false && r.blockedReason).toBe("asr_not_ready");
  });
});

describe("cut（AI 粗剪）", () => {
  const dense = { uv: fakeUvSpawn("ok", fixtureDenseTranscript()) };

  /** 产物先落 staging，定版本是 runner 在 CAS 之后的事（spec §3.3） */
  async function staged<T>(base: string): Promise<T> {
    const file = path.join(videoDir(dir, contentId), `${base}.vjob-test.staging.json`);
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  }

  async function upToCut(routes = dense): Promise<void> {
    await ingestAroll(dir, contentId);
    await executePhase(ctx("transcribe", {}, routes));
  }

  beforeEach(async () => {
    contentId = (await seedVideoContent(dir, { body: "今天聊聊效率" })).contentId;
  });

  it("模型给出 drop → 按词区间重分单元，keeps 是补集，时间戳原样搬运", async () => {
    await upToCut();
    const drops = [{ startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "今天聊" }];
    const r = await executePhase(
      ctx("cut", { transcript: 1, cut: 1 }, dense, { deps: { spawnImpl: routedSpawn(dense), runLoopImpl: fakeRunLoop([{ drops }]) } }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "cut", state: "awaiting_human" });
    expect(r.ok && r.revisions).toEqual({ cut: 2 });
    expect(stepWarning(r)).toBeUndefined();
    expect(r.ok && r.staged).toEqual([
      { base: "edit-units", revision: 2 },
      { base: "cut", revision: 2 },
    ]);

    const units = await staged<VideoEditUnits>("edit-units");
    // 切点 = drop 边界 ∪ 分句边界 → [0,3) [3,6) [6,12)
    expect(units.origin).toBe("llm");
    expect(units.segments.map((s) => [s.startMs, s.endMs])).toEqual([[0, 300], [300, 600], [1000, 1600]]);
    expect(units.suggestedDrops).toEqual(["unit-0001"]);
    expect(units.flags).toEqual([{ segmentId: "unit-0001", flag: "repeat" }]);
    expect(units.provenance?.promptVersion).toBeTruthy();

    const cut = await staged<VideoCut>("cut");
    expect(cut).toMatchObject({ origin: "llm", baseCutRevision: 1, keeps: ["unit-0002", "unit-0003"] });
  });

  it("模型一次工具都没调 → 全留版 + warning，照常进人工门（不 failed）", async () => {
    await upToCut();
    const r = await executePhase(
      ctx("cut", { transcript: 1, cut: 1 }, dense, { deps: { spawnImpl: routedSpawn(dense), runLoopImpl: fakeRunLoop([]) } }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "cut", state: "awaiting_human" });
    expect(stepWarning(r)).toContain("没调用 submit_rough_cut");
    const units = await staged<VideoEditUnits>("edit-units");
    expect(units).toMatchObject({ origin: "raw", suggestedDrops: [] });
    expect(units.segments.map((s) => s.id)).toEqual(["seg-0001", "seg-0002"]);
    expect((await staged<VideoCut>("cut")).keeps).toEqual(["seg-0001", "seg-0002"]);
  });

  it("模型调用炸了 → 全留版 + warning，不 failed 也不 blocked", async () => {
    await upToCut();
    const r = await executePhase(
      ctx("cut", { transcript: 1, cut: 1 }, dense, {
        deps: { spawnImpl: routedSpawn(dense), runLoopImpl: throwingRunLoop("端点 502") },
      }),
    );
    expect(r.ok).toBe(true);
    expect(stepWarning(r)).toContain("502");
    expect((await staged<VideoEditUnits>("edit-units")).origin).toBe("raw");
  });

  it("引擎未配置 → 全留版 + warning，绝不 blocked（V0b 的缺失不许弄坏 V0a）", async () => {
    await upToCut();
    await fs.rm(path.join(dir, "engine.json"), { force: true });
    const r = await executePhase(ctx("cut", { transcript: 1, cut: 1 }, dense));
    expect(r.ok).toBe(true);
    expect(r.ok === false && r.blockedReason).toBeFalsy();
    expect(stepWarning(r)).toContain("引擎未配置");
  });

  it("词流不健康（词时间戳覆盖不足）→ 跳过 AI，全留版 + warning", async () => {
    await upToCut({ uv: fakeUvSpawn("ok") }); // 默认夹具的「聊聊」没有词时间戳
    const r = await executePhase(ctx("cut", { transcript: 1, cut: 1 }));
    expect(stepWarning(r)).toContain("覆盖率");
    expect((await staged<VideoEditUnits>("edit-units")).origin).toBe("raw");
  });

  it("人工已提交终裁 → 拒绝覆盖，不产新版本", async () => {
    await upToCut();
    await writeVersioned(videoDir(dir, contentId), "cut", 2, {
      transcriptRevision: 1,
      keeps: ["seg-0001"],
      flags: [],
      origin: "human",
    });
    const r = await executePhase(ctx("cut", { transcript: 1, cut: 2 }, dense));
    expect(r.ok && r.revisions).toBeUndefined();
    expect(stepWarning(r)).toContain("人工确认");
  });

  it("读不到转写 → missing_input（这个是真失败，不是降级）", async () => {
    const r = await executePhase(ctx("cut", { transcript: 9, cut: 1 }, dense));
    expect(r.ok === false && r.errorCode).toBe("missing_input");
  });
});

describe("edit（剪辑师 agent）", () => {
  /** 60 秒成片：掐掉开头 30s / 结尾 15s 后还剩 [30000, 45000] 这段合法窗口 */
  const overlay = { assetId: "b1", outputStartMs: 32_000, durationMs: 2_000, inMs: 500, outMs: 2_500 };

  async function staged<T>(base: string): Promise<T> {
    const file = path.join(videoDir(dir, contentId), `${base}.vjob-test.staging.json`);
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  }

  /** 直接种转写与选段：这里测的是剪辑师那一步，前面几步与它无关 */
  async function seedCut(): Promise<void> {
    const vdir = videoDir(dir, contentId);
    await writeVersioned(vdir, "transcript", 1, fixtureLongTranscript());
    await writeVersioned(vdir, "cut", 1, {
      transcriptRevision: 1,
      keeps: ["seg-0001", "seg-0002"],
      flags: [],
      origin: "human",
    });
  }

  function editCtx(turns: Array<Record<string, unknown>>, revisions: VideoState["revisions"] = { transcript: 1, cut: 1 }) {
    return ctx("edit", revisions, { uv: fakeUvSpawn("ok") }, {
      deps: { spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok") }), runLoopImpl: fakeRunLoop(turns) },
    });
  }

  beforeEach(async () => {
    contentId = (await seedVideoContent(dir, { body: "【开场】今天聊聊效率\n【演示】你看这个界面" })).contentId;
    await seedCut();
  });

  it("模型给出编排 → plan 落 staging，停在成片计划的人工门", async () => {
    await seedBrollAsset(dir, contentId);
    const r = await executePhase(editCtx([{ overlays: [overlay], emphasisWords: ["效率", "界面"] }]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "edit", state: "awaiting_human" });
    expect(r.ok && r.revisions).toEqual({ editor: 1 });
    expect(r.ok && r.staged).toEqual([{ base: "editor-plan", revision: 1 }]);
    expect(stepWarning(r)).toBeUndefined();

    const plan = await staged<VideoEditorPlan>("editor-plan");
    expect(plan).toMatchObject({ schemaVersion: 1, cutRevision: 1, origin: "llm" });
    expect(plan.overlays[0]).toMatchObject({
      overlayId: "ov-01",
      kind: "screen",
      outputStartMs: 32_000,
      durationMs: 2_000,
      inMs: 500,
      outMs: 2_500,
      label: "屏录：产品界面演示",
      ref: { kind: "content", filename: "screen.mp4" },
    });
    expect(plan.emphasisWords).toEqual(["效率", "界面"]);
    // 「界面」在转写里有，「效率」没有——对不上的必须被点名（边界 #14）
    expect(plan.unmatchedEmphasis).toEqual(["效率"]);
    expect(plan.provenance?.promptVersion).toBeTruthy();
  });

  it("重跑 → editor revision 递增（cut 号不动，产物不会撞车）", async () => {
    await seedBrollAsset(dir, contentId);
    const r = await executePhase(editCtx([{ overlays: [], emphasisWords: [] }], { transcript: 1, cut: 1, editor: 3 }));
    expect(r.ok && r.revisions).toEqual({ editor: 4 });
  });

  it("稿件零 broll 素材 → 空 plan 停人工门，非 warning（边界 #1）", async () => {
    const r = await executePhase(editCtx([{ overlays: [overlay], emphasisWords: [] }]));
    expect(r.ok).toBe(true);
    expect(stepWarning(r)).toBeUndefined();
    const plan = await staged<VideoEditorPlan>("editor-plan");
    expect(plan).toMatchObject({ origin: "empty", overlays: [] });
    expect(plan.note).toContain("没有可用的 B-roll 素材");
    expect(plan.warning).toBeUndefined();
  });

  it("素材全都没写说明 → 空 plan + 面板点名被排除的素材（边界 #3）", async () => {
    await seedBrollAsset(dir, contentId, { filename: "nodesc.mp4", description: "" });
    const r = await executePhase(editCtx([]));
    expect(r.ok).toBe(true);
    const plan = await staged<VideoEditorPlan>("editor-plan");
    expect(plan.origin).toBe("empty");
    expect(plan.excludedAssets?.join()).toContain("nodesc.mp4（没写说明）");
  });

  it("模型调用炸了 → 空 plan + warning，照常进人工门（不 failed 也不 blocked）", async () => {
    await seedBrollAsset(dir, contentId);
    const r = await executePhase(
      ctx("edit", { transcript: 1, cut: 1 }, { uv: fakeUvSpawn("ok") }, {
        deps: { spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok") }), runLoopImpl: throwingRunLoop("端点 502") },
      }),
    );
    expect(r.ok).toBe(true);
    expect(stepWarning(r)).toContain("502");
    expect((await staged<VideoEditorPlan>("editor-plan")).origin).toBe("empty");
  });

  it("读不到选段 → missing_input（这个是真失败，不是降级）", async () => {
    const r = await executePhase(editCtx([], { transcript: 1, cut: 9 }));
    expect(r.ok === false && r.errorCode).toBe("missing_input");
    expect(r.ok === false && r.reason).toContain("cut.v9");
  });
});

describe("assemble / render 的输入缺失", () => {
  it("读不到 transcript/cut → missing_input，点名版本号", async () => {
    await ingestAroll(dir, contentId);
    const r = await executePhase(ctx("assemble", { transcript: 7, cut: 9 }));
    expect(r.ok === false && r.errorCode).toBe("missing_input");
    expect(r.ok === false && r.reason).toContain("transcript.v7");
  });

  it("读不到 manifest → missing_manifest，指引重新组装", async () => {
    const r = await executePhase(ctx("render", { timeline: 3 }));
    expect(r.ok === false && r.errorCode).toBe("missing_manifest");
    expect(r.ok === false && r.reason).toContain("重新组装");
  });
});
