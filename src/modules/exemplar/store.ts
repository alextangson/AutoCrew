/**
 * 范文库的存储（spec 2026-10-15 §2、§15.5），照手册存储的做法：
 * - manifest.json 是唯一提交点：先写 <id>/v<N>.md，最后写 manifest。
 * - manifest 不存在 = 库是空的（合法）；读坏了 = 可见错误，不当成空库、不覆盖。
 * - 版本文件只写一次：已存在且内容不同就跳到下一个号，不覆盖（在途稿锁的是旧版本）。
 * - 同一数据目录内的写按队列串行；写前先查资料库写入方。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomicMkdir, writeTextAtomicMkdir } from "../../storage/json-atomic.js";
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { EXEMPLAR_ID, ExemplarError, isExemplarGenre, type ExemplarEntry, type ExemplarGenre, type ExemplarKind, type ExemplarManifest } from "./types.js";

export const exemplarsDir = (dataDir?: string) => path.join(getDataDir(dataDir), "exemplars");
const manifestPath = (dataDir?: string) => path.join(exemplarsDir(dataDir), "manifest.json");
export const exemplarVersionPath = (id: string, version: number, dataDir?: string) => path.join(exemplarsDir(dataDir), id, `v${version}.md`);

export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
export const chars = (text: string) => Array.from(text).length;

const EMPTY: ExemplarManifest = { schema: 1, exemplars: [] };

/** 读 manifest：不存在 = 空库；读不了 / 解析不了 / 结构不对 = 抛可见错误 */
export async function readExemplarManifest(dataDir?: string): Promise<ExemplarManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(dataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, exemplars: [] };
    throw new ExemplarError("manifest_unreadable", `范文库清单读不了：${(e as Error).message}`);
  }
  try {
    const m = JSON.parse(raw) as ExemplarManifest;
    if (m?.schema !== 1 || !Array.isArray(m.exemplars)) throw new Error("结构不对");
    return m;
  } catch (e) {
    throw new ExemplarError("manifest_corrupt", `范文库清单 ${manifestPath(dataDir)} 解析失败（${(e as Error).message}）：没有覆盖它，请修复或从备份恢复`);
  }
}

/** 读某篇某一版全文；版本文件丢了 / 读不了都报可见错误 */
export async function readExemplarText(id: string, version: number, dataDir?: string): Promise<string> {
  if (!EXEMPLAR_ID.test(id)) throw new ExemplarError("bad_id", `范文 id 不合法：${id}`);
  try {
    return await fs.readFile(exemplarVersionPath(id, version, dataDir), "utf8");
  } catch (e) {
    throw new ExemplarError("version_unreadable", `范文 ${id} 第 ${version} 版读不了：${(e as Error).message}`);
  }
}

const chains = new Map<string, Promise<unknown>>();
export function serializeExemplars<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = exemplarsDir(dataDir);
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, run.catch(() => undefined));
  return run;
}

/** 从 start 起找一个空槽写入；已有同字节文件（上次崩在提交前）就复用；不同内容的孤儿文件跳过不碰 */
async function writeNextVersion(id: string, start: number, text: string, dataDir?: string): Promise<number> {
  for (let n = start; ; n++) {
    const file = exemplarVersionPath(id, n, dataDir);
    const existing = await fs.readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw new ExemplarError("version_unreadable", `范文版本文件读不了：${e.message}`);
    });
    if (existing === text) return n;
    if (existing !== null) continue;
    await writeTextAtomicMkdir(file, text);
    return n;
  }
}

export interface ExemplarInput { id: string; genre: ExemplarGenre; kind: ExemplarKind; title: string; text: string }
export type ImportOutcome = "created" | "new_version" | "unchanged";

function checkInput(x: ExemplarInput): void {
  if (!EXEMPLAR_ID.test(x.id)) throw new ExemplarError("bad_id", `范文 id 只能是小写字母、数字和连字符：${x.id}`);
  if (!isExemplarGenre(x.genre)) throw new ExemplarError("bad_genre", `不认识的体裁：${x.genre}`);
  if (!x.text.trim()) throw new ExemplarError("empty", `范文 ${x.id} 是空的`);
}

/** 入库一篇：内容和当前版一样 → unchanged；否则写成新版本（旧版本文件原样留着） */
export function putExemplar(x: ExemplarInput, dataDir?: string): Promise<{ id: string; outcome: ImportOutcome; version: number }> {
  checkInput(x);
  return serializeExemplars(dataDir, async () => {
    const m = await readExemplarManifest(dataDir);
    const hash = contentHash(x.text);
    const e = m.exemplars.find((y) => y.id === x.id);
    const cur = e?.versions.find((v) => v.version === e.current);
    if (e && cur?.hash === hash && e.genre === x.genre && e.kind === x.kind) return { id: x.id, outcome: "unchanged" as const, version: e.current };
    assertDataDirWritable(dataDir);
    const at = new Date().toISOString();
    const start = e ? Math.max(...e.versions.map((v) => v.version)) + 1 : 1;
    const version = cur?.hash === hash ? e!.current : await writeNextVersion(x.id, start, x.text, dataDir);
    const entry: ExemplarEntry = e ?? { id: x.id, genre: x.genre, kind: x.kind, title: x.title, current: version, versions: [] };
    Object.assign(entry, { genre: x.genre, kind: x.kind, title: x.title, current: version });
    if (!entry.versions.some((v) => v.version === version)) entry.versions.push({ version, at, hash, chars: chars(x.text), title: x.title });
    if (!e) m.exemplars.push(entry);
    await writeJsonAtomicMkdir(manifestPath(dataDir), m);
    return { id: x.id, outcome: e ? "new_version" as const : "created" as const, version };
  });
}
