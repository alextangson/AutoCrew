/**
 * 体裁手册的存储（spec §1、§9.2）。manifest.json 是唯一提交点：先写 v<N>.md，最后写 manifest。
 * - manifest 不存在 = 还没种：（重新）种 5 本 v1；目标版本文件已在且字节相同就保留，不同就报错不覆盖。
 * - manifest 读坏了 = 可见错误，不当成空、不覆盖。
 * - 版本文件只写一次：已存在且内容不同直接拒。
 * - 同一数据目录内的写按队列串行；写前先查资料库写入方（assertDataDirWritable），不写半截。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomicMkdir, writeTextAtomicMkdir } from "../../storage/json-atomic.js";
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { PLAYBOOK_IDS, PlaybookError, type PlaybookEntry, type PlaybookId, type PlaybookManifest } from "./types.js";

const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "templates", "playbooks");

export const playbooksDir = (dataDir?: string) => path.join(getDataDir(dataDir), "playbooks");
const manifestPath = (dataDir?: string) => path.join(playbooksDir(dataDir), "manifest.json");
export const versionPath = (id: PlaybookId, version: number, dataDir?: string) => path.join(playbooksDir(dataDir), id, `v${version}.md`);

export const shortHash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
export const charCount = (text: string) => Array.from(text).length;

interface Seed { id: PlaybookId; name: string; text: string }

/** 仓库自带的 5 本默认手册：frontmatter 只给 id / name，正文原样作为 v1 */
export async function loadSeeds(dir = SEED_DIR): Promise<Seed[]> {
  return Promise.all(PLAYBOOK_IDS.map(async (id) => {
    const raw = await fs.readFile(path.join(dir, `${id}.md`), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n+/);
    const name = m?.[1].match(/^name:\s*(.+)$/m)?.[1].trim();
    if (!m || !name) throw new PlaybookError("seed_invalid", `仓库自带手册 ${id}.md 缺 frontmatter 的 name`);
    return { id, name, text: raw.slice(m[0].length) };
  }));
}

/** 读 manifest：null = 不存在；读坏了抛可见错误 */
async function readManifestRaw(dataDir?: string): Promise<PlaybookManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(dataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PlaybookError("manifest_unreadable", `手册清单读不了：${(e as Error).message}`);
  }
  try {
    const m = JSON.parse(raw) as PlaybookManifest;
    if (m?.schema !== 1 || !Array.isArray(m.playbooks) || !Array.isArray(m.events)) throw new Error("结构不对");
    return m;
  } catch (e) {
    throw new PlaybookError("manifest_corrupt", `手册清单 ${manifestPath(dataDir)} 解析失败（${(e as Error).message}）：没有覆盖它，请修复或从备份恢复`);
  }
}

/** 版本文件只写一次：已存在且字节相同 → 保留；不同 → 拒 */
export async function writeVersionOnce(id: PlaybookId, version: number, text: string, dataDir?: string): Promise<void> {
  const file = versionPath(id, version, dataDir);
  const existing = await fs.readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw new PlaybookError("version_unreadable", `手册版本文件读不了：${e.message}`);
  });
  if (existing === text) return;
  if (existing !== null) throw new PlaybookError("version_exists", `手册版本文件 ${file} 已存在且内容不同：不覆盖，请人工核对`);
  await writeTextAtomicMkdir(file, text);
}

export async function writeManifest(m: PlaybookManifest, dataDir?: string): Promise<void> {
  await writeJsonAtomicMkdir(manifestPath(dataDir), m);
}

async function seed(dataDir?: string): Promise<PlaybookManifest> {
  assertDataDirWritable(dataDir);
  const seeds = await loadSeeds();
  const at = new Date().toISOString();
  for (const s of seeds) await writeVersionOnce(s.id, 1, s.text, dataDir);
  const m: PlaybookManifest = {
    schema: 1, events: [],
    playbooks: seeds.map((s): PlaybookEntry => ({ id: s.id, name: s.name, current: 1, proposals: [], versions: [{ version: 1, at, author: "agent", kind: "seed" }] })),
  };
  await writeManifest(m, dataDir);
  return m;
}

const chains = new Map<string, Promise<unknown>>();

/** 同一数据目录的手册读写串行（种子也在队列里，不会并发种两遍） */
export function serialize<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = playbooksDir(dataDir);
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(key, run.catch(() => undefined));
  return run;
}

/** 首次读取种 5 本 v1；之后原样读 */
export function loadManifest(dataDir?: string): Promise<PlaybookManifest> {
  return serialize(dataDir, async () => (await readManifestRaw(dataDir)) ?? seed(dataDir));
}

/** 队列内用：已经在 serialize 里时直接读（或种） */
export async function manifestInQueue(dataDir?: string): Promise<PlaybookManifest> {
  return (await readManifestRaw(dataDir)) ?? seed(dataDir);
}

export function entryOf(m: PlaybookManifest, id: PlaybookId): PlaybookEntry {
  const e = m.playbooks.find((p) => p.id === id);
  if (!e) throw new PlaybookError("playbook_missing", `手册清单里没有 ${id}`);
  return e;
}

/** 读某一版全文；版本不存在 / 文件丢了都报可见错误 */
export async function readVersionText(id: PlaybookId, version: number, dataDir?: string): Promise<string> {
  try {
    return await fs.readFile(versionPath(id, version, dataDir), "utf8");
  } catch (e) {
    throw new PlaybookError("version_unreadable", `手册 ${id} 第 ${version} 版读不了：${(e as Error).message}`);
  }
}

/** 「什么时候选它」一段（start 的 playbooks_index 用，不带全文） */
export function whenToChoose(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^##\s*什么时候选它/.test(l));
  if (at < 0) return "";
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}
