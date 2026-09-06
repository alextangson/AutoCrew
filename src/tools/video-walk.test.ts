/**
 * `autocrew_video` 走完一条真链（P3c spec §14.5 验收第一条）：
 * `start → cut_confirm → editor_confirm → review approve`，`Content.videoDone` 置位。
 *
 * 全部经工具入口调用（不直接碰 service），因为要验的正是「宿主看到的那一面」——
 * 视图里有没有它需要的版本号、冲突长什么样、盖章有没有发生。
 * 模型与 ASR 一律假实现，渲染用假 CLI + 真 ffmpeg（产物是真的，3 秒素材）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getContent } from "../storage/local-store.js";
import { createVideoService, type VideoService } from "../modules/video/service.js";
import { setVideoService } from "../modules/video/service-registry.js";
import {
  fakeRenderSpawn,
  fakeRunLoop,
  fakeUvSpawn,
  fixtureLongTranscript,
  routedSpawn,
  seedBrollAsset,
  seedEngineConfig,
  seedVideoContent,
  windowOf,
} from "../modules/video/testkit.js";
import type { VideoState } from "../modules/video/types.js";
import { executeVideo } from "./video.js";

let dir: string;
let contentId: string;
let service: VideoService;

const SETTLED = new Set(["awaiting_human", "failed", "blocked", "done", "idle"]);
/** 60 秒成片的合法窗口是 [30000, 45000]；素材是 3 秒屏录 */
const overlay = { assetId: "b1", outputStartMs: 32_000, durationMs: 2_000, inMs: 500, outMs: 2_500 };

function call(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return executeVideo({ content_id: contentId, _dataDir: dir, _host: "codex", ...params });
}

async function status(): Promise<Record<string, unknown>> {
  return call({ action: "status" });
}

function ref(res: Record<string, unknown>): string {
  const s = res.state as VideoState | null;
  if (!s) return "none";
  const trouble = s.state === "failed" || s.state === "blocked" ? `(${s.errorCode}: ${s.failReason})` : "";
  return `${s.phase}/${s.state}${trouble}`;
}

/** 等到一个「不会再自己动」的状态；失败原因进断言消息 */
async function settled(): Promise<Record<string, unknown>> {
  await expect
    .poll(async () => SETTLED.has(((await status()).state as VideoState | null)?.state ?? ""), {
      timeout: 90_000,
      interval: 50,
    })
    .toBe(true);
  return status();
}

/**
 * 一个 runLoop 假实现分三路：清洗那轮不动字（返回空），粗剪提一段重复，剪辑师排一段 B-roll。
 * 粗剪的 quote 要与词流对得上（`fixtureLongTranscript` 的第一句是「先讲清楚…」）。
 */
function byPrompt(msg: string): Array<Record<string, unknown>> {
  if (msg.includes("【成片逐句】")) return [{ overlays: [overlay] }];
  if (!msg.includes("合法索引区间")) return [];
  const win = windowOf(msg);
  if (win.from !== 0) return [{ drops: [] }];
  return [{ drops: [{ startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "先讲清楚" }] }];
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-walk-"));
  contentId = (await seedVideoContent(dir)).contentId;
  await seedEngineConfig(dir);
  await seedBrollAsset(dir, contentId);
  service = createVideoService({
    dataDir: dir,
    deps: {
      spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok", fixtureLongTranscript()), npm: fakeRenderSpawn() }),
      runLoopImpl: fakeRunLoop(byPrompt),
    },
    onError: () => {},
  });
  setVideoService(service, dir);
});

afterEach(async () => {
  setVideoService(null);
  await service.shutdown();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("剪辑师从工具入口走完一条片子（§14.5）", () => {
  it("start → cut_confirm → editor_confirm → review revise → approve，成片戳落到稿件上", async () => {
    // ── 开工：投递即返回，宿主靠轮询 ──────────────────────────────────────
    const started = await call({ action: "start" });
    expect(started.ok).toBe(true);
    expect(String(started.next)).toContain("轮询");
    expect(ref(await settled())).toBe("cut/awaiting_human");

    // ── 门一：紧凑转写 + AI 建议 ─────────────────────────────────────────
    const compact = await call({ action: "transcript" });
    expect(compact.ok).toBe(true);
    const units = compact.units as Array<Record<string, unknown>>;
    expect(units.length).toBeGreaterThan(1);
    expect(units[0]).toHaveProperty("start_ms");
    expect(units.every((u) => u.words === undefined)).toBe(true);
    // AI 提了一段「重复」：标记 + 引句都在，供人设摆给创作者看
    const suggested = units.filter((u) => u.suggested_drop);
    expect(suggested.length).toBeGreaterThan(0);
    expect((suggested[0].suggested_drop as Record<string, unknown>).quote).toBeTruthy();
    expect(String(compact.next)).toContain("cut_confirm");

    const full = await call({ action: "transcript", full: true });
    expect(((full.units as Array<Record<string, unknown>>)[0].words as unknown[]).length).toBeGreaterThan(0);

    // 创作者看过引句后说「这句留着」——建议是提案不是决定，keeps 以他为准
    const keeps = units.map((u) => u.id as string);
    expect(keeps.length).toBeGreaterThan((compact.keeps as string[]).length);

    // 手里拿的是过期版本号 → 冲突，不是故障
    const stale = await call({
      action: "cut_confirm",
      keeps,
      base_transcript_revision: compact.base_transcript_revision,
      base_cut_revision: (compact.base_cut_revision as number) - 1,
    });
    expect(stale).toMatchObject({ ok: false, conflict: true });

    const confirmed = await call({
      action: "cut_confirm",
      keeps,
      flags: [{ segment_id: keeps[0], flag: "repeat" }],
      base_transcript_revision: compact.base_transcript_revision,
      base_cut_revision: compact.base_cut_revision,
    });
    expect(confirmed.ok).toBe(true);
    expect(ref(await settled())).toBe("edit/awaiting_human");

    // ── 门二：素材规划 ──────────────────────────────────────────────────
    const plan = await call({ action: "editor_plan" });
    const overlays = plan.overlays as Array<Record<string, unknown>>;
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({ overlay_id: "ov-01", output_start_ms: 32_000, duration_ms: 2_000 });
    expect((overlays[0].source as Record<string, unknown>).kind).toBe("asset");
    expect(String(plan.next)).toContain("editor_confirm");

    // 删掉那一段 → 派生新一版；旧版本号随即过期
    const removed = await call({
      action: "editor_slot_remove",
      plan_revision: plan.plan_revision,
      overlay_id: "ov-01",
    });
    expect(removed).toMatchObject({ ok: true, overlays: [] });
    expect(removed.plan_revision).toBe((plan.plan_revision as number) + 1);
    expect(
      await call({ action: "editor_confirm", plan_revision: plan.plan_revision, kept_overlay_ids: [] }),
    ).toMatchObject({ ok: false, conflict: true });

    // 纯口播（kept_overlay_ids 空数组是合法的）
    expect(
      await call({ action: "editor_confirm", plan_revision: removed.plan_revision, kept_overlay_ids: [] }),
    ).toMatchObject({ ok: true });
    const reviewing = await settled();
    expect(ref(reviewing)).toBe("review/awaiting_human");
    const renderedV1 = (reviewing.state as VideoState).revisions.rendered!;

    // ── 门三：先打回，再通过 ────────────────────────────────────────────
    const bounced = await call({
      action: "review",
      rendered_revision: renderedV1,
      verdict: "revise",
      target: "edit",
      timestamp_ms: 33_000,
      note: "这一段还是要放屏录",
    });
    expect(ref(bounced)).toBe("edit/awaiting_human");
    expect(String(bounced.next)).toContain("editor_confirm");
    expect((await status()).review).toMatchObject({ verdict: "reject", note: "这一段还是要放屏录" });
    expect((await getContent(contentId, dir))?.videoDone).toBeUndefined();

    const again = await call({ action: "editor_plan" });
    expect(
      await call({ action: "editor_confirm", plan_revision: again.plan_revision, kept_overlay_ids: [] }),
    ).toMatchObject({ ok: true });
    const rerendered = await settled();
    expect(ref(rerendered)).toBe("review/awaiting_human");
    const renderedV2 = (rerendered.state as VideoState).revisions.rendered!;
    expect(renderedV2).toBe(renderedV1 + 1);

    const approved = await call({ action: "review", rendered_revision: renderedV2, verdict: "approve" });
    expect(approved.ok).toBe(true);
    expect(approved.video_ready_at).toBeTruthy();
    expect(approved.stamp_warning).toBeUndefined();
    // 阶段闸只认这枚戳：MCP 审完必须盖上，否则稿件永远推不进封面台（§14.1）
    expect((await getContent(contentId, dir))?.videoDone).toMatchObject({ renderedRevision: renderedV2 });
    expect(String((await status()).next)).toContain("已完成");

    // 防呆：同一份 approve 重发不会再盖一次章
    expect(await call({ action: "review", rendered_revision: renderedV2, verdict: "approve" })).toMatchObject({
      ok: false,
    });
  }, 600_000);

  it("不是视频平台的稿子：start 被门面拒并说清原因（§14.4 状态边界）", async () => {
    const other = await seedVideoContent(dir, { platform: "wechat_mp" });
    const res = await executeVideo({
      action: "start",
      content_id: other.contentId,
      _dataDir: dir,
      _host: "codex",
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("视频平台");
  }, 120_000);
});
