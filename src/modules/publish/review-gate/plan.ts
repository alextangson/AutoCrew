/**
 * 发布计划读取与形状校验（发布前把关 spec §4、§5、E12）。
 *
 * 计划是 agent 写的（`06-publish/publish-plan.json` 或直接传 JSON）——系统边界，逐字段校验：
 * 形状不对就 block 并指出平台与字段，不猜。每平台 `covers: [{usage, ratio, path}]`；旧 `cover_path` 视作单张按像素判。
 * 宿主可能把对象 / 数组传成 JSON 字符串（AGENTS.md 不变量），这里先解析再判。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { safeProjectPath, isMissing } from "../../../storage/content-project.js";
import { normalizePlatform, type GatePlatform } from "./platforms.js";

export interface CoverRef { usage: string | null; ratio: string | null; path: string }

export interface PlanEntry {
  platform: GatePlatform;
  content_id: string | null;
  account: string | null;
  title: string;
  caption: string;
  tags: string[];
  covers: CoverRef[];
  /** true = 旧字段 cover_path 转来的单张 */
  legacy_cover: boolean;
  cover_text: string | null;
  video_path: string | null;
  scheduled_at: string | null;
  timezone: string | null;
  campaigns: unknown[];
}

export interface ShapeProblem { platform: string | null; field: string; detail: string }

export interface ParsedPlan { entries: PlanEntry[]; problems: ShapeProblem[]; final_video_path: string | null }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 资料库共享项目里不存在的稿件 id 读的时候抛 project_binding_missing：当成「不存在」；别的读盘错误照常抛 */
export function missingAsNull(e: unknown): null {
  if (e instanceof Error && e.message.startsWith("project_binding_missing")) return null;
  throw e;
}

/** 字符串里的 JSON（宿主把数组 / 对象序列化了）→ 值；不是 JSON 原样返回 */
export function maybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try { return JSON.parse(t); } catch { return v; }
}

export type PlanLoad = { ok: true; plan: Obj; source: string } | { ok: false; code: string; error: string };

/** plan 参数：对象、JSON 字符串，或项目内路径（相对项目根，或项目内的绝对路径） */
export async function loadPlan(raw: unknown, projectRoot: string): Promise<PlanLoad> {
  const v = maybeJson(raw);
  if (isObj(v)) return { ok: true, plan: v, source: "inline" };
  if (typeof v !== "string" || !v.trim()) return { ok: false, code: "plan_required", error: "plan 必填：发布计划 JSON，或项目内的计划文件路径（如 06-publish/publish-plan.json）" };
  if (v.trim().startsWith("{")) return { ok: false, code: "plan_unreadable", error: "plan 看着是 JSON 但解析不了：检查引号与逗号" };
  const resolved = resolveInProject(v.trim(), projectRoot);
  if ("error" in resolved) return { ok: false, code: "plan_outside_project", error: resolved.error };
  try {
    const parsed = JSON.parse(await fs.readFile(resolved.abs, "utf8")) as unknown;
    if (!isObj(parsed)) return { ok: false, code: "plan_unreadable", error: `计划文件不是 JSON 对象：${v}` };
    return { ok: true, plan: parsed, source: path.relative(projectRoot, resolved.abs) };
  } catch (e) {
    return { ok: false, code: "plan_unreadable", error: isMissing(e) ? `计划文件不存在：${v}` : `计划文件读不了：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 项目内路径 → 绝对路径；越出项目（含 ..）报错。存在与否由调用方判 */
export function resolveInProject(p: string, projectRoot: string): { abs: string } | { error: string } {
  const root = path.resolve(projectRoot);
  if (path.isAbsolute(p)) {
    const abs = path.resolve(p);
    return abs === root || abs.startsWith(root + path.sep) ? { abs } : { error: `路径不在本项目里：${p}` };
  }
  try { return { abs: safeProjectPath(root, p) }; } catch (e) { return { error: `路径不在本项目里：${p}（${e instanceof Error ? e.message : String(e)}）` }; }
}

function readCovers(entry: Obj, label: string, problems: ShapeProblem[]): { covers: CoverRef[]; legacy: boolean } {
  const raw = maybeJson(entry.covers);
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) { problems.push({ platform: label, field: "covers", detail: "covers 要是数组 [{usage, ratio, path}]" }); return { covers: [], legacy: false }; }
    const covers: CoverRef[] = [];
    raw.forEach((c, i) => {
      if (!isObj(c) || !str(c.path)) { problems.push({ platform: label, field: `covers[${i}].path`, detail: "每张封面要有 path" }); return; }
      covers.push({ usage: str(c.usage), ratio: str(c.ratio), path: str(c.path)! });
    });
    return { covers, legacy: false };
  }
  const legacy = str(entry.cover_path);
  return legacy ? { covers: [{ usage: null, ratio: null, path: legacy }], legacy: true } : { covers: [], legacy: false };
}

function readTags(entry: Obj, label: string, problems: ShapeProblem[]): string[] {
  const raw = maybeJson(entry.tags ?? entry.hashtags);
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) { problems.push({ platform: label, field: "tags", detail: "tags 要是字符串数组" }); return []; }
  return (raw as string[]).map((t) => t.trim()).filter(Boolean);
}

function textField(entry: Obj, key: string, label: string, problems: ShapeProblem[]): string {
  const v = entry[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") { problems.push({ platform: label, field: key, detail: `${key} 要是字符串` }); return ""; }
  return v;
}

function readEntry(e: unknown, i: number, problems: ShapeProblem[]): PlanEntry | null {
  if (!isObj(e)) { problems.push({ platform: null, field: `platforms[${i}]`, detail: "平台条目要是对象" }); return null; }
  const platform = normalizePlatform(e.platform);
  if (!platform) { problems.push({ platform: str(e.platform), field: `platforms[${i}].platform`, detail: `认不出平台：${String(e.platform ?? "空")}（抖音 / 小红书 / 视频号 / B站）` }); return null; }
  const { covers, legacy } = readCovers(e, platform, problems);
  const scheduled = e.scheduled_at;
  if (scheduled !== undefined && scheduled !== null && typeof scheduled !== "string") problems.push({ platform, field: "scheduled_at", detail: "scheduled_at 要是时间字符串" });
  const video = isObj(e.final_video) ? str(e.final_video.path) : str(e.video_path);
  return {
    platform, content_id: str(e.content_id), account: str(e.account_display_name) ?? str(e.account) ?? str(e.account_public_profile),
    title: textField(e, "title", platform, problems), caption: textField(e, "caption", platform, problems), tags: readTags(e, platform, problems),
    covers, legacy_cover: legacy, cover_text: str(e.cover_text), video_path: video,
    scheduled_at: str(scheduled), timezone: str(e.timezone), campaigns: Array.isArray(e.campaigns) ? e.campaigns : [],
  };
}

export function parsePlan(plan: Obj): ParsedPlan {
  const problems: ShapeProblem[] = [];
  const list = maybeJson(plan.platforms);
  const finalVideo = isObj(plan.final_video) ? str(plan.final_video.path) : null;
  if (!Array.isArray(list) || list.length === 0) {
    problems.push({ platform: null, field: "platforms", detail: "计划里没有平台：platforms 要是非空数组" });
    return { entries: [], problems, final_video_path: finalVideo };
  }
  const entries: PlanEntry[] = [];
  list.forEach((e, i) => {
    const entry = readEntry(e, i, problems);
    if (!entry) return;
    if (entries.some((x) => x.platform === entry.platform)) { problems.push({ platform: entry.platform, field: `platforms[${i}]`, detail: "同一平台出现了两次：一个平台只能有一个条目" }); return; }
    entries.push(entry);
  });
  return { entries, problems, final_video_path: finalVideo };
}
