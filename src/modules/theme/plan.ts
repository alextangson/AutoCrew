/**
 * 每个主题一份去向计划（首页与管线重规划 §8-4）：要发哪些去向、哪些不出，谁定的、原话。
 *
 * 放在哪：源视频稿的内容项目里，和 production.json 同一个目录（`00-project/autocrew/destination-plan.json`）。
 * 主题本身是只读投影（父 = 源视频稿），计划跟着父稿走，删父稿 / 搬资料库都一起走。
 *
 * 默认值的规则：
 * - 没有计划文件 = 「按当前勾选」的默认计划（读时算，不落盘：看板读方零写入）。
 * - 勾选（profile.platforms）一改，改之前先把所有还没落盘的主题按**改之前**的勾选落盘（`freezePlansBeforeProfileChange`）。
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
  version: 1;
  /** 这份计划落盘时依据的勾选（审计用） */
  basis: string[];
  created_at: string;
  destinations: Partial<Record<Destination, PlanEntry>>;
  reshoots: ReshootRecord[];
}

export interface PlanView { plan: DestinationPlan; persisted: boolean }

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
  return { version: 1, basis: on, created_at: at, destinations, reshoots: [] };
}

export async function readPlanFile(id: string, dataDir: string): Promise<DestinationPlan | null> {
  try {
    const raw = JSON.parse(await fs.readFile(planPath(id, dataDir), "utf-8")) as Partial<DestinationPlan>;
    return { version: 1, basis: raw.basis ?? [], created_at: raw.created_at ?? "", destinations: raw.destinations ?? {}, reshoots: raw.reshoots ?? [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`去向计划读不出来（${(e as Error).message}）`);
  }
}

/** 读计划：没落盘就按当前勾选给默认（不写） */
export async function readPlan(id: string, dataDir: string, profile: { platforms?: unknown } | null): Promise<PlanView> {
  const file = await readPlanFile(id, dataDir);
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

/** 读-改-写：没落盘的先按当前勾选落成默认，再交给 fn 改 */
export async function mutatePlan<T>(id: string, dataDir: string, profile: { platforms?: unknown } | null, fn: (plan: DestinationPlan) => T): Promise<{ plan: DestinationPlan; value: T }> {
  return withPlanLock(id, dataDir, async () => {
    const plan = (await readPlanFile(id, dataDir)) ?? defaultPlan(profile);
    const value = fn(plan);
    await writePlan(id, dataDir, plan);
    return { plan, value };
  });
}

/**
 * 勾选要变之前调用：把所有还没落盘的主题按**改之前**的勾选落盘，之后改勾选就不会改到它们。
 * 返回落盘了几条。读不了某条的计划就抛出（改勾选随之失败，看得见），不跳过。
 */
export async function freezePlansBeforeProfileChange(dataDir: string, before: { platforms?: unknown } | null, contents: Content[]): Promise<number> {
  let n = 0;
  for (const c of contents.filter(isThemeRoot)) {
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
