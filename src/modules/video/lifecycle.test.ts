/**
 * lifecycle.test.ts —— 可持续复用那一刀的端到端契约
 * （lifecycle spec §2.2 打回分流 / §2.3 槽位精修 / §3.3 收尾清理 + §4 边界 #6/#7/#9/#10/#12/#14）。
 *
 * 与 service-gate.test.ts 的分工：那边盯单道门的交互，这边盯**跨门的路径**——
 * 打回到底回了哪一步、回去改一处再确认会不会撞不可覆盖、done 之后清理有没有真发生。
 * 模型调用一律注入假实现：这一层测的是状态与版本链，不是模型说了什么。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listAssets } from "../../storage/local-store.js";
import { createVideoService, VideoConflictError, type VideoService } from "./service.js";
import { readEditorDecision } from "./editor-decision.js";
import {
  fakeRenderSpawn,
  fakeRunLoop,
  fakeUvSpawn,
  fixtureLongTranscript,
  routedSpawn,
  seedBrollAsset,
  seedEngineConfig,
  seedVideoContent,
} from "./testkit.js";
import { createReviewGate } from "./review-gate.js";
import { readVersioned, readVideoState, videoDir, writeVersioned } from "./video-store.js";
import type { VideoReviewDecision, VideoState } from "./types.js";

let dir: string;
let contentId: string;
let service: VideoService;

const SETTLED = new Set(["awaiting_human", "failed", "blocked", "done", "idle"]);

function describeState(s: VideoState): string {
  const suffix = s.state === "failed" || s.state === "blocked" ? `(${s.errorCode}: ${s.failReason})` : "";
  return `${s.phase}/${s.state}${suffix}`;
}

async function settled(): Promise<VideoState> {
  await expect
    .poll(async () => SETTLED.has((await service.getStatus(contentId))?.state.state ?? ""), { timeout: 60_000, interval: 40 })
    .toBe(true);
  return (await service.getStatus(contentId))!.state;
}

/** 60 秒成片的合法窗口是 [30000, 45000]；素材是 3 秒屏录 */
const overlay = { assetId: "b1", outputStartMs: 32_000, durationMs: 2_000, inMs: 500, outMs: 2_500 };

function build(): VideoService {
  return createVideoService({
    dataDir: dir,
    deps: {
      spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok", fixtureLongTranscript()), npm: fakeRenderSpawn() }),
      // 粗剪不给建议，剪辑师给一段 B-roll——两者共用同一个 runLoop，按 prompt 分流
      runLoopImpl: fakeRunLoop((msg) => (msg.includes("【成片逐句】") ? [{ overlays: [overlay] }] : [])),
    },
    onError: () => {},
  });
}

/** 一路推到审片门：转写 → 确认选段 → 剪辑师排 → 确认计划 → 组装渲染 */
async function upToReview(): Promise<VideoState> {
  await service.startBuild(contentId);
  await settled();
  await service.confirmCut(contentId, {
    keeps: ["seg-0001", "seg-0002"],
    flags: [],
    baseTranscriptRevision: 1,
    baseCutRevision: 2,
  });
  await settled();
  const view = (await service.getEditorPlan(contentId))!;
  await service.confirmEditorPlan(contentId, {
    planRevision: view.revision,
    keptOverlayIds: view.plan.overlays.map((o) => o.overlayId),
  });
  const at = await settled();
  expect(describeState(at)).toBe("review/awaiting_human");
  return at;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-lifecycle-"));
  contentId = (await seedVideoContent(dir)).contentId;
  await seedEngineConfig(dir);
  await seedBrollAsset(dir, contentId);
  service = build();
});

afterEach(async () => {
  await service.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("打回分流（§2.2 / §2.4）", () => {
  it("打回门二 → 停在成片计划，选段与决策链原样在；备注和定位落不可变记录", async () => {
    const at = await upToReview();
    const cutBefore = at.revisions.cut;
    const bounced = await service.confirmReview(contentId, {
      renderedRevision: at.revisions.rendered!,
      verdict: "reject",
      target: "edit",
      timestampMs: 33_000,
      note: "这段屏录跟我说的界面对不上",
    });
    expect(describeState(bounced)).toBe("edit/awaiting_human");
    expect(bounced.revisions.cut).toBe(cutBefore);

    const record = (await readVersioned<VideoReviewDecision>(
      videoDir(dir, contentId),
      "review-decision",
      at.revisions.rendered!,
    ))!;
    expect(record).toMatchObject({
      verdict: "reject",
      target: "edit",
      timestampMs: 33_000,
      note: "这段屏录跟我说的界面对不上",
      // 33s 正落在那一段 B-roll 里 → 定位到槽，而不是句子
      locate: { kind: "overlay", overlayId: "ov-01" },
    });
    // 状态查询把它带回前端，目标门的横幅刷新后照样看得见
    expect((await service.getStatus(contentId))!.review).toMatchObject({ note: record.note });
  }, 180_000);

  it("不给 target：按时间戳定位推荐——落在覆盖轨外就回门一", async () => {
    const at = await upToReview();
    const bounced = await service.confirmReview(contentId, {
      renderedRevision: at.revisions.rendered!,
      verdict: "reject",
      timestampMs: 5_000,
    });
    expect(describeState(bounced)).toBe("cut/awaiting_human");
    const record = (await readVersioned<VideoReviewDecision>(videoDir(dir, contentId), "review-decision", 1))!;
    expect(record.locate).toEqual({ kind: "segment", segmentId: "seg-0001" });
    expect(record.target).toBe("cut");
  }, 180_000);

  /**
   * 重跑转写会整代换掉分句 id（转写纠错 spec §7）：`unit-0001` / `cseg-0001` 这种编号跨代复用，
   * 所以任何按 id 的消费都必须扛得住「这一版里根本没有这个 id」。定位是其中一处——
   * 定位不到只许**不高亮**，不许崩，也不许编一个指针出来。
   *
   * 直接用门的注入口跑，不走整条管线：这里验的是判定，不是调度（跑一遍 ffmpeg 要三分钟）。
   */
  it("keeps 指向这一版里不存在的分句（重跑转写后的老指针）→ 定位退化成空，打回照常成立", async () => {
    const vdir = videoDir(dir, contentId);
    await writeVersioned(vdir, "transcript", 1, {
      schemaVersion: 1,
      source: "funasr",
      segments: [{ id: "cseg-0001", text: "今天", startMs: 0, endMs: 200, words: [{ w: "今", startMs: 0, endMs: 100 }] }],
    });
    // 上一代的 unit id：新一代的转写里压根没有它
    await writeVersioned(vdir, "cut", 1, { transcriptRevision: 1, keeps: ["unit-0001"], flags: [], origin: "human" });
    const state: VideoState = {
      schemaVersion: 1,
      entryType: "aroll",
      phase: "review",
      state: "awaiting_human",
      revisions: { transcript: 1, cut: 1, rendered: 1 },
      updatedAt: new Date().toISOString(),
    };
    const gate = createReviewGate({
      dataDir: dir,
      requireState: async () => state,
      write: async (_id, mutate) => mutate(state),
      enqueueCleanup: () => {},
      describe: (s) => `${s.phase}/${s.state}`,
      report: () => {},
    });
    const next = await gate.confirm(contentId, { renderedRevision: 1, verdict: "reject", timestampMs: 5_000, note: "这句是错的" });
    expect(describeState(next)).toBe("cut/awaiting_human");
    const record = (await readVersioned<VideoReviewDecision>(vdir, "review-decision", 1))!;
    expect(record.locate).toBeUndefined();
    expect(record).toMatchObject({ verdict: "reject", target: "cut", note: "这句是错的" });
  });

  /**
   * 本刀的核心诉求：改一处不重头剪。回门二改一处再确认，只重走 assemble+render，
   * 而且**不会撞上「版本化产物不可覆盖」**——早先按 cutRevision 存确认产物时这里必死。
   */
  it("回门二删槽至零再确认 → 新决策显式空数组，旧 overlay 不复活，选段一版没变", async () => {
    const at = await upToReview();
    await service.confirmReview(contentId, {
      renderedRevision: at.revisions.rendered!,
      verdict: "reject",
      target: "edit",
    });
    const view = (await service.getEditorPlan(contentId))!;
    expect(view.plan.overlays).toHaveLength(1);

    const removed = await service.removeEditorSlot(contentId, {
      planRevision: view.revision,
      overlayId: view.plan.overlays[0]!.overlayId,
    });
    expect(removed.plan.overlays).toEqual([]);
    expect(removed.revision).toBe(view.revision + 1);

    const confirmed = await service.confirmEditorPlan(contentId, {
      planRevision: removed.revision,
      keptOverlayIds: [],
    });
    expect(describeState(confirmed)).toBe("assemble/queued");
    expect(confirmed.revisions.cut).toBe(at.revisions.cut);
    expect((await readEditorDecision(dir, contentId, confirmed.confirmedEditorRevision!))!.overlays).toEqual([]);

    const after = await settled();
    expect(describeState(after)).toBe("review/awaiting_human");
    expect(after.revisions.rendered).toBe(at.revisions.rendered! + 1);
    // 纯口播出片：新 manifest 里一段覆盖轨都没有（旧的那一段没有复活）
    const manifest = (await readVersioned<{ overlays: unknown[] }>(
      videoDir(dir, contentId),
      "render-manifest",
      after.revisions.timeline!,
    ))!;
    expect(manifest.overlays).toEqual([]);
  }, 240_000);

  // 边界 #7
  it("回门二期间另一个窗口也在改 → 后提交者拿到冲突，不覆盖前一个人的编排", async () => {
    const at = await upToReview();
    await service.confirmReview(contentId, { renderedRevision: at.revisions.rendered!, verdict: "reject", target: "edit" });
    const view = (await service.getEditorPlan(contentId))!;
    const overlayId = view.plan.overlays[0]!.overlayId;
    await service.removeEditorSlot(contentId, { planRevision: view.revision, overlayId });
    // 第二个窗口手里还是旧版本号
    await expect(
      service.removeEditorSlot(contentId, { planRevision: view.revision, overlayId }),
    ).rejects.toThrow(VideoConflictError);
    await expect(
      service.confirmEditorPlan(contentId, { planRevision: view.revision, keptOverlayIds: [] }),
    ).rejects.toThrow(VideoConflictError);
  }, 180_000);

  it("门二退门一：带乐观锁，版本对不上拒绝；对得上就回选段门", async () => {
    const at = await upToReview();
    await service.confirmReview(contentId, { renderedRevision: at.revisions.rendered!, verdict: "reject", target: "edit" });
    const view = (await service.getEditorPlan(contentId))!;
    await expect(service.editorBackToCut(contentId, { planRevision: 99 })).rejects.toThrow(VideoConflictError);
    const back = await service.editorBackToCut(contentId, { planRevision: view.revision });
    expect(describeState(back)).toBe("cut/awaiting_human");
  }, 180_000);

  /**
   * §2.2 的第三条：`plan.cutRevision === revisions.cut` 也要校验。
   * 光有版本号乐观锁不够——号可以对得上，而那份编排是按上一版 keeps 的输出域时间排的，
   * 确认它等于让每一段 B-roll 落在错误的话上。
   */
  it("plan 是对上一版选段排的 → 读取标 staleCutRevision，确认被拒（哪怕版本号对得上）", async () => {
    const at = await upToReview();
    await service.confirmReview(contentId, { renderedRevision: at.revisions.rendered!, verdict: "reject", target: "edit" });
    const view = (await service.getEditorPlan(contentId))!;
    expect(view.staleCutRevision).toBeUndefined();

    // 就地伪造一份「按更早那版选段排的」plan，占住当前版本号
    const vdir = videoDir(dir, contentId);
    await fs.rm(path.join(vdir, `editor-plan.v${view.revision}.json`));
    await fs.writeFile(
      path.join(vdir, `editor-plan.v${view.revision}.json`),
      JSON.stringify({ ...view.plan, cutRevision: view.plan.cutRevision - 1 }),
    );

    const stale = (await service.getEditorPlan(contentId))!;
    expect(stale.staleCutRevision).toBe(view.plan.cutRevision - 1);
    await expect(
      service.confirmEditorPlan(contentId, { planRevision: view.revision, keptOverlayIds: [] }),
    ).rejects.toThrow(/重新跑剪辑师/);
    await expect(
      service.removeEditorSlot(contentId, { planRevision: view.revision, overlayId: "ov-01" }),
    ).rejects.toThrow(VideoConflictError);
  }, 240_000);

  it("门二退门一后重确认选段 → 剪辑师按新选段重排，旧编排不会被拿来用", async () => {
    const at = await upToReview();
    await service.confirmReview(contentId, { renderedRevision: at.revisions.rendered!, verdict: "reject", target: "edit" });
    const view = (await service.getEditorPlan(contentId))!;
    await service.editorBackToCut(contentId, { planRevision: view.revision });
    const recut = await service.confirmCut(contentId, {
      keeps: ["seg-0001"],
      flags: [],
      baseTranscriptRevision: 1,
      baseCutRevision: at.revisions.cut!,
    });
    expect(describeState(recut)).toBe("edit/queued");
    await settled();
    const fresh = (await service.getEditorPlan(contentId))!;
    expect(fresh.revision).toBeGreaterThan(view.revision);
    expect(fresh.plan.cutRevision).toBe(at.revisions.cut! + 1);
    expect(fresh.staleCutRevision).toBeUndefined();
  }, 240_000);
});

// 边界 #5：plan 里的说明是**快照**，不追改；重跑才吃新说明
describe("素材说明改了之后（§1 / §4 #5）", () => {
  it("已出的 plan 不追改；重跑剪辑师才拿到新说明", async () => {
    await service.startBuild(contentId);
    await settled();
    await service.confirmCut(contentId, { keeps: ["seg-0001", "seg-0002"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 });
    const at = await settled();
    expect(describeState(at)).toBe("edit/awaiting_human");
    const before = (await service.getEditorPlan(contentId))!;
    expect(before.plan.overlays[0]!.label).toBe("屏录：产品界面演示");

    // 改稿件里那条 broll 的说明
    const { getContent, updateContent } = await import("../../storage/local-store.js");
    const content = (await getContent(contentId, dir))!;
    await updateContent(
      contentId,
      { assets: content.assets.map((a) => (a.role === "broll" ? { ...a, description: "屏录：改过说明的那一条" } : a)) },
      dir,
    );
    // 手里那份 plan 一个字没变——它是当时的事实，不是对素材库的实时引用
    expect((await service.getEditorPlan(contentId))!.plan.overlays[0]!.label).toBe("屏录：产品界面演示");

    await service.rerunEditor(contentId);
    await settled();
    const after = (await service.getEditorPlan(contentId))!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.plan.overlays[0]!.label).toBe("屏录：改过说明的那一条");
  }, 180_000);
});

describe("成片收尾清理（§3.3）", () => {
  async function approve(): Promise<VideoState> {
    const at = await upToReview();
    await service.confirmReview(contentId, { renderedRevision: at.revisions.rendered!, verdict: "approve" });
    await expect
      .poll(async () => (await readVideoState(dir, contentId)).state?.cleanup?.status, { timeout: 30_000, interval: 40 })
      .toBe("done");
    return (await readVideoState(dir, contentId)).state!;
  }

  it("通过 → 清理跑完，状态落 done 并记下释放字节；测试产物没了、通过版还在", async () => {
    const state = await approve();
    expect(state.cleanup).toMatchObject({ status: "done", approvedRevision: 1 });
    expect(state.cleanup!.freedBytes).toBeGreaterThan(0);
    const left = await fs.readdir(videoDir(dir, contentId));
    expect(left).toContain("final.v1.mp4");
    expect(left.some((n) => n.startsWith("preview."))).toBe(false);
    expect(left).not.toContain("asr-input.wav");
    // 决策 JSON 一个不少（边界 #13：全链可重建）
    for (const name of ["transcript.v1.json", "cut.v3.json", "editor-plan.v2.json", "editor-decision.v2.json"]) {
      expect(left).toContain(name);
    }
    expect((await listAssets(contentId, dir)).some((a) => a.filename === "final-v1.mp4")).toBe(true);
  }, 240_000);

  // 边界 #9：done 落盘后、清理前进程死 → 启动重试
  it("cleanup 停在 pending（进程死在中间）→ 新起的 service 启动时接着做完", async () => {
    await approve();
    // 伪造「清理还没做完」的现场：状态回到 pending，并放一个新的测试产物
    const vdir = videoDir(dir, contentId);
    await fs.writeFile(path.join(vdir, "preview.v9.mp4"), "x".repeat(2048));
    const raw = JSON.parse(await fs.readFile(path.join(vdir, "state.json"), "utf-8")) as VideoState;
    raw.cleanup = { status: "pending", approvedRevision: 1 };
    await fs.writeFile(path.join(vdir, "state.json"), JSON.stringify(raw));

    await service.shutdown();
    service = build();
    await service.getStatus(contentId); // 任何一次调用都会等启动链跑完
    await expect
      .poll(async () => (await readVideoState(dir, contentId)).state?.cleanup?.status, { timeout: 30_000, interval: 40 })
      .toBe("done");
    expect(await fs.readdir(vdir)).not.toContain("preview.v9.mp4");
  }, 240_000);

  // 边界 #10：重开后再次 done → 再清理一次，幂等
  it("重开再出一版并通过 → 再次清理，旧那版成片被反登记", async () => {
    await approve();
    await service.confirmCut(contentId, {
      keeps: ["seg-0001"],
      flags: [],
      baseTranscriptRevision: 1,
      baseCutRevision: 3,
    });
    await settled();
    const view = (await service.getEditorPlan(contentId))!;
    await service.confirmEditorPlan(contentId, { planRevision: view.revision, keptOverlayIds: [] });
    const rendered = await settled();
    expect(describeState(rendered)).toBe("review/awaiting_human");

    await service.confirmReview(contentId, { renderedRevision: rendered.revisions.rendered!, verdict: "approve" });
    // 等的是「清理做完」而不是「清理排上了」——approve 落盘那一刻就已经是 pending 了
    await expect
      .poll(
        async () => {
          const c = (await readVideoState(dir, contentId)).state?.cleanup;
          return `${c?.status}/${String(c?.approvedRevision)}`;
        },
        { timeout: 30_000, interval: 40 },
      )
      .toBe("done/2");
    const left = await fs.readdir(videoDir(dir, contentId));
    expect(left).toContain("final.v2.mp4");
    expect(left).not.toContain("final.v1.mp4");
    const finals = (await listAssets(contentId, dir)).filter((a) => a.filename.startsWith("final-v"));
    expect(finals.map((a) => a.filename)).toEqual(["final-v2.mp4"]);
  }, 300_000);

  // 边界 #14：旧稿没有 cleanup 字段 → 不回溯清理
  it("旧稿（done 但没有 cleanup 字段）→ 启动时不被回溯清理", async () => {
    await approve();
    const vdir = videoDir(dir, contentId);
    await fs.writeFile(path.join(vdir, "preview.v9.mp4"), "old");
    const raw = JSON.parse(await fs.readFile(path.join(vdir, "state.json"), "utf-8")) as VideoState;
    delete raw.cleanup;
    await fs.writeFile(path.join(vdir, "state.json"), JSON.stringify(raw));

    await service.shutdown();
    service = build();
    await service.getStatus(contentId);
    expect(await fs.readdir(vdir)).toContain("preview.v9.mp4");
    expect((await readVideoState(dir, contentId)).state?.cleanup).toBeUndefined();
  }, 240_000);
});
