/**
 * 封面以文件夹为准（P6 §13.4-G，2026-09-27 修订）。
 *
 * 创始人的原话是「agent 只挂载本地文件路径，我就能在网页上审核」：Codex 把图放进 05-cover/ 就算交了，
 * 不靠它记得逐批 report（09-27 实测：Codex 出了 v001、v002 两批，只写了自己的 cover-manifest.json，
 * 一次也没 report，看板上一张都看不到）。
 *
 * - 版本文件夹 `vNNN`（或 `vNN`）里有 cover-manifest.json → 只认清单 outputs 列出的、确在该文件夹里的图；
 *   没有清单 → 该文件夹里所有 png / jpg / webp。参考图（比如身份照）靠比例筛掉。
 * - 3:4 / 4:3 按图片头里的真实像素判，不信文件名；其余比例不算封面。
 * - 哈希按（路径, 大小, 修改时间）缓存：看板每 15 秒刷新，不必每次重读 2 MB 的图。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { dimensionsOf, type ImageFormat } from "../../research/fetch-image.js";
import { COVER_ROLES, type ArtifactEntry, type StoredExecution } from "./execution-index.js";
import { sha256File } from "./manifest.js";

const COVER_DIR = "05-cover";
const VERSION_DIR = /^v0*(\d+)$/i;
const FORMATS: Record<string, ImageFormat> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" };
const HEADER_BYTES = 256 * 1024;
const hashCache = new Map<string, { key: string; sha256: string }>();

export function coverRole(width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return null;
  const ratio = width / height;
  if (Math.abs(ratio - 3 / 4) <= 0.03) return COVER_ROLES["3:4"];
  if (Math.abs(ratio - 4 / 3) <= 0.05) return COVER_ROLES["4:3"];
  return null;
}

async function readHeader(file: string): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function cachedSha(file: string, size: number, mtimeMs: number): Promise<string> {
  const key = `${size}:${Math.trunc(mtimeMs)}`;
  const hit = hashCache.get(file);
  if (hit?.key === key) return hit.sha256;
  const sha256 = await sha256File(file);
  hashCache.set(file, { key, sha256 });
  return sha256;
}

/**
 * 清单里列出的文件名；没有清单或读不懂 → null（退回扫整个文件夹）。
 * 按文件名认、不按整条路径认：Codex 写的是绝对路径，资料库一搬家（09-27 从 ~/Documents 迁出、
 * 以后归档 NAS）整条路径就对不上了。只认本版本文件夹里真实存在的同名文件，清单指向别处的一律不算。
 */
async function manifestNames(dir: string): Promise<Set<string> | null> {
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(path.join(dir, "cover-manifest.json"), "utf8")); } catch { return null; }
  const outputs = (raw as { outputs?: Array<{ path?: unknown }> })?.outputs;
  if (!Array.isArray(outputs)) return null;
  return new Set(outputs.filter((o) => typeof o?.path === "string").map((o) => path.basename(o.path as string)));
}

async function coverEntry(projectRoot: string, file: string, version: number, generation: number): Promise<ArtifactEntry | null> {
  const format = FORMATS[path.extname(file).toLowerCase()];
  if (!format) return null;
  const st = await fs.lstat(file).catch(() => null);
  if (!st?.isFile()) return null;
  const dims = dimensionsOf(format, await readHeader(file));
  const role = dims ? coverRole(dims.width, dims.height) : null;
  if (!role) return null;
  return {
    path: path.relative(projectRoot, file), sha256: await cachedSha(file, st.size, st.mtimeMs), role, version, generation,
    reported_at: new Date(st.mtimeMs).toISOString(), size: st.size, mtime_ms: Math.trunc(st.mtimeMs),
  };
}

/** 05-cover/vNNN/ 下的封面，按版本从旧到新 */
export async function scanCoverFolder(projectRoot: string, generation: number): Promise<ArtifactEntry[]> {
  const base = path.join(projectRoot, COVER_DIR);
  const dirs = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const versions = dirs
    .filter((d) => d.isDirectory() && VERSION_DIR.test(d.name))
    .map((d) => ({ dir: path.join(base, d.name), version: Number(VERSION_DIR.exec(d.name)![1]) }))
    .sort((a, b) => a.version - b.version);
  const out: ArtifactEntry[] = [];
  for (const { dir, version } of versions) {
    const listed = await manifestNames(dir);
    const names = (await fs.readdir(dir)).filter((n) => !listed || listed.has(n)).sort();
    for (const name of names) {
      const entry = await coverEntry(projectRoot, path.join(dir, name), version, generation);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/** 把文件夹里的封面并进产物索引（只在内存里，不落盘）：report 过的同一张以 report 为准 */
export function withFolderCovers(execution: StoredExecution | null, covers: ArtifactEntry[], generation: number): StoredExecution | null {
  if (covers.length === 0) return execution;
  const base: StoredExecution = execution ?? {
    schema: 2, generation, session_id: "", machine: "", host: "", transport_session: null,
    heartbeat: { request_id: "", session_id: "", result: "", next_action: "", reported_at: "" }, artifacts: [],
  };
  const known = new Set(base.artifacts.map((a) => `${a.role}:${a.sha256}`));
  return { ...base, artifacts: [...base.artifacts, ...covers.filter((c) => !known.has(`${c.role}:${c.sha256}`))] };
}
