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
 * 模型发起的调用：MCP 服务端注入 `_host`，OpenClaw 注入 `_modelCall`（客户端自报的同名值都被覆盖）。
 * 工作台 / 桌面 IPC 的人手点击两样都不带。
 */
export function isModelCall(params: Record<string, unknown>): boolean {
  return typeof params._host === "string" || params._modelCall === true;
}

/**
 * 阶段门信的两枚标记——成片戳 `videoDone`、封面定稿——对视频稿是创始人的 gate3 / gate4。
 * 模型调用盖不出来（P6 §14.7 #1）：否则拿着令牌的宿主连调审片通过、选封面、推进，就能绕过工作台进「待发布」。
 */
export const FOUNDER_APPROVAL_ONLY =
  "视频稿的审片通过与封面定稿是创始人的决定，只能由创作者在 AutoCrew 工作台上点，AI 宿主不能代批。把成片 / 封面交给创作者，请创作者在工作台审；有意见照常可以替创作者报打回。";

/** 「剪辑中」只能由交接进入（P6 §13.4-C）：手动切换、改状态、直接建在剪辑中一律拒绝 */
export const EDITING_VIA_HANDOFF =
  "「剪辑中」只能由交接进入，不能手动切换。录完按标题命名放进 Downloads，在 Codex 里说「剪这条」，由 Codex 认稿后弹窗确认交接（autocrew_video handoff）。";

/**
 * 返回人话拒绝原因；`null` = 这一步阶段门放行。
 *
 * `coverApproved` 是懒的：只有走到「封面设计 / 剪辑 → 待发布」那两条才会真去读评审单。
 */
export async function stageGuardError(
  subject: StageGuardSubject,
  from: ContentStatus,
  to: ContentStatus,
  coverApproved: () => Promise<boolean>,
  opts: { viaHandoff?: boolean } = {},
): Promise<string | null> {
  const video = isVideoPlatform(subject.platform);

  if (to === "editing" && !video) {
    return "剪辑阶段只属于视频平台稿件";
  }
  if (to === "editing" && !opts.viaHandoff) return EDITING_VIA_HANDOFF;
  // 不变量写目标不写来路：视频稿进「待发布」只有两个入口——封面台，或剪辑工位登记
  // （P6 §3.4：成片戳与封面定稿同一次登记落盘，`editing → publish_ready` 两样都在才放行）。
  // 只挡 approved 一条边挡不住看板从「待审」直拖到「待发布」——force 越得过形状，但阶段是产品事实
  if (video && to === "publish_ready" && from !== "cover_pending") {
    const registered = from === "editing" && Boolean(subject.videoDone) && (await coverApproved());
    if (!registered) return "视频稿要先过剪辑与封面（交接给剪辑工位）";
  }
  // 成片戳只有创始人审片或带工作台批准的登记才盖得出（P6 §14.7 #1）。视频稿进封面台、进待发布都要它，
  // 不看来路：force 能从「已过审」直推封面台，只挡 editing 那条边就等于封面台后面没人看成片
  if (video && (to === "cover_pending" || to === "publish_ready") && !subject.videoDone) {
    return "成片还没审通过——先在剪辑台把片子审过，再推进到封面";
  }
  if (from === "cover_pending" && to === "publish_ready" && !(await coverApproved())) {
    return "封面还没定稿";
  }
  return null;
}
