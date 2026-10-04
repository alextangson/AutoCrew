/**
 * 「我的内容」改稿回流：创始人在写稿中 / 待录制的「口播稿.md」里改了字，
 * 对账时先把改后的全文存成稿件新版本（与 content update 同一条 updateContent 通道），
 * 并记一条改稿差异喂给写手。不能同步的（AI 正在写、空文件、已交剪辑、稿子同时被 AI 改过）
 * 把文件挪成「我改过的」副本保留，原因写进同步出错文件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { getContent, updateContent, LOCAL_HOST, type Content } from "./local-store.js";
import { ScriptFrozenError } from "./production-store.js";
import { activeClaim } from "./claims.js";
import { resolveContentProject } from "./content-project.js";
import { columnDir, columnOf, scriptText } from "./my-content-plan.js";
import { readPack } from "../tools/writer-pack.js";
import { recordDiff } from "../modules/learnings/diff-tracker.js";
import { HUMAN_WRITE } from "./first-body-guard.js";

export const FOUNDER_EDIT_NOTE = "创始人在「我的内容」里改稿";
const EDITABLE_DIRS = new Set([columnDir("写稿中"), columnDir("待录制")]);
export const isEditable = (rel: string) => { const p = rel.split("/"); return p.length === 3 && EDITABLE_DIRS.has(p[0]) && p[2] === "口播稿.md"; };

export interface ViewCopyEntry { owner: string; kind: string; hash?: string }
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** 能不能把创始人的改稿写回：返回 null = 能，否则是不能的人话原因 */
async function blockReason(c: Content, text: string, viewHash: string, dataDir: string): Promise<string | null> {
  if (!text.trim()) return "改后的文件是空的，按误操作处理";
  const col = await columnOf(c, dataDir);
  if (col !== "写稿中" && col !== "待录制") return "稿子已经交剪辑或更往后了，定稿锁定，不再改";
  const claim = activeClaim(c);
  if (claim && claim.host !== LOCAL_HOST) return `AI（${claim.host}）正在处理这篇稿，等它做完再改`;
  if ((await readPack(c.id, dataDir))?.state === "preparing") return "写作包正在备料，等备完再改";
  const root = resolveContentProject(c.id, dataDir)?.project_root;
  const current = root ? await scriptText(c, root) : null;
  if (current === null || sha(current) !== viewHash) return "你改的同时稿子已经被 AI 更新了，没有覆盖它";
  return null;
}

/** 写回一份改稿；返回 null = 已写回，否则是没写回的原因 */
async function syncOne(id: string, text: string, viewHash: string, dataDir: string): Promise<string | null> {
  const c = await getContent(id, dataDir);
  if (!c) return "稿件已经不在了";
  const blocked = await blockReason(c, text, viewHash, dataDir);
  if (blocked) return blocked;
  // 创始人自己改的（§13-C）：待录制时认稿随改稿重绑；已冻结的会被写口拒，照原因保留他的文件
  let updated: Content | null;
  try { updated = await updateContent(id, { body: text, _versionNote: FOUNDER_EDIT_NOTE, _editor: "founder", _provenance: HUMAN_WRITE }, dataDir); }
  catch (e) { if (e instanceof ScriptFrozenError) return e.message; throw e; }
  if (!updated) return "稿件已经不在了";
  await recordDiff(id, "founder", "body", c.body, text, dataDir, FOUNDER_EDIT_NOTE, c.platform);
  return null;
}

/**
 * 扫清单里所有写稿中 / 待录制的口播稿副本，改过的尝试写回。
 * `keepAside` 把没写回的文件挪成「我改过的」副本；返回写进同步出错文件的行。
 */
export async function syncBackFounderEdits(
  root: string,
  entries: Record<string, ViewCopyEntry>,
  dataDir: string,
  keepAside: (file: string) => Promise<void>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const [rel, entry] of Object.entries(entries)) {
    if (entry.kind !== "copy" || !entry.hash || !isEditable(rel)) continue;
    const file = path.join(root, rel);
    let text: string;
    try { text = await fs.readFile(file, "utf8"); } catch { continue; }
    if (sha(text) === entry.hash) continue;
    try {
      const why = await syncOne(entry.owner, text, entry.hash, dataDir);
      if (why === null) continue;
      await keepAside(file);
      errors.push(`${rel}：你的改稿没有同步回 AutoCrew（${why}），原文件已另存为「口播稿（我改过的 …）.md」`);
    } catch (e) {
      errors.push(`${rel}：改稿同步失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return errors;
}
