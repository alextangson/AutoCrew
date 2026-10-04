/**
 * 看板「移入回收站」的服务端判定（spec 2026-10-04 §1）：正在写的不删，已过「待录制」的不删。
 * 看板卡片的 `writing` 和删除口子（content-save delete + board_guard）共用这一处，不各算各的。
 */
import type { Content } from "../../storage/local-store.js";
import { activeClaim } from "../../storage/claims.js";
import { readPublishRecord } from "../../storage/publish-record.js";
import { GENERATING_TITLE_PREFIX, RESEARCHING_TITLE_PREFIX } from "../writing/generate-script.js";
import { explainContent } from "./read.js";

export const WRITING_REFUSAL = "这篇正在写，先停掉再弃用";
const TRASHABLE_COLUMNS = new Set(["写稿中", "待录制"]);
const PUBLISH_STATUSES = new Set(["publish_ready", "publishing", "published"]);

/** 正在写：drafting 且（占位标题带［生成中］/［调研中］，或写手认领还活着） */
export function isBeingWritten(c: Pick<Content, "status" | "title" | "claim">, now: number = Date.now()): boolean {
  if (c.status !== "drafting") return false;
  const title = c.title ?? "";
  if (title.startsWith(GENERATING_TITLE_PREFIX) || title.startsWith(RESEARCHING_TITLE_PREFIX)) return true;
  return activeClaim(c, now)?.employee === "writer";
}

/** 看板来的删除能不能做：能 → null；不能 → 一句人话 */
export async function boardTrashRefusal(c: Content, dataDir: string): Promise<string | null> {
  if (isBeingWritten(c)) return WRITING_REFUSAL;
  const publish = PUBLISH_STATUSES.has(c.status) || c.manualPublications?.length
    ? await readPublishRecord(c.id, c.manualPublications, dataDir) : null;
  const col = (await explainContent(c, dataDir, undefined, publish)).column;
  return col && TRASHABLE_COLUMNS.has(col) ? null : "这条已经进了后面的阶段，不能在看板上弃用";
}
