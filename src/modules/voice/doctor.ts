/**
 * `autocrew doctor` 的英文版一项（Phase 3）：ElevenLabs 密钥有没有、来自哪（值不打印）、声音 id 配没配；
 * 字幕烧录脚本在不在、字体在不在。都是可选项：没勾 YouTube / X 的人用不到英文版。
 */
import fs from "node:fs";
import path from "node:path";
import { readElevenLabsConfig, resolveElevenLabsKey, SETTINGS_PLACE } from "./elevenlabs.js";

export const CAPTION_FONT = "/System/Library/Fonts/Avenir Next.ttc";

export interface EnDoctor {
  elevenLabsKey: boolean;
  keySource: string | null;
  voiceId: boolean;
  modelId: string | null;
  captionScript: boolean;
  captionFont: boolean;
  error?: string;
}

export async function enEditionDoctor(repoRoot: string, machineDir?: string): Promise<EnDoctor> {
  const script = fs.existsSync(path.join(repoRoot, "sidecars", "captions", "burn_captions.py"));
  const font = fs.existsSync(CAPTION_FONT);
  try {
    const [{ source }, cfg] = await Promise.all([resolveElevenLabsKey(machineDir), readElevenLabsConfig(machineDir)]);
    return { elevenLabsKey: source !== null, keySource: source, voiceId: Boolean(cfg.voiceId), modelId: cfg.modelId, captionScript: script, captionFont: font };
  } catch (e) {
    return { elevenLabsKey: false, keySource: null, voiceId: false, modelId: null, captionScript: script, captionFont: font, error: e instanceof Error ? e.message : String(e) };
  }
}

/** doctor 给人看的提示（只说缺什么、去哪配；不含密钥） */
export function enDoctorHints(d: EnDoctor): string[] {
  const out: string[] = [];
  if (d.error) out.push(`英文版配音设置读不出来：${d.error}`);
  if (!d.elevenLabsKey) out.push(`（勾了 YouTube / X 才需要）英文版配音要 ElevenLabs 密钥：到「${SETTINGS_PLACE}」里填，或设环境变量 ELEVENLABS_API_KEY`);
  if (!d.voiceId) out.push(`（勾了 YouTube / X 才需要）英文版配音要创始人的 ElevenLabs 克隆声音 id：到「${SETTINGS_PLACE}」里填 Voice ID，或设 ELEVENLABS_VOICE_ID`);
  if (!d.captionScript) out.push("缺英文字幕烧录脚本 sidecars/captions/burn_captions.py：仓库不完整，重新拉取");
  if (!d.captionFont) out.push(`英文字幕字体 ${CAPTION_FONT} 不在（macOS 自带）：别的系统用 --font 指一个 Demi Bold 字体`);
  return out;
}
