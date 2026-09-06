/**
 * 视频线入参的形态解析（snake_case ↔ 域内 camelCase），桌面 IPC 与 `autocrew_video` 共用。
 *
 * 为什么共用一份：两条入口面对的是**同一份契约**（`channel-contracts.ts` 的 `video:*`
 * 与工具 schema 的字段名逐个对齐）。各写一份解析，迟早在某个字段上分叉——
 * 那时「桌面能确认、宿主确认不了」这类 bug 只会以「模型又乱传参数」的面目出现。
 *
 * 一条纪律：**只管形态，不管语义**。分句存不存在、槽位越不越界、文字空不空由 service 与
 * 三道门判——把「不是字符串」与「改成了空的」混成同一句错话会让人摸不着头脑。
 * 任一不合法直接回一句人话错误串（返回值是 `string` 即失败）。
 */
import type {
  ConfirmCutArgs,
  EditUnitTextArgs,
  RequestPreviewArgs,
} from "./cut-gate.js";
import type { ConfirmEditorPlanArgs, FillEditorSlotArgs, RemoveEditorSlotArgs } from "./editor-gate.js";
import type { ConfirmReviewArgs } from "./review-gate.js";
import type { CutFlag, CutFlagKind } from "./types.js";

export type VideoPayload = Record<string, unknown>;

const FLAG_KINDS: readonly CutFlagKind[] = ["misread", "repeat", "offtopic"];

export function parseRevision(v: unknown, name: string): number | string {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return `${name} 必须是非负整数`;
  return v;
}

export function parseKeeps(v: unknown): string[] | string {
  if (!Array.isArray(v)) return "keeps 必须是分句 id 数组";
  const keeps = v.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  if (keeps.length !== v.length) return "keeps 里有非法分句 id";
  return keeps;
}

export function parseFlags(v: unknown): CutFlag[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return "flags 必须是数组";
  const out: CutFlag[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "flags 每项必须是对象";
    const item = raw as Record<string, unknown>;
    const segmentId = item.segment_id ?? item.segmentId;
    const flag = item.flag;
    if (typeof segmentId !== "string" || !segmentId) return "flags 缺 segment_id";
    if (typeof flag !== "string" || !FLAG_KINDS.includes(flag as CutFlagKind)) {
      return `flag 只能是 ${FLAG_KINDS.join(" / ")}`;
    }
    out.push({ segmentId, flag: flag as CutFlagKind });
  }
  return out;
}

/** cut_confirm 的全部入参一次解析完；任一不合法直接回错误串 */
export function parseCutArgs(payload: VideoPayload): ConfirmCutArgs | string {
  const keeps = parseKeeps(payload.keeps);
  if (typeof keeps === "string") return keeps;
  const flags = parseFlags(payload.flags);
  if (typeof flags === "string") return flags;
  const baseTranscript = parseRevision(payload.base_transcript_revision, "base_transcript_revision");
  if (typeof baseTranscript === "string") return baseTranscript;
  const baseCut = parseRevision(payload.base_cut_revision, "base_cut_revision");
  if (typeof baseCut === "string") return baseCut;
  return { keeps, flags, baseTranscriptRevision: baseTranscript, baseCutRevision: baseCut };
}

export function parseStringList(v: unknown, name: string): string[] | string {
  if (!Array.isArray(v)) return `${name} 必须是字符串数组`;
  const out = v.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  return out.length === v.length ? out : `${name} 里有非法项`;
}

/**
 * editor_confirm 的入参。`kept_overlay_ids` 只能是 plan 里原样的 id——service 会逐个核对，
 * 这里只管形态，免得把「前端传了个数字」当成「计划里没这段」报错。
 */
export function parseEditorPlanArgs(payload: VideoPayload): ConfirmEditorPlanArgs | string {
  const planRevision = parseRevision(payload.plan_revision, "plan_revision");
  if (typeof planRevision === "string") return planRevision;
  const keptOverlayIds = parseStringList(payload.kept_overlay_ids, "kept_overlay_ids");
  if (typeof keptOverlayIds === "string") return keptOverlayIds;
  return { planRevision, keptOverlayIds };
}

export function parseSlotArgs(payload: VideoPayload): RemoveEditorSlotArgs | string {
  const planRevision = parseRevision(payload.plan_revision, "plan_revision");
  if (typeof planRevision === "string") return planRevision;
  const overlayId = payload.overlay_id;
  if (typeof overlayId !== "string" || !overlayId.trim()) return "overlay_id 必须是非空字符串";
  return { planRevision, overlayId: overlayId.trim() };
}

export function parseSlotFillArgs(payload: VideoPayload): FillEditorSlotArgs | string {
  const slot = parseSlotArgs(payload);
  if (typeof slot === "string") return slot;
  const libraryId = payload.library_id;
  if (typeof libraryId !== "string" || !libraryId.trim()) return "library_id 必须是非空字符串";
  return { ...slot, libraryId: libraryId.trim() };
}

/**
 * 审片裁决的入参（lifecycle spec §2.4）。打回可带定位与备注：
 * 时间戳与备注都要落进不可变记录，所以在这一层就把形态定死，不让脏值进域内。
 */
export function parseReviewArgs(payload: VideoPayload): ConfirmReviewArgs | string {
  const rendered = parseRevision(payload.rendered_revision, "rendered_revision");
  if (typeof rendered === "string") return rendered;
  const verdict = payload.verdict;
  if (verdict !== "approve" && verdict !== "reject") return "verdict 只能是 approve / reject";
  const target = payload.target;
  if (target !== undefined && target !== "edit" && target !== "cut") return "target 只能是 edit / cut";
  const raw = payload.timestamp_ms;
  if (raw !== undefined && raw !== null && (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)) {
    return "timestamp_ms 必须是非负数（成片时间轴毫秒）";
  }
  const note = payload.note;
  if (note !== undefined && note !== null && typeof note !== "string") return "note 必须是字符串";
  return {
    renderedRevision: rendered,
    verdict,
    ...(target ? { target } : {}),
    ...(typeof raw === "number" ? { timestampMs: Math.round(raw) } : {}),
    ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
  };
}

/**
 * 手工改字的入参（转写纠错 spec §6）。**三个 base 都是必填**：文字住在 clean 里，
 * 少锁一版就等于允许「后台刚换过文字」时盲改。
 */
export function parseTextEditArgs(payload: VideoPayload): EditUnitTextArgs | string {
  const unitId = payload.unit_id;
  if (typeof unitId !== "string" || !unitId.trim()) return "unit_id 必须是非空字符串";
  const text = payload.text;
  if (typeof text !== "string") return "text 必须是字符串";
  const baseTranscript = parseRevision(payload.base_transcript_revision, "base_transcript_revision");
  if (typeof baseTranscript === "string") return baseTranscript;
  const baseClean = parseRevision(payload.base_clean_revision, "base_clean_revision");
  if (typeof baseClean === "string") return baseClean;
  const baseCut = parseRevision(payload.base_cut_revision, "base_cut_revision");
  if (typeof baseCut === "string") return baseCut;
  return {
    unitId: unitId.trim(),
    text,
    baseTranscriptRevision: baseTranscript,
    baseCleanRevision: baseClean,
    baseCutRevision: baseCut,
  };
}

/** 预览请求：勾选是草稿，所以只带 keeps 与两个 base revision，不带 flags */
export function parsePreviewArgs(payload: VideoPayload): RequestPreviewArgs | string {
  const keeps = parseKeeps(payload.keeps);
  if (typeof keeps === "string") return keeps;
  const baseTranscript = parseRevision(payload.base_transcript_revision, "base_transcript_revision");
  if (typeof baseTranscript === "string") return baseTranscript;
  const baseCut = parseRevision(payload.base_cut_revision, "base_cut_revision");
  if (typeof baseCut === "string") return baseCut;
  return { keeps, baseTranscriptRevision: baseTranscript, baseCutRevision: baseCut };
}
