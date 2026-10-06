/**
 * 对话拍板背后的文件（chat-approval E13）：文件只从事实记下的路径 + sha 取，绝不收 agent 给的路径；
 * 提交前现算一次 sha（不用按文件身份的缓存），对不上就拒。
 */
import path from "node:path";
import { contentRoot } from "../../../storage/content-project.js";
import { readProductionDocOrEmpty } from "../../../storage/production-store.js";
import type { Fact } from "../../../storage/production-types.js";
import { sha256File } from "../../video/handoff/manifest.js";

export interface VerifiedFile { fact_id: string; file: string; sha256: string; name: string }
export type Verified = { ok: true; files: VerifiedFile[] } | { ok: false; code: string; error: string };

export function factPath(contentId: string, f: Fact, dataDir: string): string {
  return path.isAbsolute(f.path!) ? f.path! : path.join(contentRoot(contentId, dataDir), f.path!);
}

async function verifyOne(contentId: string, f: Fact | undefined, dataDir: string): Promise<VerifiedFile | string> {
  if (!f || !f.path || !f.sha256) return "这件事背后的文件记录不在了，刷新再看";
  if (f.state === "rejected") return "这个文件已经被否掉了，刷新再看";
  if (f.replaced_at) return `「${path.basename(f.path)}」在盘上被覆盖过，已经不是记下的那份了`;
  const file = factPath(contentId, f, dataDir);
  const now = await sha256File(file).catch(() => null);
  if (!now) return `「${path.basename(f.path)}」找不到了（可能挪走或删了）`;
  if (now !== f.sha256) return `「${path.basename(f.path)}」刚变过，和记下的那份对不上`;
  return { fact_id: f.id, file, sha256: f.sha256, name: path.basename(f.path) };
}

/** 现算 sha 核对这几条事实背后的文件；一个对不上就整件拒 */
export async function verifyFacts(contentId: string, factIds: string[], dataDir: string): Promise<Verified> {
  if (!factIds.length) return { ok: true, files: [] };
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const files: VerifiedFile[] = [];
  for (const id of factIds) {
    const r = await verifyOne(contentId, doc.facts.find((x) => x.id === id), dataDir);
    if (typeof r === "string") return { ok: false, code: "file_changed", error: `${r}：这次什么都没记，刷新看现在的样子` };
    files.push(r);
  }
  return { ok: true, files };
}
