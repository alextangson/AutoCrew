/**
 * 剪辑师 agent 的确定性部分（横屏 spec §3.3 校验 + §4 边界清单）：素材清单筛选、plan 校验、
 * plan → 覆盖轨槽位、门内填槽派生新版。
 *
 * 与 `editor.ts` 的分工同粗剪：这里**零 IO、零模型**，全是纯函数，用边界值锁死；
 * 那边负责调模型、失败降级。切开是因为两件事的失败模式完全不同——这边错了是算错，
 * 那边错了是外部不可用。
 *
 * 两条口径贯穿全文：
 * - **硬规则由代码判，软目标只写进 prompt**。开头 30s / 结尾 15s 无 overlay 是代码校验，
 *   不是对模型的请求（codex 明确点名）——请求会被忘掉，校验不会。
 * - **边界值合法**：恰好 60% 覆盖、恰好 45s 单段、恰好 5s 露脸间隔都放行（§4 #6）。
 *   卡在等号上的产物比错误的产物更难查，所以口径写死在这里并被测试锁住。
 */
import type { Asset } from "../../storage/local-store.js";
import type { OverlaySlot } from "./timeline-build.js";
import { TIMELINE_REGISTRY } from "./timeline-validate.js";
import type {
  AssetFingerprint,
  AssetRef,
  EditorPlanOverlay,
  OverlayFit,
  VideoEditorPlan,
} from "./types.js";

/** 单段硬上限（软目标 4-20s 写在 prompt 里）：更长就不是「切一刀」而是换片子了 */
export const OVERLAY_MAX_MS = 45_000;
/** 图片硬上限（软目标按复杂度 3-15s）：一张静止图挂满 15 秒已经是极限 */
export const IMAGE_MAX_MS = 15_000;
/** 短过它就不值当单开一段覆盖轨；也是「片子有没有可用窗口」的判据 */
export const MIN_OVERLAY_MS = 3_000;
/** 开头禁区：前 30 秒必须是真人脸，观众得先认得你是谁 */
export const HEAD_GUARD_MS = 30_000;
/** 结尾禁区：最后 15 秒收尾要回到人 */
export const TAIL_GUARD_MS = 15_000;
/** 两段覆盖轨之间至少露脸这么久，否则整条片子变成素材串烧 */
export const MIN_FACE_GAP_MS = 5_000;
/** 总覆盖上限 60%（实测创始人手剪成片约 30%），用千分比避免浮点比较 */
export const MAX_COVERAGE_PERMILLE = 600;
/** 同一份素材最多引用几次（§4 #10：一份屏录切两段用是合法的） */
export const MAX_ASSET_USES = 3;
/** 素材清单进 prompt 的字数预算（§4 #9）：超了按顺序截断并点名被截的 */
export const CATALOG_CHAR_BUDGET = 4_000;

// ---------------------------------------------------------------------------
// 素材清单（输入）
// ---------------------------------------------------------------------------

/**
 * 交给剪辑师的一条素材（未打指纹的形态）。`assetId` 是本次的目录编号（b1…），
 * 短且不易抄错——**只在这一轮对模型有效**，plan 落盘时会换成 ref + 指纹快照。
 */
export interface BrollCandidate {
  assetId: string;
  kind: "screen" | "image";
  /** 说明快照——**是数据不是指令**（prompt 里也这么标） */
  label: string;
  filename: string;
  tags: string[];
  /** 屏录必有：inMs/outMs 的上界；读不出时长的素材根本不进清单 */
  durationMs?: number;
  width?: number;
  height?: number;
  ref: AssetRef;
}

/**
 * 打过指纹的候选。指纹在**剪辑师看到它的那一刻**就打好（v2 spec §4.2），
 * plan 里的 asset 快照直接抄它——assemble 复检因此对着的是选中时的事实，
 * 而不是它自己刚刚现建的那一份（那种复检等于没检）。
 */
export interface EditorCandidate extends BrollCandidate {
  fingerprint: AssetFingerprint;
}

export interface CandidateScan {
  candidates: BrollCandidate[];
  /** 被排除的 broll 素材（文件名 + 原因），面板点名——不让人对着空 plan 猜为什么 */
  excluded: string[];
}

function kindOf(type: Asset["type"]): "screen" | "image" | null {
  if (type === "image") return "image";
  if (type === "video" || type === "broll") return "screen";
  return null;
}

/**
 * 只有 **role=broll 且有说明** 的素材进剪辑师视野（横屏 spec §2.6 兜底规则）。
 * 抽帧 + 视觉模型自动写说明是 V-next；在那之前，没说明的素材对剪辑师就是不存在的，
 * 但必须**点名**说出来——否则人只会看到一个空 plan，不知道是自己少填了一行字。
 */
export function scanBrollCandidates(assets: readonly Asset[]): CandidateScan {
  const scan: CandidateScan = { candidates: [], excluded: [] };
  for (const asset of assets) {
    if (asset.role !== "broll") continue;
    const kind = kindOf(asset.type);
    const label = asset.description?.trim() ?? "";
    if (!kind) {
      scan.excluded.push(`${asset.filename}（不是视频或图片，剪辑师用不了）`);
      continue;
    }
    if (!label) {
      scan.excluded.push(`${asset.filename}（没写说明）`);
      continue;
    }
    if (kind === "screen" && !(asset.media?.durationMs && asset.media.durationMs > 0)) {
      scan.excluded.push(`${asset.filename}（读不出时长，挂接时 ffprobe 没跑成）`);
      continue;
    }
    scan.candidates.push({
      assetId: `b${scan.candidates.length + 1}`,
      kind,
      label,
      filename: asset.filename,
      tags: asset.tags ?? [],
      ...(asset.media?.durationMs ? { durationMs: asset.media.durationMs } : {}),
      ...(asset.media?.width ? { width: asset.media.width } : {}),
      ...(asset.media?.height ? { height: asset.media.height } : {}),
      ref: { kind: "content", filename: asset.filename },
    });
  }
  return scan;
}

/** 素材过多超上下文（§4 #9）：按字数预算截断，被截的进 excluded 点名 */
export function trimCandidates(scan: CandidateScan, budget = CATALOG_CHAR_BUDGET): CandidateScan {
  let used = 0;
  const kept: BrollCandidate[] = [];
  const excluded = [...scan.excluded];
  for (const c of scan.candidates) {
    const cost = c.label.length + c.filename.length + c.tags.join("").length + 40;
    if (kept.length > 0 && used + cost > budget) {
      excluded.push(`${c.filename}（素材太多，这一条超出本次上下文预算）`);
      continue;
    }
    used += cost;
    kept.push(c);
  }
  return { candidates: kept, excluded };
}

// ---------------------------------------------------------------------------
// plan 校验（§3.3）
// ---------------------------------------------------------------------------

/** 模型交上来、已过形态归一的一段覆盖轨的公共部分 */
export interface SubmittedOverlayBase {
  outputStartMs: number;
  durationMs: number;
  inMs?: number;
  outMs?: number;
  fit?: OverlayFit;
  transition?: string;
}

/**
 * 两类来源二选一（v2 spec §4.2）：挂已有素材，或提一个待生成的画面。
 * `generate` 槽有完整时间落位，所以它跟已有素材受同一套硬规则约束——
 * 它就是未来的画面，不是占位符。
 */
export type SubmittedOverlay =
  | (SubmittedOverlayBase & { assetId: string })
  | (SubmittedOverlayBase & { description: string; mediaKind: "video" | "image" });

export function isGenerateSubmission(
  o: SubmittedOverlay,
): o is SubmittedOverlayBase & { description: string; mediaKind: "video" | "image" } {
  return !("assetId" in o);
}

/** 合法窗口 = 掐掉开头结尾禁区之后剩下的那段成片 */
export function legalWindow(outputDurationMs: number): { from: number; to: number } {
  return { from: HEAD_GUARD_MS, to: outputDurationMs - TAIL_GUARD_MS };
}

/** 片子太短就没有任何合法窗口——这时不该调模型，空 plan 是正确答案而不是失败 */
export function hasLegalWindow(outputDurationMs: number): boolean {
  const win = legalWindow(outputDurationMs);
  return win.to - win.from >= MIN_OVERLAY_MS;
}

/** 时间落位与形态：两类来源共用（generate 槽同样占画面，同样受禁区与上限约束） */
function checkPlacement(o: SubmittedOverlay, label: string, still: boolean, total: number): string[] {
  const errors: string[] = [];
  const end = o.outputStartMs + o.durationMs;
  const win = legalWindow(total);
  if (o.outputStartMs < 0 || o.durationMs <= 0) {
    return [`${label} 的 outputStartMs 必须 ≥0、durationMs 必须 >0`];
  }
  if (end > total) errors.push(`${label} 越界：${o.outputStartMs}+${o.durationMs}=${end}ms 超过成片总长 ${total}ms`);
  if (o.outputStartMs < win.from || end > win.to) {
    errors.push(
      `${label} 落在禁区里：开头 ${HEAD_GUARD_MS / 1000}s 与结尾 ${TAIL_GUARD_MS / 1000}s 必须是真人脸，` +
        `合法窗口是 [${win.from}, ${win.to}]ms，你给的是 [${o.outputStartMs}, ${end}]ms`,
    );
  }
  if (o.durationMs > OVERLAY_MAX_MS) errors.push(`${label} 单段 ${o.durationMs}ms 超过上限 ${OVERLAY_MAX_MS}ms`);
  if (still && o.durationMs > IMAGE_MAX_MS) {
    errors.push(`${label} 是图片，${o.durationMs}ms 超过图片上限 ${IMAGE_MAX_MS}ms（一张静图挂太久观众会走神）`);
  }
  if (o.fit !== undefined && o.fit !== "cover" && o.fit !== "contain") {
    errors.push(`${label}.fit 只能是 cover / contain`);
  }
  if (o.transition !== undefined && !TIMELINE_REGISTRY.transitions.includes(o.transition)) {
    errors.push(`${label}.transition 不在受控枚举里：${o.transition}（可用：${TIMELINE_REGISTRY.transitions.join("、")}）`);
  }
  return errors;
}

/** inMs/outMs 是 codex 的阻断项：不说清取素材哪一段，屏录就只能从头播（§3.3） */
function checkTrim(o: SubmittedOverlayBase, label: string, c: BrollCandidate): string[] {
  if (c.kind === "image") {
    return o.inMs !== undefined || o.outMs !== undefined
      ? [`${label} 引用的是图片，没有时间轴，不要给 inMs/outMs`]
      : [];
  }
  if (o.inMs === undefined || o.outMs === undefined) {
    return [`${label} 缺 inMs/outMs：屏录必须说清取素材的哪一段（素材 ${c.assetId} 全长 ${c.durationMs}ms）`];
  }
  const errors: string[] = [];
  if (o.inMs < 0 || o.outMs <= o.inMs) errors.push(`${label} 的 [inMs, outMs) = [${o.inMs}, ${o.outMs}) 不成立`);
  else {
    if (o.outMs > (c.durationMs ?? 0)) {
      errors.push(`${label} 的 outMs=${o.outMs} 超过素材 ${c.assetId} 的全长 ${c.durationMs}ms`);
    }
    if (o.outMs - o.inMs !== o.durationMs) {
      errors.push(
        `${label} 的取材跨度 ${o.outMs - o.inMs}ms 与 durationMs=${o.durationMs}ms 对不上——` +
          "不做变速，两者必须相等",
      );
    }
  }
  return errors;
}

/** 排布规则：不重叠、间隔够露脸、总覆盖不超、同素材不滥用 */
function checkLayout(items: readonly SubmittedOverlay[], total: number): string[] {
  const errors: string[] = [];
  const sorted = [...items].sort((a, b) => a.outputStartMs - b.outputStartMs);
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].outputStartMs + sorted[i - 1].durationMs;
    const gap = sorted[i].outputStartMs - prevEnd;
    if (gap < 0) {
      errors.push(`两段覆盖轨重叠：${sorted[i - 1].outputStartMs}ms 那段还没结束，${sorted[i].outputStartMs}ms 那段就开始了`);
    } else if (gap < MIN_FACE_GAP_MS) {
      errors.push(
        `${prevEnd}ms 与 ${sorted[i].outputStartMs}ms 这两段之间只露脸 ${gap}ms，` +
          `不足 ${MIN_FACE_GAP_MS}ms——观众需要看见你在说话`,
      );
    }
  }
  const covered = items.reduce((sum, o) => sum + o.durationMs, 0);
  if (covered * 1000 > total * MAX_COVERAGE_PERMILLE) {
    errors.push(
      `总覆盖 ${covered}ms / ${total}ms = ${Math.round((covered / total) * 100)}%，` +
        `超过上限 ${MAX_COVERAGE_PERMILLE / 10}%——这是口播片，B-roll 是佐料不是主菜`,
    );
  }
  // generate 槽没有素材身份，每一条都是一个独立的未来镜头，不计入「同素材复用」
  const uses = new Map<string, number>();
  for (const o of items) {
    if (isGenerateSubmission(o)) continue;
    uses.set(o.assetId, (uses.get(o.assetId) ?? 0) + 1);
  }
  for (const [assetId, n] of uses) {
    if (n > MAX_ASSET_USES) errors.push(`素材 ${assetId} 被用了 ${n} 次，上限 ${MAX_ASSET_USES} 次`);
  }
  return errors;
}

/** 全部错误一次报完（不挤牙膏）：自纠只有三轮，每轮都该把当前所有问题看全 */
export function validatePlanOverlays(
  items: readonly SubmittedOverlay[],
  candidates: readonly BrollCandidate[],
  outputDurationMs: number,
): string[] {
  const byId = new Map(candidates.map((c) => [c.assetId, c]));
  const errors: string[] = [];
  items.forEach((o, i) => {
    const label = `overlays[${i}]`;
    if (isGenerateSubmission(o)) {
      errors.push(...checkPlacement(o, label, o.mediaKind === "image", outputDurationMs));
      if (o.inMs !== undefined || o.outMs !== undefined) {
        errors.push(`${label} 是待生成的画面，还没有源文件，不要给 inMs/outMs`);
      }
      return;
    }
    const c = byId.get(o.assetId);
    if (!c) {
      errors.push(`${label} 的 assetId「${o.assetId}」不在素材清单里（可用：${[...byId.keys()].join("、") || "无"}）`);
      return;
    }
    errors.push(...checkPlacement(o, label, c.kind === "image", outputDurationMs), ...checkTrim(o, label, c));
  });
  return errors.length > 0 ? errors : checkLayout(items, outputDurationMs);
}

function stillOf(o: SubmittedOverlay, byId: Map<string, EditorCandidate>): boolean {
  return isGenerateSubmission(o) ? o.mediaKind === "image" : byId.get(o.assetId)!.kind === "image";
}

/** 校验通过后定型：补 overlayId 与来源快照，plan 从此自洽（确认时不用再查一遍素材） */
export function toPlanOverlays(
  items: readonly SubmittedOverlay[],
  candidates: readonly EditorCandidate[],
): EditorPlanOverlay[] {
  const byId = new Map(candidates.map((c) => [c.assetId, c]));
  return [...items]
    .sort((a, b) => a.outputStartMs - b.outputStartMs)
    .map((o, i) => {
      const still = stillOf(o, byId);
      const c = isGenerateSubmission(o) ? null : byId.get(o.assetId)!;
      return {
        overlayId: `ov-${String(i + 1).padStart(2, "0")}`,
        label: c ? c.label : (o as { description: string }).description,
        source: c
          ? ({
              kind: "asset" as const,
              ref: c.ref,
              name: c.filename,
              type: c.kind,
              ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
              fingerprint: c.fingerprint,
            })
          : ({
              kind: "generate" as const,
              description: (o as { description: string }).description,
              mediaKind: (o as { mediaKind: "video" | "image" }).mediaKind,
            }),
        outputStartMs: o.outputStartMs,
        durationMs: o.durationMs,
        ...(o.inMs !== undefined ? { inMs: o.inMs } : {}),
        ...(o.outMs !== undefined ? { outMs: o.outMs } : {}),
        ...(o.fit ? { fit: o.fit } : {}),
        // 屏录 cut、图版 fade（§3.4）；模型给了就按它的
        transition: o.transition ?? (still ? "fade" : "cut"),
      };
    });
}

/**
 * 人删完之后的 plan → assemble 消费的覆盖轨槽位。
 * **只有 asset 槽出得来**：未填的 generate 槽在确认时被显式丢弃（v2 spec §4.2），
 * 面板已经把丢弃条数说给人听了，这里不再重复判断。
 */
export function planToSlots(overlays: readonly EditorPlanOverlay[]): OverlaySlot[] {
  return [...overlays]
    .sort((a, b) => a.outputStartMs - b.outputStartMs)
    .flatMap((o) =>
      o.source.kind === "asset"
        ? [
            {
              kind: o.source.type,
              ref: o.source.ref,
              ...(o.source.fingerprint ? { fingerprint: o.source.fingerprint } : {}),
              outputStartMs: o.outputStartMs,
              durationMs: o.durationMs,
              ...(o.inMs !== undefined ? { inMs: o.inMs } : {}),
              ...(o.outMs !== undefined ? { outMs: o.outMs } : {}),
              ...(o.fit ? { fit: o.fit } : {}),
              ...(o.transition ? { transition: o.transition } : {}),
            },
          ]
        : [],
    );
}

// ---------------------------------------------------------------------------
// 门内填槽（v2 spec §4.2）
// ---------------------------------------------------------------------------

/** 人挑来填槽的那份素材，指纹在**填槽这一刻**打好 */
export interface SlotFillAsset {
  ref: AssetRef;
  name: string;
  type: "screen" | "image";
  durationMs?: number;
  fingerprint: AssetFingerprint;
}

/**
 * 把一个 generate 槽换成 asset 槽，**派生出新的一版 plan**——旧版原样留盘。
 * 就地改 plan 会违反「版本化产物只增不改」，也会让乐观锁失去基准（codex ③）。
 *
 * 校验按 mediaKind 分岔：
 * - video：素材时长必须够盖满槽位；取段定 `inMs=0, outMs=durationMs`（V-next 再做取段）。
 * - image：静图没有时间轴，无时长检查，也不写 inMs/outMs。
 *
 * 返回字符串 = 人话拒绝原因（调用方原样透传给面板）。
 */
export function fillPlanSlot(
  plan: VideoEditorPlan,
  basePlanRevision: number,
  overlayId: string,
  asset: SlotFillAsset,
): VideoEditorPlan | string {
  const target = plan.overlays.find((o) => o.overlayId === overlayId);
  if (!target) return `这一版计划里没有 ${overlayId} 这一段，请重载后重试`;
  if (target.source.kind !== "generate") return `${overlayId} 已经挂着素材了，不需要填充`;
  const want = target.source.mediaKind;
  if (want === "image" && asset.type !== "image") return `这一槽要的是图片，你选的是视频素材`;
  if (want === "video" && asset.type !== "screen") return `这一槽要的是视频，你选的是图片素材`;
  if (want === "video") {
    const available = asset.durationMs ?? 0;
    if (available < target.durationMs) {
      return (
        `素材只有 ${available}ms，盖不满这一槽的 ${target.durationMs}ms——` +
        "换一条更长的，或先在剪辑师那儿把这一段改短"
      );
    }
  }
  const filled: EditorPlanOverlay = {
    overlayId: target.overlayId,
    label: target.label,
    source: {
      kind: "asset",
      ref: asset.ref,
      name: asset.name,
      type: asset.type,
      ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
      fingerprint: asset.fingerprint,
    },
    outputStartMs: target.outputStartMs,
    durationMs: target.durationMs,
    ...(want === "video" ? { inMs: 0, outMs: target.durationMs } : {}),
    ...(target.fit ? { fit: target.fit } : {}),
    ...(target.transition ? { transition: target.transition } : {}),
  };
  return {
    ...plan,
    origin: "human",
    basePlanRevision,
    overlays: plan.overlays.map((o) => (o.overlayId === overlayId ? filled : o)),
  };
}

/** 未填的 generate 槽条数——面板要在确认按钮旁把它说出来（不许默默丢） */
export function pendingGenerateSlots(overlays: readonly EditorPlanOverlay[]): EditorPlanOverlay[] {
  return overlays.filter((o) => o.source.kind === "generate");
}

// ---------------------------------------------------------------------------
// v1 旧 plan 的一次性容忍（v2 spec §4.2 升级兼容）
// ---------------------------------------------------------------------------

/** v1 overlay 的形状：来源字段是平铺的（assetId=b 号 / kind / ref），没有 source 判别联合 */
interface LegacyOverlay {
  overlayId: string;
  assetId?: string;
  label?: string;
  filename?: string;
  kind?: "screen" | "image";
  ref?: AssetRef;
  outputStartMs: number;
  durationMs: number;
  inMs?: number;
  outMs?: number;
  fit?: OverlayFit;
  transition?: string;
}

/**
 * 把停在门上的 v1 plan 读成 v2 形状。**只在读取时做，不回写**——旧产物是审计凭证，
 * 原地升级会把「当时排的是什么」改掉。未知字段（emphasisWords 等）原样忽略。
 *
 * 落点兜底：v1 有 `ref` 就直接用；没有就按 `filename` 映射回稿件 assets 目录
 * （b 号只是那一轮给模型的目录编号，对外没有意义）。
 */
export function tolerateLegacyPlan(plan: VideoEditorPlan): VideoEditorPlan {
  if (plan.overlays.every((o) => o.source?.kind === "asset" || o.source?.kind === "generate")) return plan;
  const overlays = plan.overlays.map((raw) => {
    if (raw.source) return raw;
    const o = raw as unknown as LegacyOverlay;
    const type = o.kind === "image" ? ("image" as const) : ("screen" as const);
    const name = o.filename ?? o.assetId ?? o.overlayId;
    return {
      overlayId: o.overlayId,
      label: o.label ?? name,
      source: { kind: "asset" as const, ref: o.ref ?? { kind: "content" as const, filename: name }, name, type },
      outputStartMs: o.outputStartMs,
      durationMs: o.durationMs,
      ...(o.inMs !== undefined ? { inMs: o.inMs } : {}),
      ...(o.outMs !== undefined ? { outMs: o.outMs } : {}),
      ...(o.fit ? { fit: o.fit } : {}),
      ...(o.transition ? { transition: o.transition } : {}),
    };
  });
  return { ...plan, overlays };
}
