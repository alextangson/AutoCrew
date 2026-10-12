/**
 * 视频发布包按平台存（一条视频一张卡，spec 2026-10-12 吸收 1）：`videoKits: Record<平台, VideoKit>`。
 * 旧稿只有单个 `videoKit`：读时当作 `{[kit.platform]: kit}`；下次写任一平台时并进 videoKits 并删掉旧字段。
 * 所有读写方都走这里，不再直读 `content.videoKit`。
 */
import type { Content, ContentUpdates, VideoKit } from "./local-store.js";

type KitHolder = Pick<Content, "videoKit" | "videoKits" | "platform">;

/** 这条稿全部平台的发布包（含旧单包迁移） */
export function videoKitsOf(c: KitHolder): Record<string, VideoKit> {
  const out: Record<string, VideoKit> = { ...(c.videoKits ?? {}) };
  const legacy = c.videoKit;
  if (legacy?.platform && !out[legacy.platform]) out[legacy.platform] = legacy;
  return out;
}

/** 某个平台的发布包；没有 = undefined（不拿别的平台的包顶） */
export function videoKitFor(c: KitHolder, platform: string): VideoKit | undefined {
  return videoKitsOf(c)[platform];
}

/** 稿件主平台的包，没有就取最早做的那份（片头大字、标题统计这类只要「一份」的读方） */
export function primaryVideoKit(c: KitHolder): VideoKit | undefined {
  const kits = videoKitsOf(c);
  if (c.platform && kits[c.platform]) return kits[c.platform];
  return Object.values(kits).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))[0];
}

/** 写一个平台的包：在锁内拿当前稿算，别的平台的包原样保留；旧单包字段一并迁走 */
export function putVideoKit(current: KitHolder, kit: VideoKit): ContentUpdates {
  return { videoKits: { ...videoKitsOf(current), [kit.platform]: kit }, videoKit: undefined };
}
