/**
 * Ingest：前置校验 + A-roll 探测与登记（设计 spec §4.1 / §4.2）。
 *
 * 三件事：
 * 1. **eligibility**（§4.1）：稿件在、未删、status ∈ approved 及之后、平台 ∈ VIDEO_PLATFORMS。
 *    平台白名单从 publish/video-kit 引，不抄第三份——两份名单迟早会漂。
 * 2. **probe**：ffprobe 读容器/时长/分辨率/轨道。>30 分钟、没画面、没声音一律拒收，
 *    原因是中文人话（拒收发生在人刚点「开始剪」的那一秒，此刻的错误信息最值钱）。
 * 3. **登记指纹**：A-roll **引用不复制**（2GB 素材复制一份既慢又占盘），代价是原文件随时
 *    可能被改名/替换——所以此刻把 fingerprint 钉进 assets.json，后面每个 phase 复检。
 *
 * ffprobe 不在 = `blocked: ffmpeg_missing`，不是 failed：装个 ffmpeg 就能继续，
 * 这是「等一个外部条件」而不是「这条内容剪不出来」。
 */
import path from "node:path";
import {
  getContent,
  type Asset,
  type AssetRole,
  type Content,
  type ContentStatus,
} from "../../storage/local-store.js";
import { VIDEO_PLATFORMS } from "../publish/video-kit.js";
import { fingerprintFile } from "./fingerprint.js";
import { runProcess, stderrTail, type VideoDeps } from "./proc.js";
import { readVideoAssets, resolveAssetRef, writeVideoAssets } from "./video-store.js";
import type { AssetRef, VideoAssetEntry } from "./types.js";

/** A-roll 时长上限（§4.2）：半小时以上多半是拍错了文件，不是一条口播 */
export const MAX_AROLL_MS = 30 * 60_000;

/**
 * 「approved 及之后」（§4.1）——published 也在内：已发的内容允许重剪。
 * archived 同样在内：归档不等于不能重出一版，拦下它只会让人先解档再剪，白绕一圈。
 */
export const VIDEO_ELIGIBLE_STATUSES: ReadonlySet<ContentStatus> = new Set<ContentStatus>([
  "approved",
  "editing",
  "cover_pending",
  "publish_ready",
  "publishing",
  "published",
  "archived",
]);

/** 成片会以 `final-v<K>.mp4` 登记回稿件素材；扫 A-roll 时必须把它排除，否则第二次构建会拿成片当素材 */
const FINAL_ASSET_RE = /^final-v\d+\.mp4$/i;

export type EligibilityResult =
  | { ok: true; content: Content }
  | { ok: false; reason: string };

export async function checkVideoEligibility(
  contentId: string,
  dataDir: string,
): Promise<EligibilityResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, reason: `稿件不存在：${contentId}` };
  if (content.deletedAt) return { ok: false, reason: "稿件已在回收站，恢复后才能剪成片" };
  if (!VIDEO_ELIGIBLE_STATUSES.has(content.status)) {
    return {
      ok: false,
      reason: `稿件当前状态是 ${content.status}，成片是定稿之后的事——先把稿件推到 approved 再来`,
    };
  }
  if (!VIDEO_PLATFORMS.has(content.platform ?? "")) {
    return {
      ok: false,
      reason: `成片只服务视频平台（${[...VIDEO_PLATFORMS].join("/")}），这篇是 ${content.platform || "未设平台"}`,
    };
  }
  return { ok: true, content };
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

export interface MediaProbe {
  formatName: string;
  durationMs: number;
  video?: { codec: string; width: number; height: number; fps: number };
  audio?: { codec: string };
}

export type ProbeOutcome =
  | { ok: true; probe: MediaProbe }
  | { ok: false; errorCode: "ffmpeg_missing" | "probe_failed"; reason: string };

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

/** "30/1" → 30；"0/0"（音轨）→ 0 */
function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

function shapeProbe(parsed: {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
}): MediaProbe {
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const seconds = Number(parsed.format?.duration ?? NaN);
  return {
    formatName: parsed.format?.format_name ?? "",
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    ...(video
      ? {
          video: {
            codec: video.codec_name ?? "",
            width: video.width ?? 0,
            height: video.height ?? 0,
            fps: parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate),
          },
        }
      : {}),
    ...(audio ? { audio: { codec: audio.codec_name ?? "" } } : {}),
  };
}

/** 全线唯一的媒体探测入口（ingest 验收、anchor 时长、成片断言都用它） */
export async function probeMedia(file: string, deps?: VideoDeps): Promise<ProbeOutcome> {
  const result = await runProcess({
    command: "ffprobe",
    args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    timeoutMs: 60_000,
    ...(deps?.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
  });
  if (result.spawnError) {
    return {
      ok: false,
      errorCode: "ffmpeg_missing",
      reason: `找不到 ffprobe（视频线的必备外部依赖）：${result.spawnError}。装法：brew install ffmpeg`,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      errorCode: "probe_failed",
      reason: `ffprobe 读不了这个文件（退出码 ${String(result.code)}）：${stderrTail(result.stderr, 3) || "无输出"}`,
    };
  }
  try {
    return { ok: true, probe: shapeProbe(JSON.parse(result.stdout)) };
  } catch {
    return { ok: false, errorCode: "probe_failed", reason: "ffprobe 输出不是合法 JSON，文件可能已损坏" };
  }
}

/** A-roll 的收货标准：有画面、有声音、时长可读且 ≤30 分钟 */
export async function probeAroll(file: string, deps?: VideoDeps): Promise<ProbeOutcome> {
  const probed = await probeMedia(file, deps);
  if (!probed.ok) return probed;
  const { probe } = probed;
  const reject = (reason: string): ProbeOutcome => ({ ok: false, errorCode: "probe_failed", reason });
  if (!probe.video) return reject(`${path.basename(file)} 里没有画面轨——A-roll 要的是真人出镜的视频，不是纯音频`);
  if (!probe.audio) return reject(`${path.basename(file)} 里没有音轨——没有声音就没法转写，也合不出主音轨`);
  if (probe.durationMs <= 0) return reject(`读不出 ${path.basename(file)} 的时长，容器多半已损坏，请重新导出`);
  if (probe.durationMs > MAX_AROLL_MS) {
    const minutes = Math.round(probe.durationMs / 60_000);
    return reject(`素材时长 ${minutes} 分钟，超过 30 分钟上限——请先剪出这一条的素材再导入`);
  }
  return { ok: true, probe };
}

// ---------------------------------------------------------------------------
// A-roll 登记
// ---------------------------------------------------------------------------

function newAssetId(kind: string): string {
  return `asset-${kind}-${Math.random().toString(36).slice(2, 8)}`;
}

function sameRef(a: AssetRef, b: AssetRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 素材清单 upsert：同一个 ref 复用原 assetId（timeline 里的引用因此不会因重新登记而失效），
 * 只刷新指纹与状态。
 */
export async function upsertVideoAsset(
  dataDir: string,
  contentId: string,
  entry: Omit<VideoAssetEntry, "assetId"> & { assetId?: string },
): Promise<VideoAssetEntry> {
  const list = await readVideoAssets(dataDir, contentId);
  const index = list.findIndex(
    (a) => (entry.assetId && a.assetId === entry.assetId) || (a.kind === entry.kind && sameRef(a.ref, entry.ref)),
  );
  const assetId = entry.assetId ?? (index >= 0 ? list[index].assetId : newAssetId(entry.kind));
  const next: VideoAssetEntry = { ...entry, assetId };
  if (index >= 0) list[index] = next;
  else list.push(next);
  await writeVideoAssets(dataDir, contentId, list);
  return next;
}

/** 成片与封面永远不是可剪素材：前者是上一版产物，后者是发布件（横屏 spec §2.6） */
function selectable(asset: Asset): boolean {
  return asset.type !== "cover" && !FINAL_ASSET_RE.test(asset.filename);
}

/**
 * A-roll 从哪来：
 *   ① 素材清单里已有的 aroll 条目（重剪、重试都走这条）；
 *   ② 挂接时标了 `role: "aroll"` 的稿件素材（横屏 spec §2.6 的正路）；
 *   ③ 老稿件兼容：整篇一个 role 都没有时，回落旧约定「第一个 video」。
 *
 * ③ 只在**完全没有 role 数据**时生效。已经标过角色的稿件里没有 aroll，就是真的没有——
 * 此时再去猜「第一个 video」会把创始人明明标成 broll 的屏录当口播底轨。
 */
export async function resolveArollRef(dataDir: string, contentId: string): Promise<AssetRef | null> {
  const existing = (await readVideoAssets(dataDir, contentId)).find((a) => a.kind === "aroll");
  if (existing) return existing.ref;
  const assets = ((await getContent(contentId, dataDir))?.assets ?? []).filter(selectable);
  const byRole = assets.find((a) => a.role === "aroll");
  if (byRole) return { kind: "content", filename: byRole.filename };
  if (assets.some((a) => a.role)) return null;
  const legacy = assets.find((a) => a.type === "video");
  return legacy ? { kind: "content", filename: legacy.filename } : null;
}

export const ASSET_ROLES: readonly AssetRole[] = ["aroll", "broll", "bgm", "other"];

/**
 * 挂接时的角色默认值（spec §2.6）：video 首个 = aroll、其余 video = broll、audio = bgm、image = broll。
 * 这只是**预填**——挂接 UI 上仍要人确认一次，猜错的代价（拿屏录当口播底轨）比多点一下大得多。
 */
export function guessAssetRole(type: Asset["type"], existing: readonly Asset[]): AssetRole {
  if (type === "audio") return "bgm";
  if (type === "video") return existing.some((a) => a.type === "video" && selectable(a)) ? "broll" : "aroll";
  if (type === "image" || type === "broll") return "broll";
  return "other";
}

/** 多条 bgm 不猜（spec §2.4）：`ambiguous` 一路冒到人工门，由人删到只剩一条 */
export type BgmResolution =
  | { kind: "none" }
  | { kind: "one"; ref: AssetRef; filename: string }
  | { kind: "ambiguous"; filenames: string[] };

/** BGM 只认 `role: "bgm"`——「稿件里有个音频文件」不等于「这首是配乐」 */
export async function resolveBgmRef(dataDir: string, contentId: string): Promise<BgmResolution> {
  const assets = ((await getContent(contentId, dataDir))?.assets ?? []).filter(
    (a) => selectable(a) && a.role === "bgm",
  );
  if (assets.length === 0) return { kind: "none" };
  if (assets.length > 1) return { kind: "ambiguous", filenames: assets.map((a) => a.filename) };
  return { kind: "one", ref: { kind: "content", filename: assets[0].filename }, filename: assets[0].filename };
}

export type IngestOutcome =
  | { ok: true; entry: VideoAssetEntry; absPath: string; probe: MediaProbe }
  | { ok: false; blockedReason?: "ffmpeg_missing"; errorCode: string; reason: string };

/** ingest 阶段的全部动作：找 A-roll → 探测 → 登记指纹 */
export async function ingestAroll(
  dataDir: string,
  contentId: string,
  deps?: VideoDeps,
): Promise<IngestOutcome> {
  const ref = await resolveArollRef(dataDir, contentId);
  if (!ref) {
    return {
      ok: false,
      errorCode: "aroll_missing",
      reason: "还没有 A-roll：把拍好的口播视频加进这篇稿件的素材（assets）里，再点一次「开始剪」",
    };
  }
  let absPath: string;
  try {
    absPath = await resolveAssetRef(dataDir, contentId, ref);
  } catch (err) {
    return { ok: false, errorCode: "aroll_unresolved", reason: (err as Error).message };
  }
  const probed = await probeAroll(absPath, deps);
  if (!probed.ok) {
    if (probed.errorCode === "ffmpeg_missing") {
      return { ok: false, blockedReason: "ffmpeg_missing", errorCode: "ffmpeg_missing", reason: probed.reason };
    }
    return { ok: false, errorCode: "aroll_rejected", reason: probed.reason };
  }
  const entry = await upsertVideoAsset(dataDir, contentId, {
    kind: "aroll",
    ref,
    status: "ready",
    fingerprint: await fingerprintFile(absPath),
  });
  return { ok: true, entry, absPath, probe: probed.probe };
}
