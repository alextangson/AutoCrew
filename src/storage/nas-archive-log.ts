/** NAS 归档台账（工作区 archive-log.json）和「我的内容/归档记录.md」的渲染。 */
import fs from "node:fs/promises";
import path from "node:path";
import { isMissing } from "./content-project.js";
import { writeJsonAtomic } from "./json-atomic.js";

export const ARCHIVE_LOG = "archive-log.json";
export interface ArchiveLogEntry { contentId: string; title: string; target: string; freedBytes: number; archivedAt: string }

export async function readArchiveLog(dataDir: string): Promise<ArchiveLogEntry[]> {
  try { return (JSON.parse(await fs.readFile(path.join(dataDir, ARCHIVE_LOG), "utf8")) as { entries: ArchiveLogEntry[] }).entries ?? []; }
  catch (e) { if (isMissing(e)) return []; throw e; }
}

/** 同一条稿件只留一行：续跑补删的空间累加到原来那行，时间取最新 */
export async function appendArchiveLog(dataDir: string, entry: ArchiveLogEntry): Promise<void> {
  const entries = await readArchiveLog(dataDir);
  const prev = entries.find((e) => e.contentId === entry.contentId);
  const merged = prev ? { ...entry, freedBytes: prev.freedBytes + entry.freedBytes } : entry;
  const next = [merged, ...entries.filter((e) => e.contentId !== entry.contentId)]
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  await writeJsonAtomic(path.join(dataDir, ARCHIVE_LOG), { version: 1, entries: next });
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
function day(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function renderArchiveLog(entries: ArchiveLogEntry[]): string {
  const rows = entries.map((e) => `| ${day(e.archivedAt)} | ${e.title.replace(/\|/g, "／")} | ${e.target} | ${formatBytes(e.freedBytes)} |`);
  return `# 归档记录

发布满 7 天、又不在「已发布」最近 5 条里的稿件，AutoCrew 每天把整个项目复制到 NAS、逐个文件核对无误后，才删掉本机的原片、素材、剪辑工程、封面和成片（口播稿、发布记录留在本机）。最新的在最上面。

| 归档日期 | 标题 | NAS 位置 | 腾出空间 |
|---|---|---|---|
${rows.join("\n")}
`;
}
