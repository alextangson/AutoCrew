/**
 * 收件箱里「已经用过」的原片：字节已是某条稿的 accepted 原片（任何一轮）→ 不再列成「没对上」，挪进收件箱下的 `已用过/`。
 * 只挪不删；重名加后缀，不覆盖。挪失败要让调用方看得见。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { listContents } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { shaIndex } from "./sha-index.js";

export const USED_DIR = "已用过";

/** 这份字节已经是哪条稿的原片（accepted、任一轮、稿没删）；没有 = null */
export async function arollUsedBy(dataDir: string, sha: string): Promise<{ content_id: string; title: string } | null> {
  const list = ((await shaIndex(dataDir)).entries[sha] ?? []).filter((e) => e.kind === "aroll" && e.state === "accepted");
  if (!list.length) return null;
  const contents = new Map((await listContents(dataDir)).filter((c) => !c.deletedAt).map((c) => [c.id, c.title]));
  for (const e of list) {
    if (!contents.has(e.content_id)) continue;
    // 索引可能落后：以制作记录为准
    const doc = await readProductionDoc(e.content_id, dataDir).catch(() => null);
    const f = doc?.facts.find((x) => x.id === e.fact_id);
    if (f && f.state === "accepted" && f.kind === "aroll" && f.sha256 === sha) return { content_id: e.content_id, title: contents.get(e.content_id)! };
  }
  return null;
}

/** 挪进同目录下的 `已用过/`：重名 → `名字-2.ext`…；返回新路径 */
export async function moveToUsed(file: string): Promise<string> {
  const dir = path.join(path.dirname(file), USED_DIR);
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(file), stem = path.basename(file, ext);
  for (let n = 1; n < 1000; n++) {
    const target = path.join(dir, `${stem}${n === 1 ? "" : `-${n}`}${ext}`);
    // 先占名（wx 独占创建），再 rename 覆盖这个空占位：并发也不会盖掉别的文件
    const h = await fs.open(target, "wx").catch((e: NodeJS.ErrnoException) => { if (e.code === "EEXIST") return null; throw e; });
    if (!h) continue;
    await h.close();
    try { await fs.rename(file, target); } catch (e) { await fs.rm(target, { force: true }); throw e; }
    return target;
  }
  throw new Error("已用过文件夹里同名文件太多");
}
