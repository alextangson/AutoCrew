import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DoubaoConfig } from "../../config/index.js";

export interface Voice {
  id: string;
  name: string;
  language: string;
}

export interface VoiceConfig {
  voiceId: string;
  speed?: number;
  pitch?: number;
}

export interface AudioAsset {
  path: string;
  duration: number;
  format: "mp3" | "wav" | "ogg";
}

const TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v1/tts";

const BUILTIN_VOICES: Voice[] = [
  { id: "BV700_V2_streaming", name: "灿灿 2.0", language: "zh-CN" },
  { id: "BV405_streaming", name: "微晴", language: "zh-CN" },
  { id: "BV406_streaming", name: "梦欣", language: "zh-CN" },
  { id: "BV407_streaming", name: "然月", language: "zh-CN" },
  { id: "BV428_streaming", name: "青青", language: "zh-CN" },
  { id: "BV123_streaming", name: "阳光男声", language: "zh-CN" },
];

export class DoubaoTTS {
  readonly name = "doubao";
  private config: DoubaoConfig;

  constructor(config: DoubaoConfig) {
    this.config = config;
  }

  estimateDuration(text: string): number {
    return text.length / 4;
  }

  async generate(text: string, voice: VoiceConfig, outputPath: string): Promise<AudioAsset> {
    const cluster = this.config.cluster ?? "volcano_icl";
    const body = {
      app: {
        // appid is optional for x-api-key auth, include if configured
        ...(this.config.appId ? { appid: this.config.appId } : {}),
        cluster,
      },
      user: { uid: "autocrew" },
      audio: {
        voice_type: voice.voiceId || this.config.voiceType,
        encoding: "mp3",
        speed_ratio: voice.speed ?? 1.0,
        pitch_ratio: voice.pitch ?? 1.0,
      },
      request: {
        reqid: randomUUID(),
        text,
        operation: "query",
      },
    };

    // Auth: x-api-key header (豆包语音控制台 API Key)
    const res = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey ?? this.config.accessToken,
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as { code: number; message: string; data?: string };

    if (json.code !== 3000 || !json.data) {
      throw new Error(`Doubao TTS error ${json.code}: ${json.message}`);
    }

    const audioBuffer = Buffer.from(json.data, "base64");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, audioBuffer);

    const estimatedDuration = audioBuffer.length / 16000;

    return {
      path: outputPath,
      duration: estimatedDuration,
      format: "mp3",
    };
  }

  async listVoices(): Promise<Voice[]> {
    return BUILTIN_VOICES;
  }
}
