/**
 * Render 执行与事务边界（设计 spec §6.1 / §6.2 / §6.4）。
 *
 * 契约：`npm --prefix render run render -- --manifest <abs> --out <abs>`；
 * stdout 是 JSON lines 进度，stderr 是日志（环形截断 256KB 进 job 台账）。
 *
 * 事务边界是这层的全部价值：
 *   写 `final.v<K>.tmp.mp4` → **ffprobe 断言**（h264 / 1920×1080 / 30fps / 时长 ±0.5s / 有音轨）
 *   → rename 就位 → 登记为稿件 asset。
 * 任何一步不过：改名 `final.v<K>.failed.mp4` 留档（能拖进播放器看崩在哪儿），**绝不登记为 asset**。
 * 少了断言这一步，「渲染成功」只是「进程退出码为 0」——半截视频、没声音、尺寸不对都算成功。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { upsertAsset } from "../../storage/local-store.js";
import { OUTPUT_FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "./timeline-build.js";
import { probeMedia } from "./ingest.js";
import { REPO_ROOT, runProcess, stderrTail, type VideoDeps } from "./proc.js";
import { videoDir } from "./video-store.js";

/** 时长断言容差（§10 验收：±0.5s，不做逐帧 golden） */
export const DURATION_TOLERANCE_MS = 500;
/** 渲染可以很久，但 2 小时还没完就是卡死了 */
export const RENDER_TIMEOUT_MS = 2 * 60 * 60_000;

export const RENDER_DIR = path.join(REPO_ROOT, "render");

export interface RenderProgress {
  renderedFrames: number;
  totalFrames: number;
}

export interface RenderExecInput {
  dataDir: string;
  contentId: string;
  manifestFile: string;
  timelineRevision: number;
  /** manifest.durationMs——ffprobe 断言的基准 */
  durationMs: number;
  renderDir?: string;
  onProgress?: (p: RenderProgress) => void;
  abortSignal?: AbortSignal;
}

export type RenderExecOutcome =
  | { ok: true; file: string; assetFilename: string }
  | { ok: false; errorCode: string; reason: string; failedFile?: string };

export function finalVideoPath(dataDir: string, contentId: string, revision: number): string {
  return path.join(videoDir(dataDir, contentId), `final.v${revision}.mp4`);
}

/**
 * 中间态与留档名**都保留 .mp4 后缀**：`final.v1.mp4.tmp` 那种写法看着更像「临时文件」，
 * 实则 ffmpeg 与 Remotion 都从扩展名推容器，`.tmp` 结尾会让渲染在第一秒就失败。
 * 留档件保持 .mp4 还有个好处：能直接拖进播放器看崩在第几秒。
 */
function tmpVideoPath(dataDir: string, contentId: string, revision: number): string {
  return path.join(videoDir(dataDir, contentId), `final.v${revision}.tmp.mp4`);
}

function failedVideoPath(dataDir: string, contentId: string, revision: number): string {
  return path.join(videoDir(dataDir, contentId), `final.v${revision}.failed.mp4`);
}

/** 成片在稿件素材里的名字（§6.4）；ingest 扫 A-roll 时按同一形态排除它 */
export function finalAssetFilename(revision: number): string {
  return `final-v${revision}.mp4`;
}

function parseProgress(line: string, onProgress?: (p: RenderProgress) => void): void {
  if (!onProgress || !line.startsWith("{")) return;
  try {
    const parsed = JSON.parse(line) as { type?: string; renderedFrames?: number; totalFrames?: number };
    if (parsed.type === "progress" && typeof parsed.renderedFrames === "number") {
      onProgress({ renderedFrames: parsed.renderedFrames, totalFrames: parsed.totalFrames ?? 0 });
    }
  } catch {
    /* render CLI 保证 stdout 只有 JSON lines；混进别的就当没看见，不为一行日志中断渲染 */
  }
}

/** 成片验收清单；返回人话问题列表，空 = 过 */
export async function assertFinalVideo(
  file: string,
  durationMs: number,
  deps?: VideoDeps,
): Promise<string[]> {
  const probed = await probeMedia(file, deps);
  if (!probed.ok) return [probed.reason];
  const { probe } = probed;
  const problems: string[] = [];
  if (!probe.video) problems.push("成片里没有画面轨");
  else {
    if (probe.video.codec !== "h264") problems.push(`视频编码是 ${probe.video.codec}，应为 h264`);
    if (probe.video.width !== OUTPUT_WIDTH || probe.video.height !== OUTPUT_HEIGHT) {
      problems.push(`分辨率是 ${probe.video.width}×${probe.video.height}，应为 ${OUTPUT_WIDTH}×${OUTPUT_HEIGHT}（横屏）`);
    }
    if (Math.abs(probe.video.fps - OUTPUT_FPS) > 0.05) {
      problems.push(`帧率是 ${probe.video.fps.toFixed(2)}fps，应为 ${OUTPUT_FPS}fps`);
    }
  }
  if (!probe.audio) problems.push("成片里没有音轨");
  const drift = Math.abs(probe.durationMs - durationMs);
  if (drift > DURATION_TOLERANCE_MS) {
    problems.push(`时长 ${probe.durationMs}ms 与输出域总长 ${durationMs}ms 相差 ${drift}ms（超过 ${DURATION_TOLERANCE_MS}ms 容差）`);
  }
  return problems;
}

/** 失败产物留档：改名 .failed.mp4，绝不登记为 asset，也绝不静默删除 */
async function parkFailed(tmp: string, failed: string): Promise<string | undefined> {
  try {
    await fs.rename(tmp, failed);
    return failed;
  } catch {
    return undefined;
  }
}

/**
 * 成片拷进稿件 `assets/`（既有 Asset 语义），中间产物留在 video/。
 *
 * **幂等 upsert 而不是追加**（lifecycle spec §3.1）：同一版重渲一次就多一条同名登记的话，
 * 反登记时说不清删的是哪条，`removeAsset` 更是一删删两条。同时盖上所有权标记——
 * 清理只删打了这个标记的登记，人手挂接的同名文件因此永远安全（§4 #11）。
 */
export async function registerFinalAsset(
  dataDir: string,
  contentId: string,
  file: string,
  revision: number,
): Promise<{ ok: true; filename: string } | { ok: false; reason: string }> {
  const filename = finalAssetFilename(revision);
  await fs.mkdir(path.join(dataDir, "contents", contentId, "assets"), { recursive: true });
  const result = await upsertAsset(
    contentId,
    {
      filename,
      type: "video",
      description: `视频生产线成片 v${revision}`,
      managedBy: "video-pipeline",
      renderedRevision: revision,
      sourcePath: file,
    },
    dataDir,
  );
  return result.ok ? { ok: true, filename } : { ok: false, reason: result.error ?? "成片登记失败" };
}

export async function runRenderJob(input: RenderExecInput, deps?: VideoDeps): Promise<RenderExecOutcome> {
  const out = finalVideoPath(input.dataDir, input.contentId, input.timelineRevision);
  const tmp = tmpVideoPath(input.dataDir, input.contentId, input.timelineRevision);
  const failed = failedVideoPath(input.dataDir, input.contentId, input.timelineRevision);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.rm(tmp, { force: true });

  const renderDir = input.renderDir ?? RENDER_DIR;
  const result = await runProcess({
    command: "npm",
    args: ["--prefix", renderDir, "run", "render", "--", "--manifest", input.manifestFile, "--out", tmp],
    cwd: REPO_ROOT,
    timeoutMs: RENDER_TIMEOUT_MS,
    onStdoutLine: (line) => parseProgress(line, input.onProgress),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(deps?.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
  });

  if (result.spawnError) {
    return { ok: false, errorCode: "npm_missing", reason: `起不来渲染进程：${result.spawnError}（渲染 workspace 在 ${renderDir}）` };
  }
  if (result.code !== 0) {
    const failedFile = await parkFailed(tmp, failed);
    const why = result.timedOut ? "渲染超时已终止" : `渲染进程退出码 ${String(result.code)}`;
    return {
      ok: false,
      errorCode: result.timedOut ? "render_timeout" : "render_failed",
      reason: `${why}：\n${stderrTail(result.stderr, 12) || "无输出"}`,
      ...(failedFile ? { failedFile } : {}),
    };
  }

  const problems = await assertFinalVideo(tmp, input.durationMs, deps);
  if (problems.length > 0) {
    const failedFile = await parkFailed(tmp, failed);
    return {
      ok: false,
      errorCode: "render_assert_failed",
      reason: `渲染进程说成功，但成片没通过验收：\n${problems.map((p) => `· ${p}`).join("\n")}`,
      ...(failedFile ? { failedFile } : {}),
    };
  }

  await fs.rename(tmp, out);
  const registered = await registerFinalAsset(input.dataDir, input.contentId, out, input.timelineRevision);
  if (!registered.ok) return { ok: false, errorCode: "asset_register_failed", reason: registered.reason };
  return { ok: true, file: out, assetFilename: registered.filename };
}
