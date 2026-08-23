/**
 * 视频线的一等结果型错误。
 *
 * 单独成文件是为了让 service 与 editor-gate 都能抛同一个类而不互相 import——
 * 「版本过期」在这条线上是**结果不是故障**（codex #11），两处判定必须是同一个类型，
 * 否则 IPC 层的 `instanceof` 只认得其中一个，另一边就退化成红色报错。
 */
import type { VideoState } from "./types.js";

/** 乐观锁冲突：调用方据此提示「有人改过了，已为你重载」，而不是当作系统故障 */
export class VideoConflictError extends Error {
  constructor(
    message: string,
    readonly current: VideoState,
  ) {
    super(message);
    this.name = "VideoConflictError";
  }
}
