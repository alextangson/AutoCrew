/**
 * 「高级」：其他中转或 OpenAI 兼容（沿用 P2 §5.1 的端点表单与写盘顺序，见 onboarding-lib）。
 * 探针不通也算存上了（不锁门），只把那句人话摆出来。
 */
import { useState } from "react";
import { invoke } from "../../transport";
import { ENDPOINT_PRESETS, applyPreset, initialForm, presetOf, runOnboardingSave, type EndpointKind, type OnboardingSaveResult } from "../onboarding-lib";

const KINDS = ENDPOINT_PRESETS.filter((p) => p.kind !== "deepseek");

export function AdvancedEndpoint(props: { onSaved: () => void }) {
  const [form, setForm] = useState(() => applyPreset(initialForm(), "claude-relay"));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OnboardingSaveResult | null>(null);
  const preset = presetOf(form.kind);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    const r = await runOnboardingSave(invoke, form);
    setResult(r);
    setBusy(false);
    if (r.engineSaved) props.onSaved();
  };

  return (
    <div className="ob-advanced">
      <div className="ob-kinds">
        {KINDS.map((p) => (
          <label key={p.kind} className={form.kind === p.kind ? "ob-kind on" : "ob-kind"}>
            <input type="radio" name="endpoint-kind" checked={form.kind === p.kind} onChange={() => setForm((f) => applyPreset(f, p.kind as EndpointKind))} />
            <span>{p.label}</span>
          </label>
        ))}
      </div>
      <p className="ob-hint">{preset.hint}</p>
      <label className="field"><span className="field-label">地址</span><input type="text" value={form.baseUrl} placeholder="中转给你的 https 地址" onChange={set("baseUrl")} /></label>
      <label className="field"><span className="field-label">钥匙</span><input type="password" value={form.apiKey} placeholder="粘贴中转给你的钥匙" onChange={set("apiKey")} /></label>
      <div className="ob-pair">
        <label className="field"><span className="field-label">写稿用的模型</span><input type="text" value={form.strong} onChange={set("strong")} /></label>
        <label className="field"><span className="field-label">聊天用的模型</span><input type="text" value={form.fast} onChange={set("fast")} /></label>
      </div>
      {result?.engineError && <p className="ob-fail">{result.engineError}</p>}
      {result?.probeError && <p className="ob-fail">存好了，但试了一下没通：{result.probeError}</p>}
      {result?.engineSaved && !result.probeError && <p className="ob-ok">存好了，试过能用</p>}
      <button disabled={busy} onClick={() => void submit()}>{busy ? "正在试…" : "保存并试一下"}</button>
    </div>
  );
}
