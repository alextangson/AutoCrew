/**
 * 收件箱里「已经用过」的原片：字节已是某条稿的 accepted 原片（任何一轮）。对话里列收件箱时标出来，免得再挂一次。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { listContents } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { contentRoot } from "../../storage/content-project.js";
import { shaIndex } from "./sha-index.js";

export interface UsedBy { content_id: string; title: string; /** 某条 accepted 原片就是收件箱里这个文件本身（原地收的） */ in_place: boolean }

/** 这份字节已经是哪条稿的原片（accepted、任一轮、稿没删）；file 给了就顺带看是不是原地收的；没有 = null */
export async function arollUsedBy(dataDir: string, sha: string, file?: string): Promise<UsedBy | null> {
  const list = ((await shaIndex(dataDir)).entries[sha] ?? []).filter((e) => e.kind === "aroll" && e.state === "accepted");
  if (!list.length) return null;
  const contents = new Map((await listContents(dataDir)).filter((c) => !c.deletedAt).map((c) => [c.id, c.title]));
  const real = file ? await fs.realpath(file).catch(() => path.resolve(file)) : null;
  let found: UsedBy | null = null;
  for (const e of list) {
    if (!contents.has(e.content_id)) continue;
    // 索引可能落后：以制作记录为准
    const doc = await readProductionDoc(e.content_id, dataDir).catch(() => null);
    const f = doc?.facts.find((x) => x.id === e.fact_id);
    if (!f || f.state !== "accepted" || f.kind !== "aroll" || f.sha256 !== sha) continue;
    const at = f.path ? (path.isAbsolute(f.path) ? f.path : path.join(contentRoot(e.content_id, dataDir), f.path)) : null;
    const same = Boolean(real && at && (await fs.realpath(at).catch(() => path.resolve(at))) === real);
    if (same) return { content_id: e.content_id, title: contents.get(e.content_id)!, in_place: true };
    found ??= { content_id: e.content_id, title: contents.get(e.content_id)!, in_place: false };
  }
  return found;
}
