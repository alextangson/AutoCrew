/**
 * 英文发布包校验要的上下文：缩略图还是不是登记那张、片长（排时清单里配音的结尾，章节不能超过它）。
 */
import { readDubManifest } from "./dub.js";
import { readEnThumbnail, thumbnailProblem } from "./thumbnail.js";
import type { EnKitContext } from "../publish/en-kit.js";

export async function enKitContext(contentId: string, dataDir: string): Promise<EnKitContext> {
  const m = await readDubManifest(contentId, dataDir).catch(() => null);
  return { thumbnailProblem: await thumbnailProblem(await readEnThumbnail(contentId, dataDir)), durationS: m && !m.refused ? m.dubEndS : null };
}
