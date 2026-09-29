/**
 * 发布即备份的记录与状态（docs/specs/2026-09-29-nas-backup-on-publish.md）。
 * - 备份记录：项目 00-project/notes/backup-<时间>.json（文件清单 + sha256 + 目标），只在内容有变化时新写一份；
 *   不是归档记录，删除逻辑不认它。
 * - 备份状态：00-project/notes/backup-state.json（成功/未挂载/失败次数），「我的内容/5 已发布」据此渲染 NAS备份状态.txt。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isMissing } from "./content-project.js";
import { writeJsonAtomic } from "./json-atomic.js";
import type { ArchivedFile } from "./nas-archive-copy.js";
import { formatBytes } from "./nas-archive-log.js";

const NOTES = "00-project/notes";
export const BACKUP_STATE = `${NOTES}/backup-state.json`;
/** 连续失败到这个次数，状态文件写明原因、⚠️ 同步出错.txt 也报出来 */
export const BACKUP_FAIL_LIMIT = 3;

export interface BackupRecord { version: 1; backedUpAt: string; target: string; files: ArchivedFile[] }
export interface BackupState {
  status: "backed_up" | "unmounted" | "failed";
  lastAttempt: string;
  /** 连续失败次数（成功清零；未挂载不计） */
  failures: number;
  target: string;
  reason?: string;
  backedUpAt?: string;
  fileCount?: number;
  totalBytes?: number;
}

/** 备份自己的记录和状态文件不参与备份比对，否则每轮都算「有变化」 */
export const isBackupBookkeeping = (rel: string) => rel.startsWith(`${NOTES}/backup-`);

export async function latestBackupRecord(projectRoot: string): Promise<BackupRecord | null> {
  let names: string[] = [];
  try { names = await fs.readdir(path.join(projectRoot, NOTES)); } catch (e) { if (isMissing(e)) return null; throw e; }
  const latest = names.filter((n) => /^backup-\d.+\.json$/.test(n)).sort().pop();
  if (!latest) return null;
  return JSON.parse(await fs.readFile(path.join(projectRoot, NOTES, latest), "utf8")) as BackupRecord;
}

/** 上次备份到同一个 target 的文件清单；目标换了（或没有记录）就是空的，全部重新核对 */
export async function latestBackupFiles(projectRoot: string, target: string): Promise<Map<string, ArchivedFile>> {
  const record = await latestBackupRecord(projectRoot);
  return new Map(record?.target === target ? record.files.map((f) => [f.rel, f]) : []);
}

export async function writeBackupRecord(projectRoot: string, record: BackupRecord): Promise<void> {
  const stamp = record.backedUpAt.replace(/[:.]/g, "-");
  await fs.mkdir(path.join(projectRoot, NOTES), { recursive: true });
  await writeJsonAtomic(path.join(projectRoot, `${NOTES}/backup-${stamp}.json`), record);
}

export async function readBackupState(projectRoot: string): Promise<BackupState | null> {
  try { return JSON.parse(await fs.readFile(path.join(projectRoot, BACKUP_STATE), "utf8")) as BackupState; }
  catch (e) { if (isMissing(e)) return null; throw e; }
}

export async function writeBackupState(projectRoot: string, state: BackupState): Promise<void> {
  await fs.mkdir(path.join(projectRoot, NOTES), { recursive: true });
  await writeJsonAtomic(path.join(projectRoot, BACKUP_STATE), state);
}

const localTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

/** 「我的内容/5 已发布/<稿>/NAS备份状态.txt」的正文 */
export function renderBackupStatus(s: BackupState): string {
  const tried = `最后尝试：${localTime(s.lastAttempt)}`;
  if (s.status === "backed_up") {
    return `已备份到 NAS\n\n时间：${localTime(s.backedUpAt ?? s.lastAttempt)}\nNAS 路径：${s.target}\n文件数：${s.fileCount ?? 0}，总大小：${formatBytes(s.totalBytes ?? 0)}\n`;
  }
  if (s.status === "unmounted") {
    return `还没备份到 NAS：${s.reason ?? "NAS 未挂载"}\n\n${tried}\n挂载 NAS 后，下一轮会自动补上。\n`;
  }
  if (s.failures >= BACKUP_FAIL_LIMIT) {
    return `NAS 备份已连续失败 ${s.failures} 次，需要看一下：\n\n原因：${s.reason ?? "未知"}\n${tried}\n目标：${s.target}\n`;
  }
  return `NAS 备份还没完成，下一轮自动重试（已连续失败 ${s.failures} 次）。\n\n${tried}\n`;
}
