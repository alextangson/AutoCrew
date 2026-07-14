/**
 * 首启引擎闸(frontend-v2):还没接模型就先来这儿粘一个 API Key,存好再进编辑部。
 * 协议 openai/anthropic 由 server 按 key 前缀/base_url 自动识别,UI 不问也不选。
 */
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";

export function Onboarding(props: { onDone: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const canSave = apiKey.trim() !== "" && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const base_url = baseUrl.trim();
    const r = await invoke("settings:set", { api_key: apiKey.trim(), ...(base_url ? { base_url } : {}) });
    if (r.ok) {
      props.onDone();
      return;
    }
    toast(r.error ?? "保存失败,请检查 key 或稍后再试");
    setSaving(false);
  };

  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="onboard-brand serif">AutoCrew 编辑部</div>
        <p className="onboard-welcome muted">欢迎。先接上模型引擎,你的编辑部就能开工了。</p>
        <label className="dlg-field">
          <span className="mono muted">API Key</span>
          <input
            type="password"
            value={apiKey}
            placeholder="DeepSeek key 或 Claude 中转 key 都行"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label className="dlg-field">
          <span className="mono muted">Base URL(可选)</span>
          <input
            type="text"
            value={baseUrl}
            placeholder="https://api.deepseek.com"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <p className="onboard-hint mono muted">协议(OpenAI / Anthropic)会根据 key 自动识别,无需选择。</p>
        <button className="primary" disabled={!canSave} onClick={() => void save()}>
          {saving ? "保存中…" : "保存并进入"}
        </button>
      </div>
    </div>
  );
}
