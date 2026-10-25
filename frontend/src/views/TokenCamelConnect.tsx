/**
 * 缺线路时的推荐卡 + 一键连接面板（spec 2026-10-25-tokencamel-touchpoint §3、§4.1）。
 *
 * 卡片固定四样：名字、它是什么（含数据经过哪里）、价格与隐私两个原文链接、「接上 / 不用了」。
 * 点「接上」只是在卡下展开面板：地址只读（预设值），Key 用户自己粘，模型只能从实时 `/models` 里选。
 * 保存走 `settings:engine_attach_preset`（服务端追加，不碰别的端点）；探针失败时「再试一次」只重跑探针，不再写盘。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "../transport";
import { OFFER_COPY, offerGateOpen, preselect, shouldOffer, type OfferPresetView, type OfferState, type OfferTouchpoint } from "./tokencamel-offer";

export interface OfferSnapshot {
  offer: OfferState | null;
  configured: boolean | undefined;
  revision: string;
}

/** 推荐偏好变了（总开关 / 不用了）：通知所有已挂载的 useOfferState 重读——顶栏红点和设置页是两棵树 */
const offerListeners = new Set<() => void>();

/** 写偏好的唯一入口：成功后广播给每个订阅者 */
export async function setOfferPref(payload: { enabled?: boolean; dismiss?: OfferTouchpoint }): Promise<void> {
  const r = await invoke("settings:offer_set", payload);
  if (r.ok) for (const cb of [...offerListeners]) cb();
}

/** 读 settings:get 里的 offer 块 + configured + revision；读不出来就当没有推荐（观测层不报错） */
export function useOfferState(): OfferSnapshot & { reload: () => void; dismiss: (t: OfferTouchpoint) => void } {
  const [snap, setSnap] = useState<OfferSnapshot>({ offer: null, configured: undefined, revision: "" });
  const reload = useCallback(() => {
    void invoke("settings:get").then((r) => {
      if (!r.ok) return;
      const d = (r as unknown as { data?: { offer?: OfferState; configured?: boolean; revision?: string } }).data;
      setSnap({ offer: d?.offer ?? null, configured: d?.configured, revision: d?.revision ?? "" });
    });
  }, []);
  useEffect(() => {
    reload();
    offerListeners.add(reload);
    return () => { offerListeners.delete(reload); };
  }, [reload]);
  const dismiss = useCallback((t: OfferTouchpoint) => void setOfferPref({ dismiss: t }), []);
  return { ...snap, reload, dismiss };
}

function ModelSelect(props: { label: string; models: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">从列表里选一个</option>
        {props.models.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );
}

type Probe = { status: "idle" | "running" | "ok" } | { status: "fail"; error: string };

/** 已保存之后的探针结论：失败时「再试一次」只重跑探针，不再写盘（E10） */
function ProbeLine(props: { probe: Probe; onRetry: () => void }) {
  const p = props.probe;
  if (p.status === "running") return <p className="ob-hint">存好了，正在试…</p>;
  if (p.status === "ok") return <p className="ob-ok">存好了，试过能用</p>;
  if (p.status !== "fail") return null;
  return (
    <>
      <p className="ob-fail">存好了，但试了一下没通：{p.error}</p>
      <button onClick={props.onRetry}>{OFFER_COPY.retryProbe}</button>
    </>
  );
}

function ConnectPanel(props: { mode: "main" | "fallback"; preset: OfferPresetView; revision: string; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [strong, setStrong] = useState("");
  const [fast, setFast] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ providerId: string; model: string } | null>(null);
  const [probe, setProbe] = useState<Probe>({ status: "idle" });

  const listModels = async () => {
    setBusy(true); setError(null);
    const r = await invoke("settings:list_models", { api_key: apiKey });
    setBusy(false);
    if (!r.ok) { setModels([]); return setError(r.error ?? "没读到模型列表"); }
    const list = (r as unknown as { data: { models: string[] } }).data.models;
    setModels(list);
    setStrong(preselect(props.preset.suggest.strong, list));
    setFast(preselect(props.preset.suggest.fast, list));
  };
  const runProbe = async (target: { providerId: string; model: string }) => {
    setProbe({ status: "running" });
    const r = await invoke("settings:test_route", { provider_id: target.providerId, model: target.model });
    setProbe(r.ok ? { status: "ok" } : { status: "fail", error: r.error ?? "端点测试失败，原因未记录" });
  };
  const save = async () => {
    if (busy || saved) return;
    setBusy(true); setError(null);
    const r = await invoke("settings:engine_attach_preset", { as: props.mode, api_key: apiKey, strong, fast, revision: props.revision });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "没保存上");
    const target = { providerId: (r as unknown as { data: { providerId: string } }).data.providerId, model: strong };
    setSaved(target);
    props.onSaved();
    await runProbe(target);
  };

  const labels = props.mode === "main" ? ["写稿用的模型", "聊天用的模型"] : ["备用强模型", "备用快模型"];
  return (
    <div className="ob-advanced tc-panel">
      <label className="field"><span className="field-label">地址</span><input type="text" value={props.preset.baseUrl} readOnly /></label>
      <label className="field">
        <span className="field-label">钥匙</span>
        <input type="password" value={apiKey} disabled={Boolean(saved)} placeholder="粘贴你的 API Key" onChange={(e) => { setApiKey(e.target.value); setModels([]); }} />
      </label>
      <p className="ob-hint"><a href={props.preset.links.keys} target="_blank" rel="noreferrer">{OFFER_COPY.getKey}</a></p>
      {!saved && <button disabled={busy || !apiKey.trim()} onClick={() => void listModels()}>{busy && !models.length ? "正在读取…" : OFFER_COPY.listModels}</button>}
      {models.length > 0 && (
        <div className="ob-pair">
          <ModelSelect label={labels[0]} models={models} value={strong} onChange={setStrong} />
          <ModelSelect label={labels[1]} models={models} value={fast} onChange={setFast} />
        </div>
      )}
      {error && <p className="ob-fail">{error}</p>}
      {props.mode === "fallback" && <p className="ob-hint tc-notice">{OFFER_COPY.fallbackNotice}</p>}
      {!saved && models.length > 0 && <button disabled={busy || !strong || !fast} onClick={() => void save()}>{busy ? "正在保存…" : OFFER_COPY.save}</button>}
      {saved && <ProbeLine probe={probe} onRetry={() => void runProbe(saved)} />}
    </div>
  );
}

/** 推荐卡：披露四样常驻；点「接上」在下面展开连接面板 */
export function TokenCamelOffer(props: {
  touchpoint: OfferTouchpoint;
  preset: OfferPresetView;
  revision: string;
  onDismiss: () => void;
  onSaved: () => void;
  /** 点了「接上」：调用方据此把卡钉住，保存后配置变了也不收起（探针结果与「再试一次」要留在屏幕上） */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const fallback = props.touchpoint === "fallback";
  return (
    <div className="tc-offer" data-offer={props.touchpoint}>
      <p className="ob-hint">{fallback ? OFFER_COPY.leadFallback : OFFER_COPY.leadOnboarding}</p>
      <p><strong>{OFFER_COPY.name}</strong>：{OFFER_COPY.what}</p>
      <p className="ob-hint">{OFFER_COPY.dataFlow}</p>
      <p className="ob-hint">
        <a href={props.preset.links.pricing} target="_blank" rel="noreferrer">{OFFER_COPY.pricing}</a>{" · "}
        <a href={props.preset.links.privacy} target="_blank" rel="noreferrer">{OFFER_COPY.privacy}</a>
      </p>
      {!open && <button onClick={() => { setOpen(true); props.onOpen?.(); }}>{fallback ? OFFER_COPY.attachFallback : OFFER_COPY.attachMain}</button>}{" "}
      <button className="btn-ghost" onClick={props.onDismiss}>{OFFER_COPY.dismiss}</button>
      {open && <ConnectPanel mode={fallback ? "fallback" : "main"} preset={props.preset} revision={props.revision} onSaved={props.onSaved} />}
    </div>
  );
}

/** 设置 · 模型的未配置空态：「添加端点」旁一行小字链接，点开才是推荐卡（已配置就不出） */
export function EmptyStateOffer(props: { snap: OfferSnapshot; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const preset = props.snap.offer?.preset;
  if (!preset || !offerGateOpen("onboarding", props.snap.offer) || !(pinned || shouldOffer("onboarding", props.snap, Date.now()))) return null;
  const dismiss = () => {
    setOpen(false); setPinned(false);
    void setOfferPref({ dismiss: "onboarding" });
  };
  return (
    <div className="tc-empty">
      {!open && <button className="btn-ghost mono" onClick={() => setOpen(true)}>{OFFER_COPY.settingsLink}</button>}
      {open && <TokenCamelOffer touchpoint="onboarding" preset={preset} revision={props.snap.revision} onOpen={() => setPinned(true)} onSaved={props.onSaved} onDismiss={dismiss} />}
    </div>
  );
}

/** 设置 · 模型底部的总开关：关 = 两个触点都不出；从关拨回开 = 清空「不用了」。预设没有任何触点上线时不出 */
export function OfferSwitch(props: { offer: OfferState | null }) {
  const o = props.offer;
  if (!o?.preset || !(o.ready.onboarding || o.ready.fallback)) return null;
  const toggle = () => void setOfferPref({ enabled: !o.enabled });
  return (
    <p className="muted mono tc-switch">
      {OFFER_COPY.switchLabel}：{o.enabled ? "开" : "关"}{" "}
      <button className="btn-ghost" onClick={toggle}>{o.enabled ? "关掉" : "打开"}</button>
    </p>
  );
}
