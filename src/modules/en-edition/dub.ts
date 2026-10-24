/**
 * 英文配音（Phase 3）：只按批过的那份英文脚本，每段一次 ElevenLabs 调用，mp3 落在英文版项目 `en-dub/`，
 * 再写排时清单 `en-dub/manifest.json`（每条的起止、字级时间、尾段放慢倍数）。剪辑会话按清单摆音轨、烧字幕。
 *
 * - 同一段文字 + 同一套声音设置已经配过（文件还在、字节对得上）就复用，不重复花钱；
 * - 任何一段失败：照原样抛出 ElevenLabs 的错误，已配好的留着下次复用，不写半份清单，不换声音；
 * - 放慢超过 1.15×：清单照写（标 refused + 原因），返回拒绝，让宿主缩短脚本。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { readElevenLabsConfig, resolveElevenLabsKey, synthesize, type Alignment, type ElevenLabsConfig } from "../voice/elevenlabs.js";
import { planTiming, slowdownRefusal, type TimingPlan } from "../voice/timing.js";
import type { EnScript, Segment } from "./script.js";

export interface WordTime { word: string; startS: number; endS: number }
export interface DubLine { index: number; file: string; sha256: string; cacheKey: string; durationS: number; startS: number; endS: number; slotStartS: number; slotEndS: number; words: WordTime[] }
export interface DubManifest {
  scriptHash: string; voiceId: string; modelId: string; createdAt: string;
  lines: DubLine[]; sourceEndS: number; dubEndS: number; overrunS: number; slowFromS: number | null; tailSlowdown: number;
  refused?: string;
}

type Probe = (file: string) => Promise<number>;
const run = promisify(execFile);
const ffprobe: Probe = async (file) => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 30_000 });
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe 读不出 ${file} 的时长`);
  return d;
};
let probe: Probe = ffprobe;
/** 只给测试：替换时长探测 */
export function setDurationProbe(fn: Probe | null): void { probe = fn ?? ffprobe; }

export const dubDir = (contentId: string, dataDir: string) => projectFile(contentRoot(contentId, dataDir), "en-dub");
const manifestFile = (contentId: string, dataDir: string) => path.join(dubDir(contentId, dataDir), "manifest.json");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export async function readDubManifest(contentId: string, dataDir: string): Promise<DubManifest | null> {
  try { return JSON.parse(await fs.readFile(manifestFile(contentId, dataDir), "utf8")) as DubManifest; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 字级时间：ElevenLabs 按字符给，按空白切词 */
export function wordsFromAlignment(a: Alignment | null, offsetS: number): WordTime[] {
  if (!a) return [];
  const out: WordTime[] = [];
  let cur: WordTime | null = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) out.push(cur); cur = null; return; }
    const s = a.character_start_times_seconds[i] + offsetS, e = a.character_end_times_seconds[i] + offsetS;
    cur = cur ? { ...cur, word: cur.word + ch, endS: e } : { word: ch, startS: s, endS: e };
  });
  if (cur) out.push(cur);
  return out.map((w) => ({ ...w, startS: Math.round(w.startS * 1000) / 1000, endS: Math.round(w.endS * 1000) / 1000 }));
}

interface Voiced { seg: Segment; file: string; sha256: string; cacheKey: string; durationS: number; alignment: Alignment | null }

async function voiceSegment(seg: Segment, dir: string, key: string, cfg: ElevenLabsConfig, prev: DubManifest | null): Promise<Voiced> {
  const cacheKey = sha(JSON.stringify([seg.en, cfg.voiceId, cfg.modelId, cfg.voiceSettings]));
  const file = path.join(dir, `seg-${String(seg.index).padStart(2, "0")}-${cacheKey.slice(0, 8)}.mp3`);
  const alignFile = `${file}.alignment.json`;
  const old = prev?.lines.find((l) => l.cacheKey === cacheKey);
  const bytes = await fs.readFile(file).catch(() => null);
  if (old && bytes && sha(bytes) === old.sha256) {
    const alignment = JSON.parse(await fs.readFile(alignFile, "utf8").catch(() => "null")) as Alignment | null;
    return { seg, file, sha256: old.sha256, cacheKey, durationS: old.durationS, alignment };
  }
  const r = await synthesize(seg.en, key, cfg);
  await fs.writeFile(file, r.audio);
  await fs.writeFile(alignFile, JSON.stringify(r.alignment));
  return { seg, file, sha256: sha(r.audio), cacheKey, durationS: await probe(file), alignment: r.alignment };
}

function toManifest(voiced: Voiced[], plan: TimingPlan, scriptHash: string, cfg: ElevenLabsConfig): DubManifest {
  const lines = plan.lines.map((l) => {
    const v = voiced.find((x) => x.seg.index === l.index)!;
    return { index: l.index, file: v.file, sha256: v.sha256, cacheKey: v.cacheKey, durationS: l.durationS, startS: l.startS, endS: l.endS, slotStartS: l.slotStartS, slotEndS: l.slotEndS, words: wordsFromAlignment(v.alignment, l.startS) };
  });
  const { sourceEndS, dubEndS, overrunS, slowFromS, tailSlowdown } = plan;
  const refused = slowdownRefusal(plan);
  return { scriptHash, voiceId: cfg.voiceId!, modelId: cfg.modelId, createdAt: new Date().toISOString(), lines, sourceEndS, dubEndS, overrunS, slowFromS, tailSlowdown, ...(refused ? { refused } : {}) };
}

export type DubResult = { ok: true; manifest: DubManifest; path: string } | { ok: false; code: string; error: string; manifest?: DubManifest; path?: string };

/** script 必须是已批准且指纹对得上的那份（调用方核过） */
export async function dubApprovedScript(contentId: string, script: EnScript, scriptHash: string, dataDir: string): Promise<DubResult> {
  const [{ key }, cfg] = await Promise.all([resolveElevenLabsKey(), readElevenLabsConfig()]);
  if (!key) return { ok: false, code: "elevenlabs_key_missing", error: "没配 ElevenLabs 密钥：设置里填，或设环境变量 ELEVENLABS_API_KEY（autocrew doctor 会查）" };
  if (!cfg.voiceId) return { ok: false, code: "elevenlabs_voice_missing", error: "没配 ElevenLabs 声音 id（创始人的克隆声音）：写进设置 elevenlabs.json 的 voiceId，或设 ELEVENLABS_VOICE_ID" };
  const dir = dubDir(contentId, dataDir);
  await fs.mkdir(dir, { recursive: true });
  const prev = await readDubManifest(contentId, dataDir).catch(() => null);
  const voiced: Voiced[] = [];
  for (const seg of script.segments) {
    try { voiced.push(await voiceSegment(seg, dir, key, cfg, prev)); }
    catch (e) { return { ok: false, code: "tts_failed", error: `第 ${seg.index} 段配音失败：${e instanceof Error ? e.message : String(e)}` }; }
  }
  const plan = planTiming(voiced.map((v) => ({ index: v.seg.index, slotStartS: v.seg.startMs / 1000, slotEndS: v.seg.endMs / 1000, durationS: v.durationS })));
  const manifest = toManifest(voiced, plan, scriptHash, cfg);
  await writeJsonAtomic(manifestFile(contentId, dataDir), manifest);
  const out = manifestFile(contentId, dataDir);
  return manifest.refused ? { ok: false, code: "overrun_too_long", error: manifest.refused, manifest, path: out } : { ok: true, manifest, path: out };
}
