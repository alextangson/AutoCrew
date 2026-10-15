/**
 * 创始人自己的口播转写（spec 2026-10-15 §8、§15.2）：按作品绑定的项目文件夹找，分清成片 / 原片，一个解析器读全部格式。
 * - 来源：<项目>/99-cache/**\/transcription-manifest.json（转写清单，记着转的是哪个文件）旁边的 full.json。
 *   探测片段（probe-*）、词级结果（*.words.json）、覆盖分块（coverage*）都不读；不按目录 glob 拼接。
 * - 类型：清单的 source 指向成片（07-delivery / 06-publish / 「成片」）= final；指向原片或认不出 = raw（标「原片，非发布版」）。
 * - 格式：whisper（transcription[].text）、旧版（segments[].text）、ChatCut（utterances[].text）、纯数组；词级结果不当正文。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentIds, contentRoot } from "../../storage/content-project.js";

export type TranscriptSource = "final" | "raw";
export interface FounderTranscript { content_id: string; source_type: TranscriptSource; label: string; text: string; file: string; at: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const CJK = "\\u4e00-\\u9fff，。！？、；：「」";

/** 统一解析：认得出的格式回正文，词级 / 认不出的回 null */
export function parseTranscriptText(raw: unknown): string | null {
  const list = Array.isArray(raw) ? raw
    : isObj(raw) ? (raw.transcription ?? raw.segments ?? raw.utterances) : undefined;
  if (!Array.isArray(list)) return null;
  const parts = list.map((x) => (isObj(x) && typeof x.text === "string" ? x.text.trim() : "")).filter(Boolean);
  if (!parts.length) return null;
  return parts.join(" ").replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "g"), "$1").trim();
}

export function sourceTypeOf(source: string): TranscriptSource {
  if (/原片|02-aroll/.test(source)) return "raw";
  if (/成片|07-delivery|06-publish/i.test(source)) return "final";
  return "raw";
}

const LABEL: Record<TranscriptSource, string> = { final: "成片转写（发布版）", raw: "原片，非发布版" };

/** 99-cache 下三层以内的转写清单 */
async function manifests(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && e.name === "transcription-manifest.json") out.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < 3 && !/^coverage-chunks$/.test(e.name)) await walk(path.join(dir, e.name), depth + 1);
    }
  };
  await walk(path.join(root, "99-cache"), 0);
  return out.sort();
}

/** 只有词级结果、没有整段 full.json 的清单（如 A/B 对比）：不是坏文件，跳过；读坏了才报错 */
async function readOne(contentId: string, manifestFile: string): Promise<FounderTranscript | { error: string } | null> {
  const full = path.join(path.dirname(manifestFile), "full.json");
  const stat = await fs.stat(full).catch(() => null);
  if (!stat) return null;
  try {
    const m = JSON.parse(await fs.readFile(manifestFile, "utf8")) as Record<string, unknown>;
    const text = parseTranscriptText(JSON.parse(await fs.readFile(full, "utf8")));
    if (!text) return { error: `${full} 不是认得出的转写格式` };
    const type = sourceTypeOf(typeof m.source === "string" ? m.source : "");
    return { content_id: contentId, source_type: type, label: LABEL[type], text, file: full, at: stat.mtimeMs };
  } catch (e) {
    return { error: `${manifestFile}：${(e as Error).message}` };
  }
}

/** 全库创始人转写：成片在前，同类按时间新的在前；读不了的逐个报在 errors 里 */
export async function founderTranscripts(dataDir?: string): Promise<{ items: FounderTranscript[]; errors: string[] }> {
  const items: FounderTranscript[] = [];
  const errors: string[] = [];
  for (const id of await contentIds(dataDir)) {
    let root: string;
    try { root = contentRoot(id, dataDir); } catch { continue; }
    for (const f of await manifests(root)) {
      const r = await readOne(id, f);
      if (r && "error" in r) errors.push(r.error); else if (r) items.push(r);
    }
  }
  items.sort((a, b) => (a.source_type === b.source_type ? b.at - a.at : a.source_type === "final" ? -1 : 1));
  return { items, errors };
}
