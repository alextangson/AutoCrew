/**
 * `autocrew_video` 的两道前置门（P3c spec §14.2）：拿服务、过认领令牌。
 *
 * 两层锁各管各的，不许合并（§14.2 末条）：
 * - **宿主层认领**（这里）管「谁在这张桌子上」：别的宿主握着未过期的租约时，
 *   你的写操作必须带他给的 `claim_token`，否则当场被拒并告诉你持有者是谁。
 * - **视频线自己的租约 / CAS**（runner + 三道门）管「谁在跑这一步」，一个字都不动。
 *
 * 认领是软门：没人认领时写操作直接执行**并自动认领剪辑师桌**——不记就等于没人知道
 * 是谁在剪，工作台的「Codex 剪辑中」徽章会永远是空的。
 */
import { ensureClaim } from "../storage/claims.js";
import { LOCAL_HOST } from "../storage/local-store.js";
import { VideoConflictError } from "../modules/video/errors.js";
import { resolveVideoService, type ResolvedVideoService } from "../modules/video/service-registry.js";

export type VideoToolResult = Record<string, unknown>;

export function videoFail(error: string, extra: VideoToolResult = {}): VideoToolResult {
  return { ok: false, error, ...extra };
}

/**
 * 错误翻译。`VideoConflictError` 是**一等结果不是故障**（§14.2）：宿主据此重新读状态再来，
 * 而不是重试同一份提交——重试只会再撞一次同一道乐观锁。
 */
export function videoError(err: unknown): VideoToolResult {
  if (err instanceof VideoConflictError) {
    return {
      ok: false,
      conflict: true,
      error: err.message,
      state: err.current,
      hint: "有人改过了：重新读 status / transcript / editor_plan 拿新版本号再提交，别重试同一份",
    };
  }
  return videoFail(err instanceof Error ? err.message : String(err));
}

/** 服务实例（与桌面共用同一个；没起来就照实说，不在这里现建一个写进程） */
export function videoService(params: Record<string, unknown>): ResolvedVideoService {
  return resolveVideoService(typeof params._dataDir === "string" ? params._dataDir : undefined);
}

export function hostOf(params: Record<string, unknown>): string {
  const raw = params._host;
  return typeof raw === "string" && raw.trim() ? raw.trim() : LOCAL_HOST;
}

/**
 * 令牌门 + 自动认领（封面师同款，员工换成 `editor`）。
 * 返回 null = 放行；非 null 就是原样可回给宿主的拒绝结果。
 */
export async function gateVideoWrite(
  params: Record<string, unknown>,
  contentId: string,
  dataDir: string,
): Promise<VideoToolResult | null> {
  const token = typeof params.claim_token === "string" ? params.claim_token.trim() : "";
  const claimed = await ensureClaim(
    contentId,
    { host: hostOf(params), employee: "editor", ...(token ? { token } : {}) },
    dataDir,
  );
  if (claimed.ok) return null;
  return videoFail(claimed.error, claimed.holder ? { holder: claimed.holder } : {});
}
