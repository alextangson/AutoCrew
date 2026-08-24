/**
 * 阶段门（稿件阶段制 spec §1.2）。
 *
 * 与 `STATE_TRANSITIONS` 分开住，因为两者的可越性不同：迁移表是**状态图的形状**，
 * 看板拖拽这类人工工具可以 `force` 强推；阶段门是**产品事实**（片子审过没有、封面定稿没有），
 * 强推它等于让没剪的片子进封面台——所以 `force` 越不过这一层。
 *
 * 纯判定、零 I/O：写锁内的真正写入、推进下拉的灰显预判、发布预检的自动流转，
 * 三处喂同一份输入拿同一句人话，不许各判一套。
 */
import type { ContentStatus } from "./local-store.js";

/**
 * 视频平台清单。定义落在这里而不是 `modules/publish/video-kit`：那个文件 import 了
 * local-store，而 local-store 要 import 本文件——放那边会成运行时环。video-kit 改为
 * 从这里再导出，既有调用方一个字不用改。
 */
export const VIDEO_PLATFORMS: ReadonlySet<string> = new Set([
  "douyin",
  "wechat_video",
  "xiaohongshu",
  "bilibili",
]);

export function isVideoPlatform(platform?: string | null): boolean {
  return VIDEO_PLATFORMS.has(platform ?? "");
}

/** 阶段门要看的稿件事实——刻意只收这两个字段，判定不许偷偷依赖别的状态 */
export interface StageGuardSubject {
  platform?: string;
  /**
   * 审片通过时视频线盖的戳，重开剪辑时清除。阶段门**只认它**：
   * `videoReadyAt` 是「首次达成」永不覆盖的指标戳，重剪之后那枚旧戳会放行过时成片。
   */
  videoDone?: { renderedRevision: number; at: string };
}

/**
 * 返回人话拒绝原因；`null` = 这一步阶段门放行。
 *
 * `coverApproved` 是懒的：只有走到「封面设计 → 待发布」那一条才会真去读评审单。
 */
export async function stageGuardError(
  subject: StageGuardSubject,
  from: ContentStatus,
  to: ContentStatus,
  coverApproved: () => Promise<boolean>,
): Promise<string | null> {
  const video = isVideoPlatform(subject.platform);

  if (to === "editing" && !video) {
    return "剪辑阶段只属于视频平台稿件";
  }
  // 不变量写目标不写来路：视频稿进「待发布」只有封面台一个入口。只挡 approved 一条边
  // 挡不住看板从「待审」直拖到「待发布」——force 越得过形状，但阶段是产品事实
  if (video && to === "publish_ready" && from !== "cover_pending") {
    return "视频稿要先过剪辑与封面（推进到剪辑）";
  }
  if (from === "editing" && to === "cover_pending" && !subject.videoDone) {
    return "成片还没审通过——先在剪辑台把片子审过，再推进到封面";
  }
  if (from === "cover_pending" && to === "publish_ready" && !(await coverApproved())) {
    return "封面还没定稿";
  }
  return null;
}
