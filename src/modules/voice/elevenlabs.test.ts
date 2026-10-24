/**
 * ElevenLabs 配置与 doctor：密钥按 环境变量 → 设置文件 → 本机钥匙串 取；声音参数可配、默认是 demo 选定的那组；
 * doctor 只报有没有、来自哪，绝不带出密钥值。HTTP 全部 mock。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_VOICE_SETTINGS, elevenLabsConfigFile, elevenLabsKeyFile, readElevenLabsConfig, resolveElevenLabsKey, setElevenLabsFetch, setKeychainReader, synthesize } from "./elevenlabs.js";
import { enDoctorHints, enEditionDoctor } from "./doctor.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "el-"));
  delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID;
  setKeychainReader(async () => null);
});
afterEach(async () => {
  setKeychainReader(null); setElevenLabsFetch(null);
  delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("密钥与设置", () => {
  it("环境变量优先，其次设置文件，钥匙串只是最后的本机兜底", async () => {
    expect(await resolveElevenLabsKey(dir)).toEqual({ key: null, source: null });
    setKeychainReader(async () => "kc-key");
    expect(await resolveElevenLabsKey(dir)).toEqual({ key: "kc-key", source: "keychain" });
    await fs.mkdir(path.dirname(elevenLabsKeyFile(dir)), { recursive: true });
    await fs.writeFile(elevenLabsKeyFile(dir), "file-key\n");
    expect(await resolveElevenLabsKey(dir)).toEqual({ key: "file-key", source: "settings" });
    process.env.ELEVENLABS_API_KEY = "env-key";
    expect(await resolveElevenLabsKey(dir)).toEqual({ key: "env-key", source: "env" });
  });

  it("没设置 = eleven_v4 + demo 选定参数；设置文件可改每一项（字符串数字也认）", async () => {
    expect(await readElevenLabsConfig(dir)).toEqual({ voiceId: null, modelId: "eleven_v4", voiceSettings: DEFAULT_VOICE_SETTINGS });
    await fs.writeFile(elevenLabsConfigFile(dir), JSON.stringify({ voiceId: "v1", modelId: "eleven_v5", voiceSettings: { stability: "0.5", use_speaker_boost: false } }));
    expect(await readElevenLabsConfig(dir)).toEqual({ voiceId: "v1", modelId: "eleven_v5", voiceSettings: { ...DEFAULT_VOICE_SETTINGS, stability: 0.5, use_speaker_boost: false } });
    process.env.ELEVENLABS_VOICE_ID = "v-env";
    expect((await readElevenLabsConfig(dir)).voiceId).toBe("v-env");
  });

  it("API 非 2xx：错误里是 HTTP 状态和原文；返回里没音频也报", async () => {
    const cfg = { voiceId: "v", modelId: "eleven_v4", voiceSettings: DEFAULT_VOICE_SETTINGS };
    setElevenLabsFetch((async () => new Response("quota_exceeded: 0 credits left", { status: 429 })) as typeof fetch);
    await expect(synthesize("hi", "k", cfg)).rejects.toThrow("ElevenLabs HTTP 429: quota_exceeded: 0 credits left");
    setElevenLabsFetch((async () => new Response("{}", { status: 200 })) as typeof fetch);
    await expect(synthesize("hi", "k", cfg)).rejects.toThrow(/没有音频/);
  });
});

describe("doctor", () => {
  it("缺密钥 / 声音 id 时说清去哪配；有密钥时只报来源，输出里没有密钥值", async () => {
    const missing = await enEditionDoctor(process.cwd(), dir);
    expect(missing).toMatchObject({ elevenLabsKey: false, voiceId: false, captionScript: true });
    expect(enDoctorHints(missing).join("\n")).toMatch(/ELEVENLABS_API_KEY[\s\S]*ELEVENLABS_VOICE_ID/);
    process.env.ELEVENLABS_API_KEY = "sk-super-secret-value";
    process.env.ELEVENLABS_VOICE_ID = "voice-1";
    const ok = await enEditionDoctor(process.cwd(), dir);
    expect(ok).toMatchObject({ elevenLabsKey: true, keySource: "env", voiceId: true });
    expect(JSON.stringify({ ...ok, hints: enDoctorHints(ok) })).not.toContain("sk-super-secret-value");
  });
});
