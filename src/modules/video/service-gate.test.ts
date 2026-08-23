/**
 * service-gate.test.ts —— 两道人工门的门面契约（v2 spec §4.1 门一预览 / §4.2 门二待生成槽）。
 *
 * 与 service.test.ts 的分工：那边走全链与失败恢复，这边只盯门内交互——
 * 预览指针怎么动、填槽怎么派生新版、未填的 generate 槽怎么被明示丢弃。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listAssets, saveContent } from "../../storage/local-store.js";
import { addAssets, getAsset } from "../../storage/library-store.js";
import { createVideoService, VideoConflictError, type VideoService } from "./service.js";
import { readEditorDecision } from "./editor-decision.js";
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

describe("剪辑师 agent（成片计划的人工门）", () => {
  /** 60 秒成片的合法窗口是 [30000, 45000]；素材是 3 秒屏录 */
  const overlay = { assetId: "b1", outputStartMs: 32_000, durationMs: 2_000, inMs: 500, outMs: 2_500 };
  const longRoutes = { uv: fakeUvSpawn("ok", fixtureLongTranscript()), npm: fakeRenderSpawn() };
  /** 同一个 runLoop 会被粗剪与剪辑师共用，按 prompt 分流：粗剪不给建议，剪辑师给一段 B-roll */
  const byPrompt = (msg: string) =>
    msg.includes("【成片逐句】") ? [{ overlays: [overlay] }] : [];

  async function upToPlanGate(): Promise<void> {
    await service.shutdown();
    service = createVideoService({
      dataDir: dir,
      deps: { spawnImpl: routedSpawn(longRoutes), runLoopImpl: fakeRunLoop(byPrompt) },
      onEvent: (e) => events.push(e.contentId),
      onError: () => {},
    });
    await seedBrollAsset(dir, contentId);
    await service.startBuild(contentId);
    await settled();
    await service.confirmCut(contentId, {
      keeps: ["seg-0001", "seg-0002"],
      flags: [],
      baseTranscriptRevision: 1,
      baseCutRevision: 2,
    });
    expect(describeState(await settled())).toBe("edit/awaiting_human");
  }

  it("确认时把留下的 overlay 写成决策产物（按 plan revision 存，指纹一路带过去）", async () => {
    await upToPlanGate();
    const view = (await service.getEditorPlan(contentId))!;
    expect(view.revision).toBe(1);
    expect(view.plan.origin).toBe("llm");
    expect(view.plan.overlays).toHaveLength(1);

    const confirmed = await service.confirmEditorPlan(contentId, {
      planRevision: view.revision,
      keptOverlayIds: [view.plan.overlays[0].overlayId],
    });
    expect(describeState(confirmed)).toBe("assemble/queued");
    // 确认自己也派生一版 plan（v2），决策就写在同一个号上；assemble 只认 confirmedEditorRevision
    expect(confirmed.confirmedEditorRevision).toBe(2);
    expect(confirmed.revisions.editor).toBe(2);
    const decision = (await readEditorDecision(dir, contentId, 2))!;
    expect(decision.cutRevision).toBe(3);
    const slots = decision.overlays as unknown as Array<Record<string, unknown>>;
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      kind: "screen",
      ref: { kind: "content", filename: "screen.mp4" },
      outputStartMs: 32_000,
      durationMs: 2_000,
      inMs: 500,
      outMs: 2_500,
      transition: "cut",
    });
    // 指纹是确认时的快照，assemble 复检对着它（边界 #12）
    expect((slots[0]!.fingerprint as { quickHash: string }).quickHash).toBeTruthy();
  }, 90_000);

  it("人把 overlay 全删了照样能确认（边界 #7：合法，出纯口播）", async () => {
    await upToPlanGate();
    const view = (await service.getEditorPlan(contentId))!;
    const confirmed = await service.confirmEditorPlan(contentId, {
      planRevision: view.revision,
      keptOverlayIds: [],
    });
    expect(describeState(confirmed)).toBe("assemble/queued");
    // 空计划写的是**显式空数组**，不是「不写文件」——后者会让上一版 overlay 静默复活（§2.1）
    expect((await readEditorDecision(dir, contentId, 2))!.overlays).toEqual([]);
  }, 90_000);

  it("plan_revision 过期 → VideoConflictError，状态不动、产物不落", async () => {
    await upToPlanGate();
    await expect(
      service.confirmEditorPlan(contentId, { planRevision: 99, keptOverlayIds: [] }),
    ).rejects.toThrow(VideoConflictError);
    expect(describeState((await service.getStatus(contentId))!.state)).toBe("edit/awaiting_human");
    expect(await readEditorDecision(dir, contentId, 2)).toBeNull();
  }, 90_000);

  it("引用计划里不存在的片段 → 打回（前端只能删，不能塞新东西进来）", async () => {
    await upToPlanGate();
    const view = (await service.getEditorPlan(contentId))!;
    await expect(
      service.confirmEditorPlan(contentId, { planRevision: view.revision, keptOverlayIds: ["ov-99"] }),
    ).rejects.toThrow(/没有这些片段/);
  }, 90_000);

  it("重跑剪辑师：门上可用，跑完仍停在门上并产出新一版 plan", async () => {
    await upToPlanGate();
    expect(describeState(await service.rerunEditor(contentId))).toBe("edit/queued");
    const after = await settled();
    expect(describeState(after)).toBe("edit/awaiting_human");
    expect(after.revisions.editor).toBe(2);
    expect((await service.getEditorPlan(contentId))?.revision).toBe(2);
  }, 90_000);

  it("零 broll 素材 → 剪辑师照跑（零素材短路已删），空编排照样能确认出纯口播", async () => {
    await service.startBuild(contentId);
    await settled();
    await service.confirmCut(contentId, { keeps: ["seg-0001", "seg-0002"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 });
    await settled();
    const view = (await service.getEditorPlan(contentId))!;
    expect(view.plan.overlays).toEqual([]);
    expect(view.plan.warning ?? view.plan.note).toBeTruthy();
    expect(describeState(await service.confirmEditorPlan(contentId, { planRevision: view.revision, keptOverlayIds: [] }))).toBe(
      "assemble/queued",
    );
  }, 90_000);

  it("不在成片计划门上时，确认与重跑都被拒（不把跑着的任务顶掉）", async () => {
    await service.startBuild(contentId);
    await settled();
    await expect(service.rerunEditor(contentId)).rejects.toThrow(/还轮不到/);
    await expect(service.confirmEditorPlan(contentId, { planRevision: 1, keptOverlayIds: [] })).rejects.toThrow(/还轮不到/);
    expect(await service.getEditorPlan(contentId)).toBeNull();
  }, 60_000);
});


// ---------------------------------------------------------------------------
// 门一 · 粗剪预览（v2 spec §4.1）
// ---------------------------------------------------------------------------

describe("门内预览", () => {
  async function atCutGate(): Promise<VideoState> {
    await service.startBuild(contentId);
    const at = await settled();
    expect(describeState(at)).toBe("cut/awaiting_human");
    return at;
  }

  it("cut job 尾接初次预览：开门时 preview.readyRevision 已就位", async () => {
    const at = await atCutGate();
    expect(at.preview).toMatchObject({ requestedRevision: 1, readyRevision: 1 });
    await fs.access(path.join(videoDir(dir, contentId), "preview.v1.mp4"));
    // 请求是不可变产物，落在盘上可追
    await fs.access(path.join(videoDir(dir, contentId), "cut-preview-request.v1.json"));
  }, 120_000);

  it("门内重渲：主状态不动，requestedRevision 递增，旧的 readyRevision 先留着", async () => {
    const at = await atCutGate();
    const after = await service.requestCutPreview(contentId, {
      keeps: ["seg-0001"],
      baseTranscriptRevision: at.revisions.transcript!,
      baseCutRevision: at.revisions.cut!,
    });
    expect(describeState(after)).toBe("cut/awaiting_human");
    expect(after.preview!.requestedRevision).toBe(2);
    expect(after.preview!.readyRevision).toBe(1);
    await expect
      .poll(async () => (await service.getStatus(contentId))!.state.preview?.readyRevision, { timeout: 60_000, interval: 40 })
      .toBe(2);
  }, 120_000);

  it("预览渲染中照样能确认（门就是门，不被渲染阻塞）", async () => {
    const at = await atCutGate();
    await service.requestCutPreview(contentId, {
      keeps: ["seg-0001", "seg-0002"],
      baseTranscriptRevision: at.revisions.transcript!,
      baseCutRevision: at.revisions.cut!,
    });
    const confirmed = await service.confirmCut(contentId, {
      keeps: ["seg-0001", "seg-0002"],
      flags: [],
      baseTranscriptRevision: at.revisions.transcript!,
      baseCutRevision: at.revisions.cut!,
    });
    expect(describeState(confirmed)).toBe("edit/queued");
  }, 120_000);

  it("勾选是草稿：重渲不写 cut revision，乐观锁 base 不变", async () => {
    const at = await atCutGate();
    await service.requestCutPreview(contentId, {
      keeps: ["seg-0001"],
      baseTranscriptRevision: at.revisions.transcript!,
      baseCutRevision: at.revisions.cut!,
    });
    const after = (await service.getStatus(contentId))!.state;
    expect(after.revisions.cut).toBe(at.revisions.cut);
  }, 120_000);

  it("base revision 过期 / 一句没勾 / 不在门上 → 分别给冲突与人话拒绝", async () => {
    const at = await atCutGate();
    const base = { baseTranscriptRevision: at.revisions.transcript!, baseCutRevision: at.revisions.cut! };
    await expect(
      service.requestCutPreview(contentId, { ...base, baseCutRevision: 99, keeps: ["seg-0001"] }),
    ).rejects.toThrow(VideoConflictError);
    await expect(service.requestCutPreview(contentId, { ...base, keeps: [] })).rejects.toThrow(/至少留一句/);
    await expect(service.requestCutPreview(contentId, { ...base, keeps: ["不存在"] })).rejects.toThrow(/不存在的分句/);
    await service.confirmCut(contentId, { ...base, keeps: ["seg-0001", "seg-0002"], flags: [] });
    await expect(service.requestCutPreview(contentId, { ...base, keeps: ["seg-0001"] })).rejects.toThrow(/还轮不到/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// render/failed 的死路出口（v2 spec §2.3，边界 #10）
// ---------------------------------------------------------------------------

describe("reassemble", () => {
  it("渲染失败 → 回 assemble 重出一份 manifest，timeline revision 递增", async () => {
    service = build({ uv: fakeUvSpawn("ok"), npm: fakeRenderSpawn({ exitCode: 1 }) });
    await service.startBuild(contentId);
    const at = await settled();
    await service.confirmCut(contentId, {
      keeps: at.revisions.cut ? ["seg-0001", "seg-0002"] : [],
      flags: [],
      baseTranscriptRevision: at.revisions.transcript!,
      baseCutRevision: at.revisions.cut!,
    });
    await passEditorGate();
    const failed = await settled();
    expect(failed.phase).toBe("render");
    expect(failed.state).toBe("failed");

    const back = await service.reassemble(contentId);
    expect(describeState(back)).toBe("assemble/queued");
    const after = await settled();
    // 重组装出的是新一版 manifest，不是把旧的原地改掉
    expect(after.revisions.timeline).toBe(failed.revisions.timeline! + 1);
    await fs.access(path.join(videoDir(dir, contentId), `render-manifest.v${String(after.revisions.timeline)}.json`));
  }, 180_000);

  it("不在 render/failed 上 → 人话拒绝（这不是通用的「回退」按钮）", async () => {
    await service.startBuild(contentId);
    await settled();
    await expect(service.reassemble(contentId)).rejects.toThrow(/只有渲染失败时/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 门二 · 待生成槽与门内填槽（v2 spec §4.2）
// ---------------------------------------------------------------------------

describe("待生成槽：填槽 / 跳过 / 旧 plan 容忍", () => {
  const overlay = { assetId: "b1", outputStartMs: 32_000, durationMs: 2_000, inMs: 500, outMs: 2_500 };
  // 与前一段之间留够 5s 露脸（generate 槽同样受排布硬规则约束）
  const generate = { description: "暗底细网格上数字滚动 80%→20%，克制", mediaKind: "video", outputStartMs: 39_000, durationMs: 3_000 };
  const longRoutes = () => ({ uv: fakeUvSpawn("ok", fixtureLongTranscript()), npm: fakeRenderSpawn() });

  /** 剪辑师排一段已有素材 + 一段待生成；粗剪那一轮不给建议 */
  const byPrompt = (msg: string) => (msg.includes("【成片逐句】") ? [{ overlays: [overlay, generate] }] : []);

  async function toPlanGate(): Promise<void> {
    await service.shutdown();
    service = createVideoService({
      dataDir: dir,
      deps: { spawnImpl: routedSpawn(longRoutes()), runLoopImpl: fakeRunLoop(byPrompt) },
      onEvent: (e) => events.push(e.contentId),
      onError: () => {},
    });
    await seedBrollAsset(dir, contentId);
    await service.startBuild(contentId);
    await settled();
    await service.confirmCut(contentId, {
      keeps: ["seg-0001", "seg-0002"],
      flags: [],
      baseTranscriptRevision: 1,
      baseCutRevision: 2,
    });
    expect(describeState(await settled())).toBe("edit/awaiting_human");
  }

  /** 往素材库里放一条真视频（3 秒 A-roll 夹具），返回它的 library id */
  async function seedLibraryVideo(): Promise<string> {
    const { added } = await addAssets([await ensureArollFixture()], null, dir);
    return added[0]!.id;
  }

  it("剪辑师提的 generate 槽原样进 plan，面板能数出「几个待填」", async () => {
    await toPlanGate();
    const view = (await service.getEditorPlan(contentId))!;
    expect(view.plan.overlays).toHaveLength(2);
    expect(view.plan.overlays.filter((o) => o.source.kind === "generate")).toHaveLength(1);
  }, 120_000);

  it("填槽 → 派生新 plan revision，旧版原样留盘（版本化产物只增不改）", async () => {
    await toPlanGate();
    const view = (await service.getEditorPlan(contentId))!;
    const slot = view.plan.overlays.find((o) => o.source.kind === "generate")!;
    const filled = await service.fillEditorSlot(contentId, {
      planRevision: view.revision,
      overlayId: slot.overlayId,
      libraryId: await seedLibraryVideo(),
    });
    expect(filled.revision).toBe(view.revision + 1);
    expect(filled.plan).toMatchObject({ origin: "human", basePlanRevision: view.revision });
    const target = filled.plan.overlays.find((o) => o.overlayId === slot.overlayId)!;
    expect(target.source).toMatchObject({ kind: "asset", ref: { kind: "library" }, type: "screen" });
    // 指纹在填槽这一刻打好（边界 #12 的复检基准）
    expect(target.source.kind === "asset" && target.source.fingerprint?.quickHash).toBeTruthy();
    // 旧版一个字没改
    const old = (await readVersioned<typeof view.plan>(videoDir(dir, contentId), "editor-plan", view.revision))!;
    expect(old.overlays.find((o) => o.overlayId === slot.overlayId)!.source.kind).toBe("generate");
    // 状态里的 plan 版本已前移，后续确认要拿新号
    expect((await service.getStatus(contentId))!.state.revisions.editor).toBe(filled.revision);
  }, 120_000);

  // 边界 #11：时长按 ffprobe 真读，不是信 plan 里写的那个数
  it("video 槽素材时长不足 / 类型不对 / 素材不存在 → 逐条人话拒绝，plan 版本不动", async () => {
    await toPlanGate();
    const view = (await service.getEditorPlan(contentId))!;
    const slot = view.plan.overlays.find((o) => o.source.kind === "generate")!;
    const fill = (libraryId: string) =>
      service.fillEditorSlot(contentId, { planRevision: view.revision, overlayId: slot.overlayId, libraryId });

    await expect(fill("asset-不存在")).rejects.toThrow(/素材库里找不到/);
    // 1 秒的短视频盖不满 3 秒的槽位
    const short = path.join(dir, "short.mp4");
    await runProcess({
      command: "ffmpeg",
      args: ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", short],
      timeoutMs: 60_000,
    });
    await expect(fill((await addAssets([short], null, dir)).added[0]!.id)).rejects.toThrow(/盖不满/);
    // 要视频给了图片
    const png = path.join(dir, "still.png");
    await runProcess({
      command: "ffmpeg",
      args: ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:size=64x64:duration=1", "-frames:v", "1", png],
      timeoutMs: 60_000,
    });
    await expect(fill((await addAssets([png], null, dir)).added[0]!.id)).rejects.toThrow(/要的是视频/);

    expect((await service.getStatus(contentId))!.state.revisions.editor).toBe(view.revision);
  }, 180_000);

  it("填槽的乐观锁：plan_revision 过期 → 冲突重载，不覆盖别人的编排", async () => {
    await toPlanGate();
    const view = (await service.getEditorPlan(contentId))!;
    const slot = view.plan.overlays.find((o) => o.source.kind === "generate")!;
    await expect(
      service.fillEditorSlot(contentId, { planRevision: 99, overlayId: slot.overlayId, libraryId: await seedLibraryVideo() }),
    ).rejects.toThrow(VideoConflictError);
  }, 120_000);

  // 边界 #13
  it("未填的 generate 槽在确认时被丢弃：只有 asset 槽落成覆盖轨", async () => {
    await toPlanGate();
    const view = (await service.getEditorPlan(contentId))!;
    const confirmed = await service.confirmEditorPlan(contentId, {
      planRevision: view.revision,
      keptOverlayIds: view.plan.overlays.map((o) => o.overlayId),
    });
    expect(describeState(confirmed)).toBe("assemble/queued");
    const slots = (await readEditorDecision(dir, contentId, confirmed.confirmedEditorRevision!))!.overlays;
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ kind: "screen", outputStartMs: 32_000 });
  }, 120_000);

  it("全部 generate 未填后确认 → 纯口播出片，硬限无需重算（只删不增）", async () => {
    await service.shutdown();
    service = createVideoService({
      dataDir: dir,
      deps: {
        spawnImpl: routedSpawn(longRoutes()),
        runLoopImpl: fakeRunLoop((msg) => (msg.includes("【成片逐句】") ? [{ overlays: [generate] }] : [])),
      },
      onEvent: (e) => events.push(e.contentId),
      onError: () => {},
    });
    await service.startBuild(contentId);
    await settled();
    await service.confirmCut(contentId, { keeps: ["seg-0001", "seg-0002"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 });
    await settled();
    const view = (await service.getEditorPlan(contentId))!;
    expect(view.plan.overlays.every((o) => o.source.kind === "generate")).toBe(true);
    const confirmed = await service.confirmEditorPlan(contentId, {
      planRevision: view.revision,
      keptOverlayIds: view.plan.overlays.map((o) => o.overlayId),
    });
    expect(describeState(confirmed)).toBe("assemble/queued");
    // 全是未填的 generate 槽 → 决策是显式空数组，纯口播出片
    expect((await readEditorDecision(dir, contentId, confirmed.confirmedEditorRevision!))!.overlays).toEqual([]);
  }, 120_000);

  // 边界 #14
  it("填槽后审片打回、门一改 keeps → 剪辑师按新选段重排；素材库那条素材还在", async () => {
    await toPlanGate();
    const view = (await service.getEditorPlan(contentId))!;
    const slot = view.plan.overlays.find((o) => o.source.kind === "generate")!;
    const libraryId = await seedLibraryVideo();
    const filled = await service.fillEditorSlot(contentId, {
      planRevision: view.revision,
      overlayId: slot.overlayId,
      libraryId,
    });
    await service.confirmEditorPlan(contentId, {
      planRevision: filled.revision,
      keptOverlayIds: filled.plan.overlays.map((o) => o.overlayId),
    });
    const rendered = await settled();
    expect(describeState(rendered)).toBe("review/awaiting_human");

    // 打回 = 回选段重剪（阶段回退白名单那条边）
    const back = await service.confirmReview(contentId, { renderedRevision: rendered.revisions.rendered!, verdict: "reject" });
    expect(describeState(back)).toBe("cut/awaiting_human");
    await service.confirmCut(contentId, { keeps: ["seg-0001"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 3 });
    const after = await settled();
    // 新 keeps → plan 的 inputKey 失效 → 剪辑师重跑，产出新一版
    expect(describeState(after)).toBe("edit/awaiting_human");
    expect(after.revisions.editor).toBeGreaterThan(filled.revision);
    // 素材没跟着丢：还在素材库里，随时能再填一次
    expect(await getAsset(libraryId, dir)).not.toBeNull();
  }, 240_000);

  // 边界 #15
  it("v1 旧 plan（emphasisWords + b 号 + 平铺来源）停在门上 → 容忍读 + 确认可走通", async () => {
    await toPlanGate();
    const vdir = videoDir(dir, contentId);
    const legacy = {
      schemaVersion: 1,
      cutRevision: 3,
      origin: "llm",
      emphasisWords: ["界面", "效率"],
      unmatchedEmphasis: ["效率"],
      overlays: [
        {
          overlayId: "ov-01",
          assetId: "b1",
          label: "屏录：产品界面演示",
          filename: "screen.mp4",
          kind: "screen",
          ref: { kind: "content", filename: "screen.mp4" },
          outputStartMs: 32_000,
          durationMs: 2_000,
          inMs: 500,
          outMs: 2_500,
          transition: "cut",
        },
      ],
    };
    await writeVersioned(vdir, "editor-plan", 2, legacy);
    await service.rerunEditor(contentId); // 借它把 revisions.editor 推到 2
    await settled();
    await fs.rm(path.join(vdir, "editor-plan.v2.json"), { force: true });
    await writeVersioned(vdir, "editor-plan", 2, legacy);

    const view = (await service.getEditorPlan(contentId))!;
    expect(view.revision).toBe(2);
    // 未知字段被忽略，来源被读成 v2 的判别联合
    expect(view.plan.overlays[0]!.source).toMatchObject({ kind: "asset", name: "screen.mp4", type: "screen" });
    const confirmed = await service.confirmEditorPlan(contentId, { planRevision: 2, keptOverlayIds: ["ov-01"] });
    expect(describeState(confirmed)).toBe("assemble/queued");
    const slots = (await readEditorDecision(dir, contentId, confirmed.confirmedEditorRevision!))!
      .overlays as unknown as Array<Record<string, unknown>>;
    // 旧 plan 没有指纹快照——那时压根没这份，所以槽位也不带（跳过复检，一次性容忍）
    expect(slots[0]).toMatchObject({ kind: "screen", ref: { kind: "content", filename: "screen.mp4" } });
    expect(slots[0]!.fingerprint).toBeUndefined();
  }, 180_000);
});
