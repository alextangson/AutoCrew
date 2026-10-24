/**
 * 设置 · 接入更多 · 英文版配音（ElevenLabs）：密钥写本机 ~/.autocrew/secrets/elevenlabs-api-key（600），
 * 声音 id 写本机 elevenlabs.json。两样都不回显：密钥只显示来自哪，声音 id 只显示掩码。环境变量照样优先。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { Field, Section } from "./settings-kit";

interface VoiceStatus { keySource: string | null; voiceIdMasked: string | null; voiceSource: string | null }
const KEY_LABEL: Record<string, string> = { env: "已配置（环境变量）", settings: "已配置（本机设置）", keychain: "已配置（macOS 钥匙串）", unreadable: "密钥文件读不了" };

export function SettingsVoice() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [key, setKey] = useState("");
  const [voice, setVoice] = useState("");
  const load = async () => {
    const r = await invoke("settings:publish_get");
    if (r.ok) setStatus((r as unknown as { data?: { elevenLabs?: VoiceStatus } }).data?.elevenLabs ?? null);
  };
  useEffect(() => { void load(); }, []);
  const save = async () => {
    const payload: Record<string, string> = {};
    if (key.trim()) payload.elevenlabs_api_key = key.trim();
    if (voice.trim()) payload.elevenlabs_voice_id = voice.trim();
    if (!Object.keys(payload).length) return toast("填密钥或声音 ID（只填要改的那一项）");
    const r = await invoke("settings:publish_set", payload);
    if (!r.ok) return toast(r.error ?? "保存失败");
    setKey(""); setVoice("");
    toast("已保存");
    void load();
  };
  const keyText = status?.keySource ? KEY_LABEL[status.keySource] ?? status.keySource : "未配置";
  const voiceText = status?.voiceIdMasked ? `${status.voiceIdMasked}${status.voiceSource === "env" ? "（环境变量）" : ""}` : "未配置";
  return <Section title="英文版配音（ElevenLabs）" status={status?.keySource && status.voiceIdMasked ? "已配置" : ""} on={Boolean(status?.keySource && status.voiceIdMasked)}>
    <p className="muted">勾了 YouTube / X 才用得到：英文版用你在 ElevenLabs 克隆的声音配音。密钥：{keyText}；声音 ID：{voiceText}</p>
    <Field label="ElevenLabs API Key" password value={key} placeholder={status?.keySource ? "已保存（重填即覆盖）" : "ElevenLabs → Profile → API Keys"} onChange={setKey} />
    <Field label="声音 ID（Voice ID）" value={voice} placeholder={status?.voiceIdMasked ? "已保存（重填即覆盖）" : "ElevenLabs → Voices → 你的克隆声音 → Voice ID"} onChange={setVoice} />
    <div className="set-save"><button className="primary" onClick={() => void save()}>保存</button></div>
  </Section>;
}
