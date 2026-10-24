/**
 * ElevenLabs 配音（全媒体 spec §3.3「Voice」、Phase 3）：创始人的克隆声音，一段一次调用，带字级时间戳
 * （/with-timestamps：字幕按它卡时间）。
 *
 * 配置从哪来（产品路径）：密钥 = 环境变量 ELEVENLABS_API_KEY，或设置里存的 `<本机目录>/secrets/elevenlabs-api-key`；
 * 声音 id、模型、声音参数 = `<本机目录>/elevenlabs.json`（环境变量 ELEVENLABS_VOICE_ID 可覆盖声音 id）。
 * macOS 钥匙串 `autocrew-elevenlabs` 只是本机的便利兜底（创始人 demo 时存在那里），别的机器不依赖它。
 *
 * 失败照原样报：HTTP 状态 + ElevenLabs 返回的原文；没有备用声音，不换别的 TTS。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMachineDir } from "../../storage/storage-roots.js";

export interface VoiceSettings { stability: number; similarity_boost: number; style: number; use_speaker_boost: boolean }

export interface ElevenLabsConfig { voiceId: string | null; modelId: string; voiceSettings: VoiceSettings }

/** demo 里创始人听过选定的参数（默认参数听起来像播音员） */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { stability: 0.3, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true };
export const DEFAULT_MODEL = "eleven_v4";
const API = "https://api.elevenlabs.io/v1/text-to-speech";

export type KeySource = "env" | "settings" | "keychain";

export function elevenLabsKeyFile(machineDir?: string): string {
  return path.join(getMachineDir(machineDir), "secrets", "elevenlabs-api-key");
}

export function elevenLabsConfigFile(machineDir?: string): string {
  return path.join(getMachineDir(machineDir), "elevenlabs.json");
}

type Keychain = () => Promise<string | null>;
const run = promisify(execFile);
const realKeychain: Keychain = async () => {
  if (process.platform !== "darwin") return null;
  try { return (await run("security", ["find-generic-password", "-s", "autocrew-elevenlabs", "-w"], { timeout: 5000 })).stdout.trim() || null; }
  catch { return null; }
};
let keychain: Keychain = realKeychain;
/** 只给测试：替换钥匙串读取（null = 恢复） */
export function setKeychainReader(fn: Keychain | null): void { keychain = fn ?? realKeychain; }

/** 密钥值只在调用时现读，不缓存；回来源给 doctor 说（不回值） */
export async function resolveElevenLabsKey(machineDir?: string): Promise<{ key: string | null; source: KeySource | null }> {
  const env = process.env.ELEVENLABS_API_KEY?.trim();
  if (env) return { key: env, source: "env" };
  try {
    const raw = (await fs.readFile(elevenLabsKeyFile(machineDir), "utf8")).trim();
    if (raw) return { key: raw, source: "settings" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`读不了 ElevenLabs 密钥文件：${(e as NodeJS.ErrnoException).code ?? "未知错误"}`);
  }
  const k = await keychain();
  return k ? { key: k, source: "keychain" } : { key: null, source: null };
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);

export async function readElevenLabsConfig(machineDir?: string): Promise<ElevenLabsConfig> {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(await fs.readFile(elevenLabsConfigFile(machineDir), "utf8")) as Record<string, unknown>; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`ElevenLabs 设置读不出来（${(e as Error).message}）`);
  }
  const s = (raw.voiceSettings ?? {}) as Record<string, unknown>;
  const d = DEFAULT_VOICE_SETTINGS;
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || (typeof raw.voiceId === "string" && raw.voiceId.trim()) || null;
  return {
    voiceId, modelId: typeof raw.modelId === "string" && raw.modelId.trim() ? raw.modelId.trim() : DEFAULT_MODEL,
    voiceSettings: { stability: num(s.stability, d.stability), similarity_boost: num(s.similarity_boost, d.similarity_boost), style: num(s.style, d.style), use_speaker_boost: typeof s.use_speaker_boost === "boolean" ? s.use_speaker_boost : d.use_speaker_boost },
  };
}

export interface Alignment { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
export interface TtsResult { audio: Buffer; alignment: Alignment }

type Fetch = typeof fetch;
let fetchImpl: Fetch | null = null;
/** 只给测试：替换 HTTP（测试里绝不打真的 ElevenLabs） */
export function setElevenLabsFetch(fn: Fetch | null): void { fetchImpl = fn; }

/** 密钥格式：去掉首尾空白后不能有空白或控制字符。原因里不回显密钥 */
export function keyFormatProblem(key: string): string | null {
  // eslint-disable-next-line no-control-regex
  return /[\s\u0000-\u001f\u007f]/.test(key) ? "ElevenLabs 密钥格式不对（中间夹着换行、空格或控制字符）：重新粘一遍密钥" : null;
}

/** 任何要给人看的字符串：把密钥换成 *** */
export function redactKey(text: string, key: string): string {
  return key ? text.split(key).join("***") : text;
}

const finiteList = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** 字级时间戳的形状：三个数组等长、时间都是有限数；不对就抛（不把坏时间戳当成能用的存下来） */
export function checkAlignment(a: unknown): Alignment {
  const x = a as Partial<Alignment> | null;
  const n = Array.isArray(x?.characters) ? x!.characters.length : -1;
  if (n <= 0 || !x!.characters!.every((c) => typeof c === "string") || !finiteList(x!.character_start_times_seconds, n) || !finiteList(x!.character_end_times_seconds, n)) {
    throw new Error("ElevenLabs 返回的字级时间戳缺失或不完整（字符和起止时间对不上）：字幕卡不了时间，这段要重配");
  }
  return x as Alignment;
}

/** 一段文字 → mp3 + 字级时间戳。非 2xx 抛错，错误里是 HTTP 状态和返回原文（密钥一律打码） */
export async function synthesize(text: string, key: string, cfg: ElevenLabsConfig): Promise<TtsResult> {
  if (!cfg.voiceId) throw new Error("没配 ElevenLabs 声音 id");
  const bad = keyFormatProblem(key);
  if (bad) throw new Error(bad);
  try {
    return await call(text, key, cfg);
  } catch (e) {
    throw new Error(redactKey(e instanceof Error ? e.message : String(e), key));
  }
}

async function call(text: string, key: string, cfg: ElevenLabsConfig): Promise<TtsResult> {
  const res = await (fetchImpl ?? fetch)(`${API}/${encodeURIComponent(cfg.voiceId!)}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ text, model_id: cfg.modelId, voice_settings: cfg.voiceSettings }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${body.slice(0, 800)}`);
  let parsed: { audio_base64?: unknown; alignment?: unknown };
  try { parsed = JSON.parse(body) as typeof parsed; } catch { throw new Error(`ElevenLabs 返回的不是 JSON：${body.slice(0, 300)}`); }
  if (typeof parsed.audio_base64 !== "string" || !parsed.audio_base64) throw new Error(`ElevenLabs 返回里没有音频：${body.slice(0, 300)}`);
  return { audio: Buffer.from(parsed.audio_base64, "base64"), alignment: checkAlignment(parsed.alignment) };
}
