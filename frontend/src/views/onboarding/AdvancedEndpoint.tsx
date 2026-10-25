/**
 * 「高级」：其他中转或 OpenAI 兼容（沿用 P2 §5.1 的端点表单与写盘顺序，见 onboarding-lib）。
 * 探针不通也算存上了（不锁门），只把那句人话摆出来。
 */
import { useState } from "react";
import { invoke } from "../../transport";
import { ENDPOINT_PRESETS, applyPreset, initialForm, presetOf, runOnboardingSave, type EndpointKind, type OnboardingSaveResult } from "../onboarding-lib";
import { TokenCamelOffer, useOfferState } from "../TokenCamelConnect";
import { offerGateOpen, shouldOffer } from "../tokencamel-offer";

const KINDS = ENDPOINT_PRESETS.filter((p) => p.kind !== "deepseek");

export function AdvancedEndpoint(props: { onSaved: () => void }) {
  const [form, setForm] = useState(() => applyPreset(initialForm(), "claude-relay"));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OnboardingSaveResult | null>(null);
  const preset = presetOf(form.kind);
  // 第三方中转（spec 2026-10-25 触点 A）：排在列表最后、从不预选；选中时换成它自己的连接面板
  const offer = useOfferState();
  const [camel, setCamel] = useState(false);
  const [pinned, setPinned] = useState(false);
  const showCamel = offerGateOpen("onboarding", offer.offer) && (pinned || shouldOffer("onboarding", offer, Date.now()));
  const pickKind = (kind: EndpointKind) => { setCamel(false); setForm((f) => applyPreset(f, kind)); };
  const pickCamel = () => { setCamel(true); setForm((f) => ({ ...f, apiKey: "" })); };
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
          <label key={p.kind} className={!camel && form.kind === p.kind ? "ob-kind on" : "ob-kind"}>
            <input type="radio" name="endpoint-kind" checked={!camel && form.kind === p.kind} onChange={() => pickKind(p.kind as EndpointKind)} />
            <span>{p.label}</span>
          </label>
        ))}
        {showCamel && offer.offer?.preset && (
          <label className={camel ? "ob-kind on" : "ob-kind"}>
            <input type="radio" name="endpoint-kind" checked={camel} onChange={pickCamel} />
            <span>{offer.offer.preset.name}</span>
          </label>
        )}
      </div>
      {camel && offer.offer?.preset ? (
        <TokenCamelOffer
          touchpoint="onboarding"
          preset={offer.offer.preset}
          revision={offer.revision}
          onOpen={() => setPinned(true)}
          onSaved={props.onSaved}
          onDismiss={() => { setCamel(false); setPinned(false); offer.dismiss("onboarding"); }}
        />
      ) : (<>
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
      </>)}
    </div>
  );
}
