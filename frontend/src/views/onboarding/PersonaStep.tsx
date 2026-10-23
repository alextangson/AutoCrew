/**
 * 引导「你是谁」（onboarding-connect §7.2-4）：做什么的 / 发哪些平台 / 给谁看 / 想要的口吻 / 一两条满意的旧作。
 * 可跳过（O18）：跳过照样能开工，看板上留一条「补全画像」提醒。
 */
import { useState } from "react";
import { invoke } from "../../transport";
import { PLATFORM_CAPS } from "../../lib";
import "./onboarding.css";

/** 能力表里的平台（抖音、视频号、小红书、B站、公众号、YouTube、X）；勾了才开对应的生产线 */
const PLATFORMS: Array<[string, string]> = Object.entries(PLATFORM_CAPS).map(([id, c]) => [id, c.label]);

export function PersonaStep(props: { onNext: () => void }) {
  const [industry, setIndustry] = useState("");
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [audience, setAudience] = useState("");
  const [voice, setVoice] = useState("");
  const [works, setWorks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setPlatforms((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const send = async (payload: Record<string, unknown>, failPrefix: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await invoke("onboarding:init", payload);
    setBusy(false);
    if (!r.ok) { setError(`${failPrefix}：${r.error ?? "原因没写"}`); return; }
    props.onNext();
  };
  const save = () => void send({ industry, platforms, audience, voice, referenceWorks: works.split(/\s+/).filter(Boolean) }, "没存上");
  const skip = () => void send({ skipped: true }, "没记住跳过");
  const ready = industry.trim() && platforms.length && audience.trim() && voice.trim();

  return (
    <>
      <h1 className="ob-title">你是谁</h1>
      <p className="ob-sub">几句话，AI 写稿时照这个来。现在不想填可以跳过，之后看板上会提醒你补。</p>
      <div className="field"><label>你是做什么的<input value={industry} placeholder="比如：教职场人用 AI 的博主" onChange={(e) => setIndustry(e.target.value)} /></label></div>
      <div className="field"><span>发哪些平台</span>
        <div className="ob-kinds">{PLATFORMS.map(([id, label]) => (
          <label key={id} className="ob-kind"><input type="checkbox" checked={platforms.includes(id)} onChange={() => toggle(id)} />{label}</label>
        ))}</div>
      </div>
      <div className="field"><label>给谁看<input value={audience} placeholder="比如：不写代码的上班族" onChange={(e) => setAudience(e.target.value)} /></label></div>
      <div className="field"><label>想要的口吻<input value={voice} placeholder="比如：像朋友聊天，不端着" onChange={(e) => setVoice(e.target.value)} /></label></div>
      <div className="field"><label>一两条你自己满意的旧作链接（可不填）<textarea rows={2} value={works} onChange={(e) => setWorks(e.target.value)} /></label></div>
      {error && <p className="ob-fail">{error}</p>}
      <div className="ob-actions">
        <button className="btn-ghost" disabled={busy} onClick={skip}>先跳过</button>
        <button className="primary" disabled={busy || !ready} onClick={save}>{busy ? "正在存…" : "存好，下一步"}</button>
      </div>
      {!ready && <p className="ob-hint">前四项都填了才能存；旧作链接可以不填。</p>}
    </>
  );
}
