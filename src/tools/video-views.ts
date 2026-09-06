/**
 * `autocrew_video` 的三个只读视图（P3c spec §14.2）：状态人话、紧凑转写、成片计划。
 *
 * 为什么单独成文件：宿主模型看到的**只有**这几段 JSON——它决定「下一步该干什么」的全部
 * 依据就在这里。这些函数不碰服务、不碰盘，纯投影，所以可以逐条对着 spec 的边界清单读。
 *
 * 两条纪律：
 * 1. **默认紧凑**：15 分钟口播的逐词时间戳有上万条，原样吐出去会把宿主的上下文烧光
 *    （§14.4 最坏输入）。默认只给「id + 起止 + 文字 + AI 建议」，`full:true` 才展开词级。
 * 2. **下一步一定说得出人话**：每一个 phase/state 组合、每一个 blocked 原因、失败的
 *    `failReason` 都要落到 `next` 上（§14.4 失败可见）。说不出的组合也要如实说「说不出」，
 *    不许返回空串——空的 `next` 会让模型自己编一个下一步。
 */
import type { EditorPlanView } from "../modules/video/editor-gate.js";
import type { CutView, VideoStatus } from "../modules/video/service.js";
import type { CutFlagKind, TranscriptSegment, VideoState } from "../modules/video/types.js";

export interface TranscriptUnitView {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  /** AI 提议剔除这一句（**是提案不是决定**）：flag 是标记，quote 是原话 */
  suggested_drop?: { flag?: CutFlagKind; quote: string };
  /** `full:true` 才有：词级时间戳 */
  words?: Array<{ w: string; start_ms: number; end_ms: number }>;
}

const PHASE_RUNNING: Record<string, string> = {
  ingest: "正在导入口播原片，轮询 status 等它跑完",
  transcribe: "正在转写（15 分钟口播要跑十几分钟），轮询 status，别重复 start",
  cut: "AI 粗剪在跑，轮询 status；跑完会停在选段这道门等人",
  edit: "剪辑师在排素材，轮询 status；跑完会停在成片计划这道门等人",
  assemble: "正在组装时间轴，轮询 status",
  render: "正在渲染成片，轮询 status",
  review: "正在收尾，轮询 status",
  done: "正在收尾清理，轮询 status",
};

const BLOCKED: Record<string, string> = {
  asr_not_ready: "转写引擎没就绪（模型没下好或 uv 没装）：先看 asr_status，装好之后 retry",
  ffmpeg_missing: "ffmpeg 不可用：装好 ffmpeg（autocrew doctor 会说怎么装）再 retry",
  aroll_drifted: "口播原片被换过或改过，和已登记的指纹对不上：把原片放回去，或重新走一次导入再 retry",
  key_missing: "模型 API key 没配：在工作台配好线路再 retry",
  budget_exceeded: "这一步超了预算上限：调整预算或缩短素材再 retry",
};

/** 失败/阻塞的人话：原因原样带上，不复述成「出错了」 */
function troubleText(state: VideoState): string {
  const detail = state.failReason ?? state.errorCode ?? "";
  if (state.state === "blocked") {
    const known = state.blockedReason ? BLOCKED[state.blockedReason] : undefined;
    return `卡住了：${known ?? detail ?? "原因不明"}${known && detail ? `（${detail}）` : ""}`;
  }
  if (state.errorCode === "aroll_missing") {
    return "失败：这篇稿件的资产里没有口播原片——先把 A-roll 放进资产（role=aroll）再 retry";
  }
  const tail = state.failedPhase ? `（失败在 ${state.failedPhase}）` : "";
  return `失败${tail}：${detail || "原因不明"}；确认原因后用 retry 重试`;
}

/** 人工门上的下一步（三道门都是创作者的决定，人设照这句话行事） */
function gateText(state: VideoState): string {
  if (state.phase === "cut") {
    return "粗剪待你确认：用 transcript 读建议，把「引句 + 标记」摆给创作者，他点头后 cut_confirm";
  }
  if (state.phase === "edit") {
    return "素材规划待你确认：用 editor_plan 读编排，逐条问过创作者（填库里的哪条 / 删）后 editor_confirm";
  }
  if (state.phase === "review") {
    return "成片待审：把成片路径交给创作者看过，他说通过才 review approve；有意见就 review revise";
  }
  return `停在 ${state.phase} 等人，但这道门没有对应动作——把状态原样告诉创作者`;
}

/** `status.next`：每个 phase/state 都说得出下一步（§14.2 / §14.4） */
export function nextHint(status: VideoStatus | null): string {
  if (!status) return "这篇还没开始剪：确认稿件是视频平台且已定稿，然后 start";
  const state = status.state;
  if (state.state === "failed" || state.state === "blocked") return troubleText(state);
  if (state.phase === "done" && state.state === "done") return "已完成：成片审过并盖了戳，接下来是封面师的活";
  if (state.state === "idle") return "这篇还没开始剪：用 start 投递";
  if (state.state === "awaiting_human") return gateText(state);
  return PHASE_RUNNING[state.phase] ?? "正在跑，轮询 status";
}

function unitOf(seg: TranscriptSegment, dropped: boolean, flag: CutFlagKind | undefined, full: boolean): TranscriptUnitView {
  return {
    id: seg.id,
    start_ms: seg.startMs,
    end_ms: seg.endMs,
    text: seg.text,
    ...(dropped ? { suggested_drop: { ...(flag ? { flag } : {}), quote: seg.text } } : {}),
    ...(full ? { words: seg.words.map((w) => ({ w: w.w, start_ms: w.startMs, end_ms: w.endMs })) } : {}),
  };
}

/**
 * 紧凑转写视图。单元取**剪辑单元表**（AI 按 drop 区间重分过的那份），没有才回落转写分句
 * ——门上勾的是哪一份，这里给的就必须是哪一份，否则人对着两套 id 做取舍。
 */
export function transcriptViewOf(
  view: CutView,
  state: VideoState,
  full: boolean,
): Record<string, unknown> {
  const units = view.editUnits?.segments ?? view.transcript.segments;
  const dropped = new Set(view.editUnits?.suggestedDrops ?? []);
  const flags = new Map((view.editUnits?.flags ?? []).map((f) => [f.segmentId, f.flag]));
  return {
    units: units.map((s) => unitOf(s, dropped.has(s.id), flags.get(s.id), full)),
    // 当前这一版选段的决策（cut_confirm 要原样带回去的三样）
    keeps: view.cut.keeps,
    flags: view.cut.flags.map((f) => ({ segment_id: f.segmentId, flag: f.flag })),
    origin: view.cut.origin,
    base_transcript_revision: state.revisions.transcript ?? 0,
    base_cut_revision: state.revisions.cut ?? 0,
    ...(state.revisions.clean ? { base_clean_revision: state.revisions.clean } : {}),
    ...(view.cleanWarning ? { clean_warning: view.cleanWarning } : {}),
    ...(view.editUnits?.warning ? { warning: view.editUnits.warning } : {}),
  };
}

/** 成片计划视图：每段编排的落位与来源；`plan_revision` 就是确认时的乐观锁 */
export function editorPlanViewOf(view: EditorPlanView): Record<string, unknown> {
  return {
    plan_revision: view.revision,
    cut_revision: view.plan.cutRevision,
    origin: view.plan.origin,
    overlays: view.plan.overlays.map((o) => ({
      overlay_id: o.overlayId,
      label: o.label,
      source:
        o.source.kind === "asset"
          ? { kind: "asset", name: o.source.name, ref: o.source.ref, media_kind: o.source.type }
          : { kind: "generate", description: o.source.description, media_kind: o.source.mediaKind },
      output_start_ms: o.outputStartMs,
      duration_ms: o.durationMs,
    })),
    ...(view.staleCutRevision !== undefined ? { stale_cut_revision: view.staleCutRevision } : {}),
    ...(view.plan.warning ? { warning: view.plan.warning } : {}),
    ...(view.plan.note ? { note: view.plan.note } : {}),
    ...(view.plan.excludedAssets?.length ? { excluded_assets: view.plan.excludedAssets } : {}),
  };
}
