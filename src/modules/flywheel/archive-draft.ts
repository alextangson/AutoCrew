/**
 * 历史作品记录挂「存档原稿」（老作品补齐规格 2026-10-04 ②）。
 *
 * 从旧资料库（NAS 只读）复制一份 draft.md 正文到历史记录的 archiveDraft 字段，记下来源路径、旧稿 id、
 * 是否推断。只读查看用：不写 body，历史记录本身仍被所有生产入口拒收。源文件只读不写。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, updateContent, type Content } from "../../storage/local-store.js";
import { isImportedHistory } from "../../storage/imported-history.js";
import { assertDataDirWritable } from "../../storage/storage-roots.js";

export interface ArchiveSource { dir: string; oldId: string; inferred: boolean }

export type ArchiveRead =
  | { ok: true; body: string; sourcePath: string; oldTitle?: string }
  | { ok: false; code: "draft_missing" | "draft_empty" | "id_mismatch"; error: string };

/** 只读取旧稿：draft.md 缺失 / 为空 / 文件夹对不上旧稿 id 都如实报，不猜 */
export async function readArchiveSource(src: ArchiveSource): Promise<ArchiveRead> {
  const sourcePath = path.join(src.dir, "draft.md");
  if (!path.basename(src.dir).endsWith(`-${src.oldId}`)) {
    return { ok: false, code: "id_mismatch", error: `旧稿文件夹 ${src.dir} 不是旧稿 ${src.oldId}` };
  }
  let body: string;
  try { body = await fs.readFile(sourcePath, "utf-8"); } catch (err) {
    return { ok: false, code: "draft_missing", error: `旧稿 ${src.oldId} 的 draft.md 读不到（${(err as NodeJS.ErrnoException).code ?? (err as Error).message}）` };
  }
  if (!body.trim()) return { ok: false, code: "draft_empty", error: `旧稿 ${src.oldId} 的 draft.md 是空的` };
  let oldTitle: string | undefined;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(src.dir, "meta.json"), "utf-8")) as { title?: unknown };
    if (typeof meta.title === "string") oldTitle = meta.title;
  } catch { /* meta.json 只为带上旧标题，缺了不影响原稿 */ }
  return { ok: true, body, sourcePath, ...(oldTitle ? { oldTitle } : {}) };
}

export type AttachResult =
  | { ok: true; status: "attached" | "already"; contentId: string }
  | { ok: false; error: string };

/** 已挂的是同一份就 already；挂的是另一份旧稿 → 拒绝不覆盖 */
function existingVerdict(c: Content, src: ArchiveSource): AttachResult | null {
  const cur = c.archiveDraft;
  if (!cur) return null;
  if (cur.oldContentId === src.oldId) return { ok: true, status: "already", contentId: c.id };
  return { ok: false, error: `历史记录 ${c.id} 已挂存档原稿（旧稿 ${cur.oldContentId}），不覆盖` };
}

export async function attachArchiveDraft(contentId: string, src: ArchiveSource, read: ArchiveRead, dataDir?: string): Promise<AttachResult> {
  const content = await getContent(contentId, dataDir);
  if (!content || content.deletedAt) return { ok: false, error: `稿子 id「${contentId}」不存在` };
  if (!isImportedHistory(content)) return { ok: false, error: "存档原稿只挂在历史作品记录（imported_history）上" };
  const verdict = existingVerdict(content, src);
  if (verdict) return verdict;
  if (!read.ok) return { ok: false, error: read.error };
  assertDataDirWritable(dataDir);
  const archiveDraft: NonNullable<Content["archiveDraft"]> = {
    body: read.body, sourcePath: read.sourcePath, oldContentId: src.oldId, inferred: src.inferred,
    copiedAt: new Date().toISOString(), ...(read.oldTitle ? { oldTitle: read.oldTitle } : {}),
  };
  const updated = await updateContent(content.id, { archiveDraft }, dataDir);
  if (!updated) return { ok: false, error: `历史记录 ${content.id} 写入失败（不存在）` };
  return { ok: true, status: "attached", contentId: content.id };
}
