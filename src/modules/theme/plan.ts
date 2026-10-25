/**
 * 每个主题一份去向计划（首页与管线重规划 §8-4）：要发哪些去向、哪些不出，谁定的、原话。
 *
 * 放在哪：源视频稿的内容项目里，和 production.json 同一个目录（`00-project/autocrew/destination-plan.json`）。
 * 主题本身是只读投影（父 = 源视频稿），计划跟着父稿走，删父稿 / 搬资料库都一起走。
 *
 * 默认值的规则（计划 v2）：
 * - 老主题（父稿建于 `PROFILE_DEFAULT_SINCE` 之前）：默认 = 「它实际有的」——父视频自己发布计划 / 回执槽里的中文平台，
 *   加上真有派生稿的去向（公众号文章、英文版的 YouTube / X）。不按勾选补它们从来没有过的去向；读时现算，从不落盘。
 *   文件里 by=profile 的条目对老主题一律不认（v1 冻结钩子曾按勾选给老主题写过全套默认，就这样纠正，不改资料库）。
 * - 新主题：没有计划文件 = 「按当前勾选」的默认计划（读时算，不落盘：看板读方零写入）。
 * - 勾选（profile.platforms）一改，改之前先把所有还没落盘的新主题按**改之前**的勾选落盘（`freezePlansBeforeProfileChange`）。
 *   所以：新主题 = 建立时的勾选；已有主题第一次遇到勾选变化时一次性落成当时的勾选；之后再改勾选不回头改老计划。
 * - 标「不出」/ 恢复要发、重拍：先把默认计划落盘再改，改动都带谁定的和原话。
 * - 已发的历史不靠计划：取消勾选 / 标不出之后，已发的回执照样显示（`history`）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentFile } from "../../storage/content-project.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import type { Content } from "../../storage/local-store.js";
import { isImportedHistory } from "../../storage/imported-history.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { enabledPlatforms } from "../profile/platform-lines.js";
import { DESTINATIONS, isDestination, type Destination } from "./destinations.js";

export interface PlanEntry {
  required: boolean;
  /** profile = 按勾选给的默认；founder = 创始人定的 */
  by: "profile" | "founder";
  /** board = 看板上点的；chat = 对话里转述的原话（带宿主） */
  via?: "board" | "chat";
  host?: string;
  founder_words?: string;
  at: string;
}

export interface ReshootRecord {
  /** 结束的那一轮 / 新开的一轮 */
  round_ended: number;
  round: number;
  at: string;
  founder_words: string;
  via: "board" | "chat";
  host?: string;
  /** 重拍那一刻已经发了的（保留，不撤） */
  published: Array<{ platform: string; content_id: string | null }>;
  /** 已定时还没公开的：要创始人自己去撤（从不自动撤） */
  to_cancel: Array<{ platform: string; content_id: string | null; at?: string }>;
}

export interface DestinationPlan {
  /** 1 = 早期写的（老主题上的 profile 条目不可信）；2 = 现在的写法 */
  version: 1 | 2;
  /** 这份计划落盘时依据的勾选（审计用） */
  basis: string[];
  created_at: string;
  destinations: Partial<Record<Destination, PlanEntry>>;
  reshoots: ReshootRecord[];
}

/** legacy = 老主题：默认按「它实际有的」由分组那层现算，plan 里只认创始人定的条目 */
export interface PlanView { plan: DestinationPlan; persisted: boolean; legacy?: boolean }

/**
 * 这一天之后建的主题才按勾选给全套默认（含公众号 / YouTube / X）；之前建的按「它实际有的」。
 * 修复上线日（2026-10-26 北京时间零点）——之前建的主题，派生去向勾上时它们多半已经过了待发布。
 */
export const PROFILE_DEFAULT_SINCE = "2026-10-25T16:00:00.000Z";
export const isLegacyTheme = (c: Pick<Content, "createdAt">): boolean => !(Date.parse(c.createdAt) >= Date.parse(PROFILE_DEFAULT_SINCE));

export const PLAN_FILE = "destination-plan.json";
const planPath = (id: string, dataDir: string) => contentFile(id, dataDir, PLAN_FILE);

/** 能挂去向计划的主题父稿：中文视频稿、不是派生、不是导入的历史作品 */
export function isThemeRoot(c: Pick<Content, "platform" | "derivedFrom" | "source" | "deletedAt">): boolean {
  return isVideoPlatform(c.platform) && !c.derivedFrom && !c.deletedAt && !isImportedHistory(c) && !["youtube", "x"].includes(c.platform ?? "");
}

export function defaultPlan(profile: { platforms?: unknown } | null, at = new Date().toISOString()): DestinationPlan {
  const on = enabledPlatforms(profile).filter(isDestination);
  const destinations: DestinationPlan["destinations"] = {};
  for (const p of DESTINATIONS) if (on.includes(p)) destinations[p] = { required: true, by: "profile", at };
  return { version: 2, basis: on, created_at: at, destinations, reshoots: [] };
}

/** 老主题落盘时的起点：没有按勾选的条目（默认由分组层按「实际有的」现算） */
export function legacyBase(at = new Date().toISOString()): DestinationPlan {
  return { version: 2, basis: [], created_at: at, destinations: {}, reshoots: [] };
}

/** 老主题只认创始人定的条目 */
export function founderOnly(plan: DestinationPlan): DestinationPlan {
  const destinations: DestinationPlan["destinations"] = {};
  for (const [p, e] of Object.entries(plan.destinations)) if (e?.by === "founder") destinations[p as Destination] = e;
  return { ...plan, destinations };
}

export async function readPlanFile(id: string, dataDir: string): Promise<DestinationPlan | null> {
  try {
    const raw = JSON.parse(await fs.readFile(planPath(id, dataDir), "utf-8")) as Partial<DestinationPlan>;
    return { version: raw.version === 2 ? 2 : 1, basis: raw.basis ?? [], created_at: raw.created_at ?? "", destinations: raw.destinations ?? {}, reshoots: raw.reshoots ?? [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`去向计划读不出来（${(e as Error).message}）`);
  }
}

/** 读计划（不写）：老主题只给创始人条目（legacy）；新主题没落盘就按当前勾选给默认 */
export async function readPlan(c: Pick<Content, "id" | "createdAt">, dataDir: string, profile: { platforms?: unknown } | null): Promise<PlanView> {
  const file = await readPlanFile(c.id, dataDir);
  if (isLegacyTheme(c)) return { plan: file ? founderOnly(file) : legacyBase(), persisted: Boolean(file), legacy: true };
  return file ? { plan: file, persisted: true } : { plan: defaultPlan(profile), persisted: false };
}

async function writePlan(id: string, dataDir: string, plan: DestinationPlan): Promise<void> {
  const target = planPath(id, dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeJsonAtomic(target, plan);
}

/** 同一条稿的计划改动排队（看板双击、对话和看板同时点） */
const queues = new Map<string, Promise<unknown>>();
export function withPlanLock<T>(id: string, dataDir: string, fn: () => Promise<T>): Promise<T> {
  const key = `${path.resolve(dataDir)}\0${id}`;
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(key, next.catch(() => undefined));
  return next;
}

/** 读-改-写：新主题没落盘的先按当前勾选落成默认、老主题只带创始人条目，再交给 fn 改；写出去一律是 v2 */
export async function mutatePlan<T>(c: Pick<Content, "id" | "createdAt">, dataDir: string, profile: { platforms?: unknown } | null, fn: (plan: DestinationPlan) => T): Promise<{ plan: DestinationPlan; value: T }> {
  const id = c.id;
  return withPlanLock(id, dataDir, async () => {
    const file = await readPlanFile(id, dataDir);
    const legacy = isLegacyTheme(c);
    const plan = legacy ? (file ? founderOnly(file) : legacyBase()) : (file ?? defaultPlan(profile));
    plan.version = 2;
    const value = fn(plan);
    await writePlan(id, dataDir, plan);
    return { plan, value };
  });
}

/**
 * 勾选要变之前调用：把所有还没落盘的新主题按**改之前**的勾选落盘，之后改勾选就不会改到它们。
 * 老主题的默认不跟勾选走（按「实际有的」），不用冻。
 * 返回落盘了几条。读不了某条的计划就抛出（改勾选随之失败，看得见），不跳过。
 */
export async function freezePlansBeforeProfileChange(dataDir: string, before: { platforms?: unknown } | null, contents: Content[]): Promise<number> {
  let n = 0;
  for (const c of contents.filter((x) => isThemeRoot(x) && !isLegacyTheme(x))) {
    await withPlanLock(c.id, dataDir, async () => {
      if (await readPlanFile(c.id, dataDir)) return;
      await writePlan(c.id, dataDir, defaultPlan(before));
      n++;
    });
  }
  return n;
}

/** 两份勾选里能当去向的部分一样不一样（不相关的平台变了不冻结） */
export function destinationsChanged(before: { platforms?: unknown } | null, after: { platforms?: unknown } | null): boolean {
  const pick = (p: { platforms?: unknown } | null) => enabledPlatforms(p).filter(isDestination).sort().join(",");
  return pick(before) !== pick(after);
}
