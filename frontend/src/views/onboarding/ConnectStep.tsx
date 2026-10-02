/**
 * 第 2 步「接上」（spec §2.3 / §3）：每个选中的宿主一行「一键接上」。
 * 结果照实摆：核对过能连上才打勾；写进去但没核对上、没写成，都给原因 + 再试一次。
 * 替换了原来的 autocrew 配置时，结果里那句「备份在 …」原样显示（O7）。
 */
import { useState } from "react";
import { asResult, connectHost, type ConnectResult, type HostId, type HostStatus } from "./connect-api";

export function ConnectRow(props: { h: HostStatus; result?: ConnectResult; onResult: (r: ConnectResult) => void }) {
  const [busy, setBusy] = useState(false);
  const r = props.result;
  const run = async () => {
    if (busy) return; // 双击只算一次
    setBusy(true);
    props.onResult(asResult(props.h.host, await connectHost(props.h.host)));
    setBusy(false);
  };
  const state = !r ? "" : r.ok && r.verified ? "ok" : "fail";
  return (
    <div className={`ob-row ${state}`} data-host={props.h.host}>
      <div className="ob-row-head">
        <span className="ob-card-name">{props.h.label}</span>
        {state === "ok" && <span className="ob-tag ok">已接上</span>}
        <span className="ob-row-spacer" />
        {state !== "ok" && <button disabled={busy} onClick={() => void run()}>{busy ? "正在接…" : r ? "再试一次" : "一键接上"}</button>}
      </div>
      {r && <p className={state === "ok" ? "ob-ok" : "ob-fail"}>{r.ok && !r.verified ? `${r.message}` : r.ok ? r.message : r.error ?? r.message}</p>}
    </div>
  );
}

export function ConnectStep(props: {
  hosts: HostStatus[];
  picked: HostId[];
  results: Partial<Record<HostId, ConnectResult>>;
  onResult: (r: ConnectResult) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const rows = props.hosts.filter((h) => props.picked.includes(h.host));
  const anyOk = rows.some((h) => props.results[h.host]?.verified);
  return (
    <>
      <h1 className="ob-title">接上</h1>
      <p className="ob-sub">点一下，AutoCrew 就出现在它的工具里。改它的配置之前会先留一份备份。</p>
      <div className="ob-rows">
        {rows.map((h) => <ConnectRow key={h.host} h={h} result={props.results[h.host]} onResult={props.onResult} />)}
      </div>
      <div className="ob-actions">
        <button className="btn-ghost" onClick={props.onBack}>上一步</button>
        <button className="primary" onClick={props.onNext}>{anyOk ? "好了" : "先跳过，进去看看"}</button>
      </div>
    </>
  );
}
