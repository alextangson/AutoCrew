/**
 * 第 1 步「你想让哪个 AI 来写稿？」（spec §2.2）：本机 AI 卡片（可多选）+ DeepSeek 钥匙 + 收起来的「高级」。
 * 平时只显示不花额度的检测结果；「检测登录」只在点的时候真调一次。
 */
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { invoke } from "../../transport";
import { initialForm, runOnboardingSave } from "../onboarding-lib";
import { AdvancedEndpoint } from "./AdvancedEndpoint";
import { probeHost, type HostId, type HostStatus, type ProbeResult } from "./connect-api";

const WHAT: Record<HostId, string> = {
  claude: "写稿、审稿、发布都在这里做",
  codex: "写稿、审稿、剪辑、发布都能做",
  workbuddy: "在 WorkBuddy 里看稿件进度、让它帮你干活",
};

export const DEEPSEEK_KEY_URL = "https://platform.deepseek.com/api_keys";

function HostCard(props: { h: HostStatus; picked: boolean; onPick: (on: boolean) => void; onDetected: (patch: Partial<HostStatus>) => void }) {
  const { h } = props;
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const usable = h.found && h.loggedIn !== false;
  const check = async () => {
    setProbing(true);
    const r = await probeHost(h.host);
    const result: ProbeResult = r.ok ? r.data : { ok: false, code: "failed", error: r.error };
    setProbe(result);
    // 检测结果回写到上层的宿主状态：之前没登录、现在登录了的卡片当场变成可选（Codex 评审 P2-4）
    if (result.ok) props.onDetected({ loggedIn: true, detail: result.detail });
    else if (result.code === "not_logged_in") props.onDetected({ loggedIn: false, detail: result.error });
    else if (result.code === "not_installed") props.onDetected({ found: false, detail: result.error });
    setProbing(false);
  };
  return (
    // 整张卡就是开关（role=checkbox），不用浏览器原生的蓝色勾选框；空格 / 回车切换
    <div className={`ob-card${props.picked ? " on" : ""}${usable ? "" : " off"}`} data-host={h.host}
      {...(usable ? { role: "checkbox", "aria-checked": props.picked, tabIndex: 0,
        onClick: (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("button, a")) props.onPick(!props.picked); },
        onKeyDown: (e: KeyboardEvent) => { if ((e.key === " " || e.key === "Enter") && e.target === e.currentTarget) { e.preventDefault(); props.onPick(!props.picked); } } } : {})}>
      <div className="ob-card-main">
        {usable ? <span className={`ob-check${props.picked ? " on" : ""}`} aria-hidden="true">{props.picked ? "✓" : ""}</span> : <span className="ob-dot" />}
        <span className="ob-card-name">{h.label}</span>
        {h.host === "claude" && <span className="ob-tag">推荐</span>}
        {h.connected && <span className="ob-tag ok">已接上</span>}
      </div>
      <p className="ob-card-what">{WHAT[h.host]}</p>
      <p className={`ob-card-state${usable && !h.unverified ? "" : " warn"}`}>{probe ? (probe.ok ? probe.detail : probe.error) : h.unverified ? `写进去了但没连上：${h.unverified}，下一步里再试一次` : h.detail}</p>
      {h.found && h.host !== "workbuddy" && (
        <button className="btn-ghost" disabled={probing} onClick={(e) => { e.stopPropagation(); void check(); }}>{probing ? "正在检测…" : "检测登录"}</button>
      )}
    </div>
  );
}

function DeepseekCard(props: { onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setBusy(true);
    const r = await runOnboardingSave(invoke, { ...initialForm(), apiKey: key });
    setBusy(false);
    if (!r.engineSaved) return setMsg({ ok: false, text: r.engineError ?? "没存上" });
    setMsg(r.probeError ? { ok: false, text: `钥匙存好了，但试了一下没通：${r.probeError}` } : { ok: true, text: "钥匙存好了，试过能用" });
    props.onSaved();
  };
  return (
    <div className="ob-card ob-deepseek" data-host="deepseek">
      <div className="ob-card-main"><span className="ob-card-name">DeepSeek</span></div>
      <p className="ob-card-what">可选：深调研、选题雷达、复盘、人设、每日摘要要用你自己的模型钥匙，DeepSeek 最省事</p>
      <div className="ob-key">
        <input type="password" value={key} placeholder="粘贴 DeepSeek 的钥匙" onChange={(e) => setKey(e.target.value)} />
        <button disabled={busy || !key.trim()} onClick={() => void save()}>{busy ? "正在试…" : "保存钥匙"}</button>
      </div>
      <a className="ob-link" href={DEEPSEEK_KEY_URL} target="_blank" rel="noreferrer">去哪拿钥匙</a>
      {msg && <p className={msg.ok ? "ob-ok" : "ob-fail"}>{msg.text}</p>}
    </div>
  );
}

export function PickStep(props: {
  hosts: HostStatus[];
  loadError?: string;
  picked: HostId[];
  setPicked: (p: HostId[]) => void;
  onRefresh: () => void;
  onHostUpdate: (host: HostId, patch: Partial<HostStatus>) => void;
  onNext: () => void;
  onSkip: () => void;
  onEngineSaved: () => void;
  /** 钥匙已经存好：不选本机 AI 也能直接进去 */
  engineReady: boolean;
  onFinish: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const toggle = (h: HostId, on: boolean) => props.setPicked(on ? [...props.picked.filter((x) => x !== h), h] : props.picked.filter((x) => x !== h));
  const missing = props.hosts.some((h) => !h.found);
  return (
    <>
      <h1 className="ob-title">你想让哪个 AI 来写稿？</h1>
      <p className="ob-sub">用你电脑上已经装好的 AI 就行，不用另外准备钥匙。可以选好几个。</p>
      {props.loadError && <p className="ob-fail">没查到这台电脑上装了哪些 AI：{props.loadError}</p>}
      <div className="ob-cards">
        {props.hosts.map((h) => <HostCard key={h.host} h={h} picked={props.picked.includes(h.host)} onPick={(on) => toggle(h.host, on)} onDetected={(patch) => props.onHostUpdate(h.host, patch)} />)}
        <DeepseekCard onSaved={props.onEngineSaved} />
      </div>
      <button className="btn-ghost ob-refresh" onClick={props.onRefresh}>{missing ? "装好了，再找一次" : "再找一次"}</button>
      <button className="btn-ghost ob-advanced-toggle" onClick={() => setAdvanced((v) => !v)}>{advanced ? "收起高级" : "高级：其他中转或 OpenAI 兼容"}</button>
      {advanced && <AdvancedEndpoint onSaved={props.onEngineSaved} />}
      <div className="ob-actions">
        <button className="btn-ghost" onClick={props.onSkip}>先不配</button>
        {props.picked.length > 0
          ? <button className="primary" onClick={props.onNext}>下一步：接上 {props.picked.length} 个</button>
          : props.engineReady
            ? <button className="primary" onClick={props.onFinish}>用 DeepSeek 开工</button>
            : <span className="ob-why">先在上面选一个本机 AI，或存一把 DeepSeek 钥匙</span>}
      </div>
    </>
  );
}
