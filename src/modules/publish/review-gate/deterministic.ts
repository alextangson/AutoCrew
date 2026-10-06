/**
 * 确定性检查（发布前把关 spec §5）：每次 check 都重跑，结论只由代码和盘上字节给出。
 * block 默认可被 §7 例外改判 override；文件缺失 / 读不了、计划形状不对不能例外（没法发）。
 */
import path from "node:path";
import { ratioValue } from "../../cover/platform-ratios.js";
import { validatePublishText } from "../publish-limits.js";
import type { Registration } from "../../../storage/production-types.js";
import { fileFact, type FileFact } from "./files.js";
import { resolveInProject, type PlanEntry } from "./plan.js";
import { NON_OVERRIDABLE, type CheckItem, type Override } from "./types.js";

/** 像素比例容差 1%（spec §5） */
export const RATIO_TOLERANCE = 0.01;
const KNOWN_RATIOS = ["3:4", "4:3", "16:9", "9:16", "1:1", "2.35:1"];

export type RegistrationState =
  | { kind: "ok"; registration: Registration; srt: string | null }
  | { kind: "blocked"; error: string }
  | { kind: "none"; reason: string };

export interface CoverFact { usage: string | null; declared: string | null; path: string; fact: FileFact; pixel_ratio: string | null; slot: string | null }

export interface DetInput {
  contentId: string;
  siblings: string[];
  projectRoot: string;
  entry: PlanEntry;
  videoPath: string | null;
  allowedRatios: string[];
  cropChecks: string[];
  registration: RegistrationState;
  /** 发布时：文件现算全量哈希（还在写的拒绝）；只看检查新不新鲜时走缓存 */
  fresh?: boolean;
}

export interface DetOutput { items: CheckItem[]; covers: CoverFact[]; video: FileFact | null }

export function matchRatio(width: number, height: number, candidates: string[]): string | null {
  const r = width / height;
  return candidates.find((c) => { const v = ratioValue(c); return v !== null && Math.abs(r - v) / v <= RATIO_TOLERANCE; }) ?? null;
}

const block = (check: string, rule: string, basis: string, field?: string, plan_value?: unknown): CheckItem =>
  ({ check, result: "block", rule, overridable: !NON_OVERRIDABLE.has(rule), basis, ...(field ? { field } : {}), ...(plan_value !== undefined ? { plan_value } : {}) });

async function loadFile(p: string, root: string, image: boolean, field: string, items: CheckItem[], fresh = false): Promise<FileFact | null> {
  const resolved = resolveInProject(p, root);
  // 归属可以例外，但文件在不在、读不读得了、是不是登记那一份照样要查（不能借归属例外绕过 file_missing）
  if ("error" in resolved) items.push(block("文件归属", "ownership", resolved.error, field, p));
  const abs = "error" in resolved ? path.resolve(root, p) : resolved.abs;
  const fact = await fileFact(abs, image, fresh);
  if (!fact.ok) items.push(block("文件", "file_missing", `${p}：${fact.error}`, field, p));
  return fact;
}

async function coverChecks(input: DetInput, items: CheckItem[]): Promise<CoverFact[]> {
  const { entry, allowedRatios } = input;
  const covers: CoverFact[] = [];
  for (const [i, c] of entry.covers.entries()) {
    const fact = await loadFile(c.path, input.projectRoot, true, entry.legacy_cover ? "cover_path" : `covers[${i}].path`, items, input.fresh === true);
    if (!fact) continue;
    const pixel = fact.width && fact.height ? matchRatio(fact.width, fact.height, KNOWN_RATIOS) ?? `${fact.width}x${fact.height}` : null;
    const slot = fact.width && fact.height ? matchRatio(fact.width, fact.height, allowedRatios) : null;
    covers.push({ usage: c.usage, declared: c.ratio, path: c.path, fact, pixel_ratio: pixel, slot });
    if (fact.ok && !slot) {
      const said = c.ratio && c.ratio !== pixel ? `（计划写 ${c.ratio}，像素实算是 ${pixel}）` : "";
      items.push(block("封面比例", "cover_extra_ratio", `${c.path} 像素 ${fact.width}×${fact.height} = ${pixel}${said}；本平台上传槽只收 ${allowedRatios.join(" + ")}`, `covers[${i}]`, c.path));
    }
  }
  for (const slot of allowedRatios) {
    if (covers.some((c) => c.slot === slot)) items.push({ check: "封面比例", result: "pass", basis: `${slot} 上传槽有封面（按像素实算，容差 1%）`, field: "covers" });
    else if (!covers.some((c) => !c.fact.ok)) items.push(block("封面比例", "cover_ratio", `缺 ${slot} 封面：本平台上传槽是 ${allowedRatios.join(" + ")}（以 check 为准，不看编辑器默认框）`, "covers"));
  }
  return covers;
}

function registeredChecks(input: DetInput, covers: CoverFact[], video: FileFact | null, items: CheckItem[]): void {
  const reg = input.registration;
  if (reg.kind === "none") {
    items.push({ check: "登记身份", result: "unchecked", basis: `成片 / 封面是不是登记的那一份没核对：${reg.reason}` });
    return;
  }
  if (reg.kind === "blocked") {
    items.push(block("登记成片", "cut_registered", reg.error, "video"));
    items.push(block("登记封面", "cover_registered", reg.error, "covers"));
    return;
  }
  const r = reg.registration;
  if (video?.ok) items.push(video.sha256 === r.cut_sha
    ? { check: "登记成片", result: "pass", basis: `成片字节与登记记录 ${r.id} 一致` }
    : block("登记成片", "cut_registered", `成片不是当前登记记录 ${r.id} 里的成片（字节指纹对不上）`, "video", video.abs));
  const bySlot: Record<string, string | undefined> = { "3:4": r.cover_3x4_sha, "4:3": r.cover_4x3_sha };
  for (const c of covers.filter((x) => x.fact.ok)) {
    const want = c.pixel_ratio ? bySlot[c.pixel_ratio] : undefined;
    items.push(want && c.fact.sha256 === want
      ? { check: "登记封面", result: "pass", basis: `${c.path} 是登记记录 ${r.id} 选定的 ${c.pixel_ratio} 封面`, field: "covers" }
      : block("登记封面", "cover_registered", `${c.path} 不是当前登记记录 ${r.id} 里选定的那一对（按字节指纹）`, "covers", c.path));
  }
}

function coverTextCheck(input: DetInput, items: CheckItem[]): void {
  const reg = input.registration;
  const registered = reg.kind === "ok" ? reg.registration.cover_text?.trim() : undefined;
  const planned = input.entry.cover_text?.trim();
  if (!registered) { items.push({ check: "封面字", result: "unchecked", basis: "封面字未检查：登记记录里没有封面字", field: "cover_text" }); return; }
  if (!planned) { items.push({ check: "封面字", result: "unchecked", basis: `封面字未检查：计划没写 cover_text（登记的是「${registered}」）`, field: "cover_text" }); return; }
  const norm = (s: string) => s.replace(/\s+/g, "");
  items.push(norm(planned) === norm(registered)
    ? { check: "封面字", result: "pass", basis: `与选封面时定的「${registered}」一致`, field: "cover_text" }
    : block("封面字", "cover_text", `计划的封面字「${planned}」≠ 选封面时定的「${registered}」`, "cover_text", planned));
}

const TZ_IN_STRING = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
function validZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

function scheduleCheck(entry: PlanEntry, items: CheckItem[]): void {
  if (!entry.scheduled_at) return;
  const at = entry.scheduled_at;
  if (!Number.isFinite(Date.parse(at))) { items.push(block("排期", "schedule_tz", `排期「${at}」不是能解析的时间`, "scheduled_at", at)); return; }
  const zoned = TZ_IN_STRING.test(at) || (entry.timezone !== null && validZone(entry.timezone));
  items.push(zoned
    ? { check: "排期", result: "pass", basis: `排期 ${at}${entry.timezone ? `（${entry.timezone}）` : ""} 带时区`, field: "scheduled_at" }
    : block("排期", "schedule_tz", `排期「${at}」没带时区：写 timezone（如 Asia/Shanghai）或带 +08:00`, "scheduled_at", at));
}

function ownershipCheck(input: DetInput, items: CheckItem[]): void {
  const id = input.entry.content_id;
  if (!id) { items.push({ check: "归属", result: "warn", basis: `计划条目没写 content_id，按 ${input.contentId} 核对`, field: "content_id" }); return; }
  if (id === input.contentId || input.siblings.includes(id)) return;
  items.push(block("归属", "ownership", `计划条目的 content_id ${id} 不属于这条内容（${input.contentId} 及其平台版）`, "content_id", id));
}

function textChecks(entry: PlanEntry, items: CheckItem[]): void {
  const rule = { title: "title_limit", caption: "caption_limit", tags: "tags_format" } as const;
  for (const r of validatePublishText(entry.platform, { title: entry.title, caption: entry.caption, tags: entry.tags })) {
    items.push(r.ok ? { check: "字数", result: "pass", basis: r.detail, field: r.field } : block("字数", rule[r.field], r.detail, r.field));
  }
}

export async function deterministicChecks(input: DetInput): Promise<DetOutput> {
  const items: CheckItem[] = [];
  ownershipCheck(input, items);
  const covers = await coverChecks(input, items);
  let video: FileFact | null = null;
  if (!input.videoPath) items.push(block("成片", "plan_shape", "计划没写成片路径（final_video.path 或条目 video_path）", "video"));
  else video = await loadFile(input.videoPath, input.projectRoot, false, "video", items, input.fresh === true);
  registeredChecks(input, covers, video, items);
  coverTextCheck(input, items);
  textChecks(input.entry, items);
  scheduleCheck(input.entry, items);
  for (const c of input.cropChecks) items.push({ check: "裁切核对", result: "info", basis: c, field: "covers" });
  return { items, covers, video };
}

/** §7：原话例外把对应的可例外 block 改判 override（不是 pass）；没对上任何拦截的例外单列提醒 */
/** 一句原话例外盖住整条「封面上传槽」规则：缺槽（cover_ratio）与规则外比例（cover_extra_ratio）是同一件事的两面 */
const RULE_FAMILY: Record<string, string> = { cover_ratio: "cover_slots", cover_extra_ratio: "cover_slots" };
export const sameRuleFamily = (a: string, b: string) => a === b || (RULE_FAMILY[a] !== undefined && RULE_FAMILY[a] === RULE_FAMILY[b]);

export function applyOverrides(platform: string, items: CheckItem[], overrides: Override[]): CheckItem[] {
  const mine = overrides.filter((o) => o.platform === platform);
  const used = new Set<Override>();
  const out = items.map((i) => {
    if (i.result !== "block" || !i.overridable) return i;
    const o = mine.find((x) => sameRuleFamily(x.rule, i.rule ?? ""));
    if (!o) return i;
    used.add(o);
    return { ...i, result: "override" as const, override_quote: o.founder_quote };
  });
  for (const o of mine.filter((x) => !used.has(x))) {
    const locked = items.some((i) => sameRuleFamily(o.rule, i.rule ?? "") && i.result === "block" && !i.overridable);
    out.push({ check: "例外", result: "warn", rule: o.rule, basis: locked ? `「${o.rule}」是没法发的问题（文件缺失 / 计划形状不对），不能例外` : `例外「${o.rule}」没对上本平台任何拦截`, override_quote: o.founder_quote });
  }
  return out;
}
