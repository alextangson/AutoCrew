/**
 * timeline 校验（设计 spec §2.5）。
 *
 * 输入是**系统边界**：V0a 来自 UI 手动组装，V0b 起来自 LLM——两者都可能给出结构错误、
 * 编造的模板名、指向不存在素材的 assetId。所以入参按 `unknown` 对待，逐字段手写校验
 * （本仓库内部不引 zod；受控枚举的单一事实源是 timeline-registry.json，TS 不复制一份）。
 *
 * 返回**错误清单**而不是抛错：错误串会原样回给 LLM 做自纠（≤2 轮，generate-script 同款），
 * 也会直接显示给人看。所以每一条都必须是中文人话，说清「哪儿错了、该是什么」。
 */
import registryJson from "./timeline-registry.json";
import type { VideoAssetEntry } from "./types.js";

/** registry 的形状；graphics 的 props 值是类型名字符串（"string" | "number" | "boolean"） */
export interface TimelineRegistry {
  schemaVersion: number;
  graphics: Record<string, { props: Record<string, string> }>;
  captions: string[];
  titles: string[];
  transitions: string[];
}

/** 主进程侧的 registry 单例；render workspace 以相对路径读同一个 JSON 各自校验（§2.7） */
export const TIMELINE_REGISTRY = registryJson as TimelineRegistry;

export interface TimelineValidateContext {
  registry: TimelineRegistry;
  /** 输出域总长（buildOutputMap → outputDurationMs），覆盖轨越界判定的基准 */
  outputDurationMs: number;
  assets: VideoAssetEntry[];
}

/** 素材可用的两种状态：ready（文件已就绪）/ confirmed（人工确认过） */
const USABLE_ASSET_STATUS = new Set(["ready", "confirmed"]);
const OVERLAY_TYPES = ["screen", "graphic", "ai", "image"];
const FITS = ["cover", "contain"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isPosInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function isNonNegInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function isNonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export function validateTimeline(timeline: unknown, ctx: TimelineValidateContext): string[] {
  if (!isObj(timeline)) return ["timeline 必须是一个 JSON 对象"];
  return [
    ...validateHeader(timeline),
    ...validateAnchorAndBase(timeline),
    ...validateCaptions(timeline.captions, ctx),
    ...validateTitleCard(timeline.titleCard, ctx),
    ...validateAudio(timeline.audio),
    ...validateOverlays(timeline.overlays, ctx),
  ];
}

function validateHeader(t: Record<string, unknown>): string[] {
  const errors: string[] = [];
  // v2 = 横屏换向；v1 竖屏 timeline 只读归档，不再进组装（横屏 spec §2.1）
  if (t.schemaVersion !== 2) {
    errors.push(`schemaVersion 必须是 2（画幅已换向横屏 1920×1080），当前是 ${JSON.stringify(t.schemaVersion)}`);
  }
  for (const key of ["fps", "width", "height"] as const) {
    if (!isPosInt(t[key])) errors.push(`${key} 必须是正整数，当前是 ${JSON.stringify(t[key])}`);
  }
  return errors;
}

function validateAnchorAndBase(t: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const anchor = t.anchor;
  if (!isObj(anchor)) {
    errors.push("anchor 必须是对象 { kind: \"aroll\", transcriptRevision, cutRevision }");
  } else {
    if (anchor.kind !== "aroll") errors.push(`anchor.kind 目前只支持 "aroll"，当前是 ${JSON.stringify(anchor.kind)}`);
    for (const key of ["transcriptRevision", "cutRevision"] as const) {
      if (!isPosInt(anchor[key])) errors.push(`anchor.${key} 必须是正整数（第几版），当前是 ${JSON.stringify(anchor[key])}`);
    }
  }
  const base = t.base;
  if (!isObj(base) || base.type !== "aroll") {
    errors.push("base 必须是 { type: \"aroll\" }——底轨恒为 A-roll，成片不允许有黑屏空洞");
  }
  return errors;
}

function validateCaptions(raw: unknown, ctx: TimelineValidateContext): string[] {
  if (!isObj(raw)) return ["captions 必须是对象 { style, emphasisWords? }"];
  const errors: string[] = [];
  if (!ctx.registry.captions.includes(raw.style as string)) {
    errors.push(`captions.style 不在受控枚举里：${JSON.stringify(raw.style)}（可用：${ctx.registry.captions.join("、")}）`);
  }
  if (raw.emphasisWords !== undefined) {
    const ok = Array.isArray(raw.emphasisWords) && raw.emphasisWords.every((w) => typeof w === "string");
    if (!ok) errors.push("captions.emphasisWords 必须是字符串数组");
  }
  return errors;
}

function validateTitleCard(raw: unknown, ctx: TimelineValidateContext): string[] {
  if (raw === undefined) return [];
  if (!isObj(raw)) return ["titleCard 必须是对象 { template, text, durationMs }（不要标题卡就整个省略）"];
  const errors: string[] = [];
  if (!ctx.registry.titles.includes(raw.template as string)) {
    errors.push(`titleCard.template 不在受控枚举里：${JSON.stringify(raw.template)}（可用：${ctx.registry.titles.join("、")}）`);
  }
  if (!isNonEmptyStr(raw.text)) errors.push("titleCard.text 必须是非空字符串");
  if (!isPosInt(raw.durationMs)) {
    errors.push(`titleCard.durationMs 必须是正整数毫秒，当前是 ${JSON.stringify(raw.durationMs)}`);
  } else if ((raw.durationMs as number) > ctx.outputDurationMs) {
    errors.push(
      `titleCard.durationMs（${raw.durationMs}ms）超过成片总长 ${ctx.outputDurationMs}ms——` +
        "标题卡是盖在开头的覆盖层，不前插也不改总时长",
    );
  }
  return errors;
}

function validateAudio(raw: unknown): string[] {
  if (!isObj(raw)) return ["audio 必须是对象 { anchorGainDb, bgm? }"];
  const errors: string[] = [];
  if (typeof raw.anchorGainDb !== "number" || !Number.isFinite(raw.anchorGainDb)) {
    errors.push(`audio.anchorGainDb 必须是数字（分贝），当前是 ${JSON.stringify(raw.anchorGainDb)}`);
  }
  if (raw.bgm !== undefined) {
    const bgm = raw.bgm;
    if (!isObj(bgm)) return [...errors, "audio.bgm 必须是对象 { file, gainDb, duckDb }"];
    if (!isNonEmptyStr(bgm.file)) errors.push("audio.bgm.file 必须是非空字符串");
    for (const key of ["gainDb", "duckDb"] as const) {
      if (typeof bgm[key] !== "number") errors.push(`audio.bgm.${key} 必须是数字（分贝）`);
    }
  }
  return errors;
}

function validateOverlays(raw: unknown, ctx: TimelineValidateContext): string[] {
  if (!Array.isArray(raw)) return ["overlays 必须是数组（没有覆盖轨就写空数组 []）"];
  const errors: string[] = [];
  const seenClipIds = new Set<string>();
  raw.forEach((item, i) => errors.push(...validateOverlay(item, i, ctx, seenClipIds)));
  errors.push(...checkOverlaps(raw));
  return errors;
}

function validateOverlay(
  raw: unknown,
  index: number,
  ctx: TimelineValidateContext,
  seenClipIds: Set<string>,
): string[] {
  const label = `overlays[${index}]`;
  if (!isObj(raw)) return [`${label} 必须是对象`];
  const errors: string[] = [];
  if (!isNonEmptyStr(raw.clipId)) {
    errors.push(`${label}.clipId 必须是非空字符串`);
  } else if (seenClipIds.has(raw.clipId)) {
    errors.push(`${label}.clipId 重复：${raw.clipId}（每个覆盖轨片段的 id 必须唯一）`);
  } else {
    seenClipIds.add(raw.clipId);
  }
  if (!isNonNegInt(raw.outputStartMs)) {
    errors.push(`${label}.outputStartMs 必须是 ≥0 的整数毫秒（成片时间轴），当前是 ${JSON.stringify(raw.outputStartMs)}`);
  }
  if (!isPosInt(raw.durationMs)) {
    errors.push(`${label}.durationMs 必须是正整数毫秒，当前是 ${JSON.stringify(raw.durationMs)}`);
  }
  errors.push(...checkOverlayRange(raw, label, ctx));
  if (raw.transition !== undefined && !ctx.registry.transitions.includes(raw.transition as string)) {
    errors.push(`${label}.transition 不在受控枚举里：${JSON.stringify(raw.transition)}（可用：${ctx.registry.transitions.join("、")}）`);
  }
  errors.push(...validateOverlaySource(raw.source, label, ctx));
  return errors;
}

/** 越界判定：覆盖轨活在输出时间域里，超出成片总长的片段渲染时无处安放 */
function checkOverlayRange(
  raw: Record<string, unknown>,
  label: string,
  ctx: TimelineValidateContext,
): string[] {
  if (!isNonNegInt(raw.outputStartMs) || !isPosInt(raw.durationMs)) return [];
  if (ctx.outputDurationMs <= 0) {
    return [`${label} 无处安放：成片输出域总长为 0（没有保留任何分句），请先选段再组装`];
  }
  const end = (raw.outputStartMs as number) + (raw.durationMs as number);
  if (end > ctx.outputDurationMs) {
    return [`${label} 越界：${raw.outputStartMs}ms + ${raw.durationMs}ms = ${end}ms，超过成片总长 ${ctx.outputDurationMs}ms`];
  }
  return [];
}

function validateOverlaySource(raw: unknown, label: string, ctx: TimelineValidateContext): string[] {
  if (!isObj(raw)) return [`${label}.source 必须是对象`];
  switch (raw.type) {
    case "screen":
      return [...checkAsset(raw.assetId, `${label}.source`, ctx), ...checkScreenTrim(raw, label)];
    case "ai":
    case "image":
      return checkAsset(raw.assetId, `${label}.source`, ctx);
    case "graphic":
      return validateGraphicSource(raw, label, ctx);
    default:
      return [`${label}.source.type 不认识：${JSON.stringify(raw.type)}（可用：${OVERLAY_TYPES.join("、")}）`];
  }
}

/** 屏录裁切参数：源素材内的时间窗口，与输出域无关，只保证自洽 */
function checkScreenTrim(raw: Record<string, unknown>, label: string): string[] {
  const errors: string[] = [];
  for (const key of ["inMs", "outMs"] as const) {
    if (raw[key] !== undefined && !isNonNegInt(raw[key])) {
      errors.push(`${label}.source.${key} 必须是 ≥0 的整数毫秒`);
    }
  }
  if (isNonNegInt(raw.inMs) && isNonNegInt(raw.outMs) && (raw.outMs as number) <= (raw.inMs as number)) {
    errors.push(`${label}.source.outMs（${raw.outMs}）必须大于 inMs（${raw.inMs}）`);
  }
  if (raw.fit !== undefined && !FITS.includes(raw.fit as string)) {
    errors.push(`${label}.source.fit 只能是 ${FITS.join(" / ")}，当前是 ${JSON.stringify(raw.fit)}`);
  }
  return errors;
}

function checkAsset(assetId: unknown, label: string, ctx: TimelineValidateContext): string[] {
  if (!isNonEmptyStr(assetId)) return [`${label}.assetId 必须是非空字符串`];
  const entry = ctx.assets.find((a) => a.assetId === assetId);
  if (!entry) return [`${label}.assetId 在素材清单里不存在：${assetId}`];
  if (!USABLE_ASSET_STATUS.has(entry.status)) {
    return [`${label} 引用的素材 ${assetId} 当前状态是 ${entry.status}，还不能用（需 ready 或 confirmed）`];
  }
  return [];
}

function validateGraphicSource(
  raw: Record<string, unknown>,
  label: string,
  ctx: TimelineValidateContext,
): string[] {
  const template = raw.template;
  const spec = isNonEmptyStr(template) ? ctx.registry.graphics[template] : undefined;
  if (!spec) {
    const available = Object.keys(ctx.registry.graphics).join("、") || "（registry 里暂无图形模板）";
    return [`${label}.source.template 不在受控枚举里：${JSON.stringify(template)}（可用：${available}）`];
  }
  if (!isObj(raw.props)) return [`${label}.source.props 必须是对象`];
  return checkGraphicProps(raw.props, spec.props, `${label}.source.props`);
}

function checkGraphicProps(
  props: Record<string, unknown>,
  declared: Record<string, string>,
  label: string,
): string[] {
  const errors: string[] = [];
  for (const [name, type] of Object.entries(declared)) {
    const value = props[name];
    if (value === undefined) {
      errors.push(`${label} 缺少必填字段 ${name}（应为 ${type}）`);
      continue;
    }
    if (typeof value !== type) {
      errors.push(`${label}.${name} 类型应为 ${type}，当前是 ${typeof value}`);
    }
  }
  for (const name of Object.keys(props)) {
    if (!(name in declared)) {
      errors.push(`${label} 有未登记的字段 ${name}（该模板只接受：${Object.keys(declared).join("、")}）`);
    }
  }
  return errors;
}

/** 覆盖轨两两不重叠：同一时刻只允许一层覆盖，z-order 才是确定的 */
function checkOverlaps(raw: unknown[]): string[] {
  const spans = raw
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isObj(item) && isNonNegInt(item.outputStartMs) && isPosInt(item.durationMs))
    .map(({ item, index }) => {
      const o = item as Record<string, number>;
      return { index, start: o.outputStartMs, end: o.outputStartMs + o.durationMs };
    })
    .sort((a, b) => a.start - b.start || a.index - b.index);
  const errors: string[] = [];
  // 比的是「目前伸得最远的那条」，不是前一条——否则被长片段完全包住的短片段会漏判
  let cover = spans[0];
  for (let i = 1; i < spans.length; i++) {
    const cur = spans[i];
    if (cur.start < cover.end) {
      errors.push(
        `overlays[${cover.index}]（${cover.start}-${cover.end}ms）与 overlays[${cur.index}]（${cur.start}-${cur.end}ms）时间重叠，覆盖轨不允许叠放`,
      );
    }
    if (cur.end > cover.end) cover = cur;
  }
  return errors;
}
