/** 设置页的 ElevenLabs（英文版配音）：密钥写本机 secrets（600）、声音 id 写本机 elevenlabs.json；读回只给来源和掩码 */
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getPublishSettings, setPublishSettings } from "./settings.js";
import { readElevenLabsConfig, resolveElevenLabsKey, setKeychainReader } from "../modules/voice/elevenlabs.js";

let dir: string;
const before = { local: process.env.AUTOCREW_LOCAL_DIR, key: process.env.ELEVENLABS_API_KEY, voice: process.env.ELEVENLABS_VOICE_ID };
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "el-settings-"));
  process.env.AUTOCREW_LOCAL_DIR = dir;
  delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID;
  setKeychainReader(async () => null);
});
afterEach(async () => {
  for (const [k, v] of [["AUTOCREW_LOCAL_DIR", before.local], ["ELEVENLABS_API_KEY", before.key], ["ELEVENLABS_VOICE_ID", before.voice]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  setKeychainReader(null);
  await fs.rm(dir, { recursive: true, force: true });
});

it("saves the ElevenLabs key and voice id from the settings page; values never come back", async () => {
  expect(await getPublishSettings({ _dataDir: dir })).toMatchObject({ ok: true, data: { elevenLabs: { keySource: null, voiceIdMasked: null } } });
  await fs.writeFile(path.join(dir, "elevenlabs.json"), JSON.stringify({ modelId: "eleven_v4", voiceSettings: { stability: 0.4 } }));
  const r = await setPublishSettings({ _dataDir: dir, elevenlabs_api_key: "sk-el-secret-123456", elevenlabs_voice_id: "voice-abcdef-123" });
  expect(r).toMatchObject({ ok: true, data: { elevenLabs: { keySource: "settings", voiceIdMasked: "voic…-123", voiceSource: "settings" } } });
  expect(JSON.stringify(r)).not.toContain("sk-el-secret-123456");
  expect(JSON.stringify(r)).not.toContain("voice-abcdef-123");
  expect((await fs.stat(path.join(dir, "secrets", "elevenlabs-api-key"))).mode & 0o777).toBe(0o600);
  expect((await resolveElevenLabsKey()).key).toBe("sk-el-secret-123456");
  const cfg = await readElevenLabsConfig();
  expect(cfg).toMatchObject({ voiceId: "voice-abcdef-123", modelId: "eleven_v4" });
  expect(cfg.voiceSettings.stability).toBe(0.4);
  expect(await fs.readFile(path.join(dir, "publish.json"), "utf8").catch(() => "")).not.toContain("sk-el");
  expect(await setPublishSettings({ _dataDir: dir, elevenlabs_voice_id: "has space" })).toMatchObject({ ok: false });
});

it("env still wins over the settings file", async () => {
  await setPublishSettings({ _dataDir: dir, elevenlabs_api_key: "sk-file" });
  process.env.ELEVENLABS_API_KEY = "sk-env";
  expect(await resolveElevenLabsKey()).toEqual({ key: "sk-env", source: "env" });
});
