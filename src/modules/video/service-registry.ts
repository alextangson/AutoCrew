/**
 * 视频服务的**唯一取法**（P3c spec §14.2）。
 *
 * 为什么要有这个文件：视频线的 runner 有进程内队列、启动回收与 job 租约，
 * 一个工作区**只能有一份** service 在跑。桌面 IPC 与 `autocrew_video` 工具是两条入口，
 * 各建各的 = 两条队列抢同一批状态文件，`fs.link` 仲裁只会把它变成随机失败。
 * 所以实例由 server 启动时建一次、在这里登记，两条入口都从这里拿同一个对象。
 *
 * 工作区语义与桌面层原样一致（不是降级而是拒绝）：调用方带来的 dataDir 与登记时的不符 →
 * 当场拒绝并让人重启，绝不把 A 工作区的稿件写进 B 的目录。
 *
 * **不做懒加载**：拿不到就说「视频服务没在跑」。在这里顺手建一个，等于让 CLI / dsh
 * 这类非守护进程也开始写盘——P3 §3「所有宿主经守护进程一个写入口」当场破功。
 */
import type { VideoService } from "./service.js";

export const VIDEO_NOT_RUNNING =
  "视频服务没在跑（重启 AutoCrew 后重试；ffmpeg/ASR 状态见 autocrew doctor）";

export const VIDEO_WORKSPACE_MISMATCH =
  "视频线跟随启动时的工作区——切换工作区后请重启 AutoCrew 再剪片";

let current: { service: VideoService; dataDir: string } | null = null;

/** server 启动时接线（传 null 解绑，测试与停机都用它）。dataDir = service 实际工作的工作区 */
export function setVideoService(service: VideoService | null, dataDir?: string): void {
  current = service && dataDir ? { service, dataDir } : null;
}

/** doctor / 设置页读：视频服务是否在跑、跟的是哪个工作区 */
export function getVideoRuntimeStatus(): { running: boolean; dataDir?: string } {
  return current ? { running: true, dataDir: current.dataDir } : { running: false };
}

export type ResolvedVideoService =
  | { ok: true; service: VideoService; dataDir: string }
  | { ok: false; error: string };

/**
 * 取 service 并校验工作区。`wantDataDir` 由调用方从 payload / 工具参数里取
 * （默认工作区不注入，因此缺省即视为命中）。
 */
export function resolveVideoService(wantDataDir?: string): ResolvedVideoService {
  if (!current) return { ok: false, error: VIDEO_NOT_RUNNING };
  const want = typeof wantDataDir === "string" && wantDataDir ? wantDataDir : null;
  if (want && want !== current.dataDir) return { ok: false, error: VIDEO_WORKSPACE_MISMATCH };
  return { ok: true, ...current };
}
