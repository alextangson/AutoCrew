/**
 * 成片戳（P3c spec §14.1）——`videoReadyAt` / `videoDone` 的唯一写处。
 *
 * 为什么不留在桌面层：服务层的 `confirmReview` 只把状态推到 `done/done`，
 * **阶段闸只认 `Content.videoDone`**。盖章留在 IPC 里，宿主经 MCP 审片就会到达 done
 * 却永远不盖章，稿件再也推不进封面台（spec §14.1 调查出处）。桌面与 `autocrew_video`
 * 共用这一份，两条入口的收尾行为按构造一致。
 *
 * 两条纪律照搬桌面原文：
 * - `videoReadyAt` **首次达成**盖一次，已有值不覆盖（publishedAt 同款，复盘用时靠它）；
 *   `videoDone` 每次通过都刷新，记的是「现在这一版成片审过了」。
 * - **盖戳失败不吞**：裁决照常生效，但 warning 必须可见——没有 `videoDone` 就推不进封面，
 *   静默失败会让人对着灰掉的推进按钮找不着北。
 */
import { getContent, updateContent } from "../../storage/local-store.js";

export interface VideoStamp {
  /** 首次达成的时刻；盖不上时为 null（`stampWarning` 会说清为什么） */
  videoReadyAt: string | null;
  stampWarning?: string;
}

/** 审片通过的两枚戳，一次写完 */
export async function stampVideoReady(
  contentId: string,
  renderedRevision: number,
  dataDir: string,
): Promise<VideoStamp> {
  try {
    const content = await getContent(contentId, dataDir);
    if (!content) return { videoReadyAt: null, stampWarning: "稿件读不到，成片戳未盖（推进到封面会被拦下）" };
    const updated = await updateContent(
      contentId,
      {
        ...(content.videoReadyAt ? {} : { videoReadyAt: new Date().toISOString() }),
        videoDone: { renderedRevision, at: new Date().toISOString() },
      },
      dataDir,
    );
    if (!updated?.videoDone) {
      return { videoReadyAt: null, stampWarning: "成片戳落盘失败（推进到封面会被拦下，重新确认一次）" };
    }
    return { videoReadyAt: updated.videoReadyAt ?? null };
  } catch (err) {
    return {
      videoReadyAt: null,
      stampWarning: `成片戳落盘失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 重开剪辑即作废上一版的「审过了」（`done` 上确认选段是全仓唯一一条离开 done 的边）。
 * 清不掉要报出来——留着它等于放行一版过时成片。
 */
export async function clearVideoDone(contentId: string, dataDir: string): Promise<void> {
  try {
    await updateContent(contentId, { videoDone: undefined }, dataDir);
  } catch (err) {
    console.warn(
      `[video] ${contentId} 的成片戳没清掉（推进到封面可能放行旧成片）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
