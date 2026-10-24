/**
 * 派生公众号文章的发布状态（Phase 2b）：落在内容项目里的 `article-publish.json`，和发布包分开存——
 * 包是「批了什么」，这里是「推了什么、编辑器里走到哪、创始人扫没扫码」。
 *
 * 状态机：
 *   (未推) → pushed_draft → editor_finishing → scheduled_waiting_scan → scheduled / published
 *                       ↘ waiting_video_live（视频号原片还没公开，不定时，等它公开再进编辑器）
 *   推送失败 → failed（可重推）；任何一步结果不明 → unknown（下一步只能先去编辑器核对再记，不重试）
 * 草稿永不删除：包变了重推时旧草稿记进 superseded，删不删是创始人在后台自己做。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";

export const PUBLISH_PHASES = ["pushed_draft", "editor_finishing", "waiting_video_live", "scheduled_waiting_scan", "scheduled", "published", "failed", "unknown"] as const;
export type PublishPhase = (typeof PUBLISH_PHASES)[number];

export interface PublishAttempt { at: string; action: string; ok: boolean; raw?: string; mediaId?: string }
export interface SupersededDraft { mediaId: string; packageHash: string; account: string; pushedAt: string; supersededAt: string }
export interface PlannedSlot { at: string; basis: string; founderWords?: string }
export interface ScheduleReceipt { scheduledAt: string; founderWords: string; published: boolean; at: string }

export interface ArticlePublishState {
  phase?: PublishPhase;
  /** 推到哪个公众号（AppID；不是密钥） */
  account?: string;
  mediaId?: string;
  packageHash?: string;
  pushedAt?: string;
  slot?: PlannedSlot;
  receipt?: ScheduleReceipt;
  /** phase = unknown 时：从哪一步进的、原始说法 */
  unknownFrom?: PublishPhase;
  unknownRaw?: string;
  superseded: SupersededDraft[];
  attempts: PublishAttempt[];
}

const EMPTY: ArticlePublishState = { superseded: [], attempts: [] };

function file(contentId: string, dataDir?: string): string {
  return projectFile(contentRoot(contentId, dataDir), "article-publish.json");
}

export async function readPublishState(contentId: string, dataDir?: string): Promise<ArticlePublishState> {
  try {
    const raw = JSON.parse(await fs.readFile(file(contentId, dataDir), "utf-8")) as Partial<ArticlePublishState>;
    return { ...EMPTY, ...raw, superseded: raw.superseded ?? [], attempts: raw.attempts ?? [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, superseded: [], attempts: [] };
    throw new Error(`公众号发布状态读不出来（${(e as Error).message}）`);
  }
}

export async function writePublishState(contentId: string, s: ArticlePublishState, dataDir?: string): Promise<ArticlePublishState> {
  const target = file(contentId, dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeJsonAtomic(target, s);
  return s;
}

export function withAttempt(s: ArticlePublishState, a: Omit<PublishAttempt, "at">, now = new Date()): ArticlePublishState {
  return { ...s, attempts: [...s.attempts, { at: now.toISOString(), ...a }] };
}

/** 已经交到平台手里（定时 / 等扫码 / 已发）：包变了也不能直接重推，先请创始人在后台取消，再记 record_absent */
export const COMMITTED: ReadonlySet<PublishPhase> = new Set(["scheduled_waiting_scan", "scheduled", "published"]);

/** 每个状态下一步该做什么（status 与各动作回执共用） */
export function nextStep(s: ArticlePublishState): string {
  switch (s.phase) {
    case undefined: return "push_draft：把批过的图文包推进草稿箱";
    case "failed": return "照原始报错修好（凭证 / IP 白名单 / 额度），再 push_draft；不改用复制粘贴";
    case "pushed_draft": return "begin_editor：核视频号原片是否已公开，排定时，再按 publish-content 的公众号手册进编辑器";
    case "waiting_video_live": return "视频号原片还没公开：等它公开后再 begin_editor；不排定时";
    case "editor_finishing": return `编辑器里：设创作来源、插视频号卡片、定时 ${s.slot?.at ?? "?"}、点发表停在管理员二维码，然后 mark_editor_done 并交给创始人扫码`;
    case "scheduled_waiting_scan": return "等创始人扫码；他说扫了之后去 发表记录 / 定时列表 核到这篇，再 record_scheduled（带他的原话）";
    case "scheduled": return `已定时 ${s.receipt?.scheduledAt ?? ""}：到点后核是否已发表`;
    case "published": return "已发表";
    case "unknown": return "结果不明：先去编辑器的 草稿箱 / 发表记录 / 定时列表 核对，看到了就 record_scheduled，没有就 record_absent；核对之前不重试任何一步";
  }
}
