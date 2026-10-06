/**
 * 对话确认背后的文件（chat-approval §Codex 3、E13、E14）：
 * - 文件只从事实记下的路径 + sha 取，绝不收 agent 给的路径；
 * - 预览前、提交前各现算一次 sha（不用按文件身份的缓存），对不上就拒；
 * - 预览打开的是缓存目录里按 sha 命名的只读副本：看到的字节就是核过的字节。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot } from "../../../storage/content-project.js";
import { readProductionDocOrEmpty } from "../../../storage/production-store.js";
import type { Fact } from "../../../storage/production-types.js";
import { sha256File } from "../../video/handoff/manifest.js";
import { pullDeps } from "../../video/handoff/pull-deps.js";

export interface VerifiedFile { fact_id: string; file: string; sha256: string; name: string }
export type Verified = { ok: true; files: VerifiedFile[] } | { ok: false; code: string; error: string };

function factPath(contentId: string, f: Fact, dataDir: string): string {
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

export const previewDir = (dataDir: string) => path.join(dataDir, "cache", "review-preview");

/** 按 sha 命名的只读副本：已有且字节对就复用；拷完再核一遍副本 */
async function immutableCopy(v: VerifiedFile, dataDir: string): Promise<string> {
  const dir = previewDir(dataDir);
  const target = path.join(dir, `${v.sha256}${path.extname(v.file).toLowerCase()}`);
  if ((await sha256File(target).catch(() => null)) === v.sha256) return target;
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.copyFile(v.file, tmp);
  if ((await sha256File(tmp)) !== v.sha256) {
    await fs.rm(tmp, { force: true });
    throw new Error(`「${v.name}」拷贝时变了`);
  }
  await fs.chmod(tmp, 0o444);
  await fs.rm(target, { force: true });
  await fs.rename(tmp, target);
  return target;
}

/**
 * 「查看」：重新核字节 → 只读副本 → 系统默认程序打开（图片是「预览」，视频是 QuickTime）。
 * 打开成功回 null；打不开回原因（给下一次确认窗顶部）。不写任何记录。
 */
export async function openForReview(contentId: string, factIds: string[], dataDir: string): Promise<string | null> {
  if (!factIds.length) return "这件事没有可以打开看的文件";
  const v = await verifyFacts(contentId, factIds, dataDir);
  if (!v.ok) return v.error;
  for (const f of v.files) {
    let copy: string;
    try { copy = await immutableCopy(f, dataDir); } catch (e) { return `「${f.name}」没打开：${e instanceof Error ? e.message : String(e)}`; }
    const r = await pullDeps().opener(copy);
    if (!r.ok) return `「${f.name}」没打开：${r.reason}`;
  }
  return null;
}
