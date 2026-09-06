/**
 * `autocrew_video` 的契约（P3c spec §14.2 / §14.4）：注册表、令牌门、`next` 人话、
 * 视图形状、冲突形状。
 *
 * service 用桩：这一层的职责是「取同一个实例 + 过令牌门 + 翻译形态」，真管线由
 * `video-walk.test.ts` 与 modules/video 自己的测试守；在这里跑 ffmpeg 只会把契约测试
 * 变成集成测试。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getContent, saveContent } from "../storage/local-store.js";
import { claimContent } from "../storage/claims.js";
import { VideoConflictError } from "../modules/video/errors.js";
import {
  resolveVideoService,
  setVideoService,
  VIDEO_NOT_RUNNING,
} from "../modules/video/service-registry.js";
import { videoStatusHandler } from "../desktop/video-handlers.js";
import type { VideoService } from "../modules/video/service.js";
import type { VideoState } from "../modules/video/types.js";
import { executeVideo } from "./video.js";

const STATE: VideoState = {
  schemaVersion: 1,
  entryType: "aroll",
  phase: "cut",
  state: "awaiting_human",
  revisions: { transcript: 1, clean: 1, cut: 2 },
  updatedAt: "2026-09-06T00:00:00.000Z",
};

let dir: string;
let contentId: string;
let seen: Array<Record<string, unknown>>;

function stubService(overrides: Partial<VideoService> = {}): VideoService {
  const state = async (): Promise<VideoState> => STATE;
  return {
    startBuild: async () => ({ ...STATE, phase: "ingest", state: "queued" }),
    confirmCut: async () => ({ ...STATE, phase: "edit", state: "queued" }),
    confirmEditorPlan: async () => ({ ...STATE, phase: "assemble", state: "queued" }),
    confirmReview: async () => ({ ...STATE, phase: "done", state: "done" }),
    fillEditorSlot: async (_id, args) => ({
      plan: { schemaVersion: 1, cutRevision: 2, origin: "human", overlays: [] },
      revision: args.planRevision + 1,
    }),
    removeEditorSlot: async (_id, args) => ({
      plan: { schemaVersion: 1, cutRevision: 2, origin: "human", overlays: [] },
      revision: args.planRevision + 1,
    }),
    editorBackToCut: state,
    requestCutPreview: state,
    editTranscriptText: state,
    reassemble: async () => ({ ...STATE, phase: "assemble", state: "queued" }),
    rerunRoughCut: state,
    rerunTranscribe: state,
    rerunEditor: state,
    retry: state,
    getStatus: async () => ({ state: STATE, jobs: [] }),
    getTranscript: async () => null,
    getEditorPlan: async () => null,
    warmupAsr: async () => ({ status: "warming" }),
    asrStatus: async () => ({ status: "ready", detail: "模型已就位" }),
    shutdown: async () => {},
    ...overrides,
  };
}

/** 工具调用的最小信封：宿主身份与工作区由 MCP 层注入，这里照样注 */
function call(params: Record<string, unknown>, host = "codex"): Promise<Record<string, unknown>> {
  return executeVideo({ content_id: contentId, _dataDir: dir, _host: host, ...params });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-tool-"));
  seen = [];
  contentId = (
    await saveContent({ title: "口播稿", body: "正文", status: "approved", tags: [], platform: "douyin" }, dir)
  ).id;
  setVideoService(stubService(), dir);
});

afterEach(async () => {
  setVideoService(null);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("服务注册表（§14.2：桌面与工具共用一个实例）", () => {
  it("同一个工作区的两个调用者拿到的是同一个对象", () => {
    const first = resolveVideoService(dir);
    const second = resolveVideoService(undefined);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.service).toBe(second.service);
    expect(first.dataDir).toBe(dir);
  });

  it("桌面 handler 与工具打到的是同一个实例（同一个桩记到同一份账）", async () => {
    setVideoService(
      stubService({
        getStatus: async (id) => {
          seen.push({ id });
          return { state: STATE, jobs: [] };
        },
      }),
      dir,
    );
    await videoStatusHandler({ content_id: contentId, _dataDir: dir });
    await call({ action: "status" });
    expect(seen).toHaveLength(2);
  });

  it("没起服务 = 照实说，不在工具进程里现建一个写盘队列", async () => {
    setVideoService(null);
    expect(await call({ action: "status" })).toMatchObject({ ok: false, error: VIDEO_NOT_RUNNING });
  });

  it("工作区对不上 = 拒绝，不是降级", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-other-"));
    const res = await executeVideo({ action: "status", content_id: contentId, _dataDir: other, _host: "codex" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("切换工作区");
    await fs.rm(other, { recursive: true, force: true });
  });
});

describe("令牌门（§14.2：宿主层认领，与 runner 租约各管各的）", () => {
  it("没人认领：写动作直接执行，并自动认领剪辑师桌", async () => {
    expect(await call({ action: "start" })).toMatchObject({ ok: true });
    const claim = (await getContent(contentId, dir))?.claim;
    expect(claim).toMatchObject({ employee: "editor", host: "codex" });
  });

  it("别的宿主握着未过期的认领：写动作被拒并报出持有者；只读照常", async () => {
    await claimContent(contentId, "editor", "claude-code", dir);
    const denied = await call({ action: "cut_confirm", keeps: ["seg-0001"], base_transcript_revision: 1, base_cut_revision: 2 });
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toContain("claude-code");
    expect(denied.holder).toMatchObject({ employee: "editor", host: "claude-code" });
    // 令牌不出现在回执里（视图脱敏）
    expect(JSON.stringify(denied)).not.toContain("clm-");
    expect(await call({ action: "status" })).toMatchObject({ ok: true });
  });

  it("带上持有者给的令牌就放行", async () => {
    const claimed = await claimContent(contentId, "editor", "claude-code", dir);
    const token = claimed.ok ? claimed.claim.token : "";
    expect(await call({ action: "start", claim_token: token })).toMatchObject({ ok: true });
  });

  it("同一个宿主重复写 = 续约，令牌不变", async () => {
    await call({ action: "start" });
    const first = (await getContent(contentId, dir))!.claim!;
    await new Promise((r) => setTimeout(r, 5));
    await call({ action: "start" });
    const second = (await getContent(contentId, dir))!.claim!;
    expect(second.token).toBe(first.token);
    expect(Date.parse(second.leaseUntil)).toBeGreaterThanOrEqual(Date.parse(first.leaseUntil));
  });
});

describe("status.next 的人话（§14.2 / §14.4）", () => {
  async function nextFor(state: Partial<VideoState>): Promise<string> {
    setVideoService(stubService({ getStatus: async () => ({ state: { ...STATE, ...state }, jobs: [] }) }), dir);
    return String((await call({ action: "status" })).next);
  }

  it("每道门、每种卡住都说得出下一步", async () => {
    expect(await nextFor({ phase: "cut", state: "awaiting_human" })).toContain("cut_confirm");
    expect(await nextFor({ phase: "edit", state: "awaiting_human" })).toContain("editor_confirm");
    expect(await nextFor({ phase: "review", state: "awaiting_human" })).toContain("review approve");
    expect(await nextFor({ phase: "transcribe", state: "running" })).toContain("轮询");
    expect(await nextFor({ phase: "done", state: "done" })).toContain("已完成");
  });

  it("blocked / failed 把原因原样带出来", async () => {
    expect(await nextFor({ phase: "transcribe", state: "blocked", blockedReason: "asr_not_ready" })).toContain("asr_status");
    expect(await nextFor({ phase: "assemble", state: "blocked", blockedReason: "ffmpeg_missing" })).toContain("ffmpeg");
    expect(await nextFor({ phase: "assemble", state: "blocked", blockedReason: "aroll_drifted" })).toContain("口播原片");
    const missing = await nextFor({
      phase: "ingest",
      state: "failed",
      failedPhase: "ingest",
      errorCode: "aroll_missing",
      failReason: "素材清单里没有 A-roll，请重新走一次导入",
    });
    expect(missing).toContain("口播原片");
    const boom = await nextFor({ phase: "render", state: "failed", failedPhase: "render", failReason: "渲染进程崩了" });
    expect(boom).toContain("渲染进程崩了");
    expect(boom).toContain("retry");
  });

  it("还没开始剪：state 为 null 也要说得出下一步", async () => {
    setVideoService(stubService({ getStatus: async () => null }), dir);
    const res = await call({ action: "status" });
    expect(res).toMatchObject({ ok: true, state: null });
    expect(String(res.next)).toContain("start");
  });
});

describe("形态与冲突（§14.4 最坏输入）", () => {
  it("未知 action / 非法 content_id / 非法 verdict 一律拒", async () => {
    expect(await call({ action: "trim" })).toMatchObject({ ok: false });
    expect(await executeVideo({ action: "status", content_id: "nope", _dataDir: dir })).toMatchObject({ ok: false });
    expect(await call({ action: "review", rendered_revision: 1, verdict: "maybe" })).toMatchObject({
      ok: false,
      error: "verdict 只能是 approve / reject",
    });
  });

  it("冲突是一等结果：conflict:true + 当前 state，并让宿主重新读", async () => {
    setVideoService(
      stubService({
        confirmCut: async () => {
          throw new VideoConflictError("选段基于的版本已过期", { ...STATE, revisions: { transcript: 1, cut: 3 } });
        },
      }),
      dir,
    );
    const res = await call({ action: "cut_confirm", keeps: ["seg-0001"], base_transcript_revision: 1, base_cut_revision: 2 });
    expect(res).toMatchObject({ ok: false, conflict: true });
    expect((res.state as VideoState).revisions.cut).toBe(3);
    expect(String(res.hint)).toContain("重新读");
  });

  it("中转端点把数组序列化成字符串时照样收（tool-args 那条实机教训）", async () => {
    let got: string[] = [];
    setVideoService(
      stubService({
        confirmCut: async (_id, args) => {
          got = args.keeps;
          return { ...STATE, phase: "edit", state: "queued" };
        },
      }),
      dir,
    );
    const res = await call({
      action: "cut_confirm",
      keeps: '["seg-0001","seg-0002"]',
      base_transcript_revision: 1,
      base_cut_revision: 2,
    });
    expect(res.ok).toBe(true);
    expect(got).toEqual(["seg-0001", "seg-0002"]);
  });

  it("editor_plan 还没跑过 = 空计划不是错误；asr_status 只读不过令牌门", async () => {
    await claimContent(contentId, "editor", "claude-code", dir);
    expect(await call({ action: "editor_plan" })).toMatchObject({ ok: true, plan_revision: 0, overlays: [] });
    expect(await call({ action: "asr_status" })).toMatchObject({ ok: true, status: "ready" });
  });
});
