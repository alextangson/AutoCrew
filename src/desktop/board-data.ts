/**
 * 看板数据（看板规格 A/D/E）：一次读出看板要的全部事实。
 * 列归属沿用「我的内容」同一张表（my-content-plan.columnOf），不另立一套口径；
 * 发布状态读 Codex 写的 publish-plan.json，任一平台已提交就把稿件同步成 published（§18）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { listContents, listTopics, transitionStatus, type Content, type Topic } from "../storage/local-store.js";
import { columnOf, scriptText, type Column } from "../storage/my-content-plan.js";
import { isMissing, resolveContentProject } from "../storage/content-project.js";
import { anySubmitted, firstPublishTime, readPublishRecord, recordTime, type PublishRecord } from "../storage/publish-record.js";

export type BoardColumn = "选题" | Exclude<Column, "复盘">;

export interface BoardCover { path: string; sha256: string }

export interface BoardItem {
  id: string;
  title: string;
  platform: string | null;
  status: string;
  topicId: string | null;
  column: Exclude<BoardColumn, "选题">;
  createdAt: string;
  updatedAt: string;
  draftReadyAt: string | null;
  /** 正文字数（去掉空白），配合 wordsPerMinute 估时长（§29） */
  chars: number;
  finalDurationMs: number | null;
  cover: BoardCover | null;
  /** 只有待发布 / 已发布的稿件才读发布记录 */
  publish: PublishRecord | null;
  /** 排序用的发布时间（§19） */
  publishTime: string | null;
  lastError: string | null;
  blockedReason: string | null;
}

export interface BoardTopic {
  id: string;
  title: string;
  source: string | null;
  link: string | null;
  score: number | null;
  createdAt: string;
  renewedAt: string | null;
}

export interface BoardData {
  items: BoardItem[];
  topics: BoardTopic[];
  /** 上一条已登记成片的「字数 ÷ 分钟」；没有登记过成片 = null（不显示估时，§29） */
  wordsPerMinute: number | null;
}

/** 数字数：去掉空白与 markdown 标题记号，中文按字、英文按字母 */
export function countChars(text: string): number {
  return text.replace(/^#.*$/m, "").replace(/\s+/g, "").length;
}

const PUBLISH_STATUSES = new Set(["publish_ready", "publishing", "published"]);
const SYNC_FROM = new Set(["publish_ready", "publishing"]);

const shaCache = new Map<string, { mtimeMs: number; size: number; sha: string }>();
async function cachedSha(file: string): Promise<string> {
  const st = await fs.stat(file);
  const hit = shaCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.sha;
  const sha = createHash("sha256").update(await fs.readFile(file)).digest("hex");
  shaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, sha });
  return sha;
}

/** 已选那版的 3:4（选用 / 登记时拷成 05-cover/封面-3x4.*）；没选就不放图（§30） */
export async function coverOf(contentId: string, dataDir: string): Promise<BoardCover | null> {
  const binding = resolveContentProject(contentId, dataDir);
  if (!binding) return null;
  let names: string[];
  try { names = await fs.readdir(path.join(binding.project_root, "05-cover")); } catch (e) { if (isMissing(e)) return null; throw e; }
  const name = names.find((n) => /^封面-3x4\.(png|jpe?g)$/i.test(n));
  if (!name) return null;
  const rel = `05-cover/${name}`;
  return { path: rel, sha256: await cachedSha(path.join(binding.project_root, rel)) };
}

/** 最近一条已登记成片的语速：定稿字数 ÷ 成片分钟数 */
export async function wordsPerMinute(contents: Content[], dataDir: string): Promise<number | null> {
  const last = contents.filter((c) => c.video?.final && c.video.final.duration_ms > 0)
    .sort((a, b) => (b.video!.final!.at).localeCompare(a.video!.final!.at))[0];
  if (!last) return null;
  const binding = resolveContentProject(last.id, dataDir);
  const script = binding ? await scriptText(last, binding.project_root).catch(() => null) : null;
  const chars = countChars(script ?? last.body);
  if (!chars) return null;
  return chars / (last.video!.final!.duration_ms / 60_000);
}

/** 任一平台已提交 → 稿件同步为已发布（§18）；只从待发布同步，状态以盘上为准 */
async function syncPublished(c: Content, record: PublishRecord, dataDir: string): Promise<Content> {
  if (!SYNC_FROM.has(c.status) || !anySubmitted(record)) return c;
  // 发布时间以平台上的实际/定时时间为准，不是看板刷到它的时刻——NAS 归档和数据关联都按它算
  const at = firstPublishTime(record);
  const r = await transitionStatus(c.id, "published", { force: true, expectedStatus: c.status, ...(at ? { patch: { publishedAt: at } } : {}) }, dataDir);
  return r.ok && r.content ? r.content : c;
}

async function itemOf(c: Content, column: Exclude<BoardColumn, "选题">, dataDir: string): Promise<BoardItem> {
  let current = c, publish: PublishRecord | null = null;
  if (PUBLISH_STATUSES.has(c.status)) {
    publish = await readPublishRecord(c.id, c.manualPublications, dataDir);
    current = await syncPublished(c, publish, dataDir);
  }
  const col = (columnOf(current) ?? column) as Exclude<BoardColumn, "选题">;
  return {
    id: current.id, title: current.title, platform: current.platform ?? null, status: current.status,
    topicId: current.topicId ?? null, column: col, createdAt: current.createdAt, updatedAt: current.updatedAt,
    draftReadyAt: current.draftReadyAt ?? null, chars: countChars(current.body ?? ""),
    finalDurationMs: current.video?.final?.duration_ms ?? null,
    cover: col === "待发布" || col === "已发布" ? await coverOf(current.id, dataDir).catch(() => null) : null,
    publish, publishTime: publish ? recordTime(publish) ?? current.publishedAt : current.publishedAt,
    lastError: current.lastError ?? null, blockedReason: current.blockedReason ?? null,
  };
}

function topicOf(t: Topic): BoardTopic {
  return { id: t.id, title: t.title, source: t.source ?? null, link: t.link ?? null, score: typeof t.score === "number" ? t.score : null, createdAt: t.createdAt, renewedAt: t.renewedAt ?? null };
}

export async function boardData(dataDir: string): Promise<BoardData> {
  const [contents, topics] = await Promise.all([listContents(dataDir), listTopics(dataDir)]);
  const items: BoardItem[] = [];
  for (const c of contents) {
    const column = columnOf(c);
    // 归档 / 未知状态不进任何列（§6）
    if (!column || column === "复盘") continue;
    items.push(await itemOf(c, column, dataDir));
  }
  const started = new Set(contents.filter((c) => c.topicId).map((c) => c.topicId!));
  return {
    items,
    topics: topics.filter((t) => !started.has(t.id)).map(topicOf),
    wordsPerMinute: await wordsPerMinute(contents, dataDir),
  };
}
