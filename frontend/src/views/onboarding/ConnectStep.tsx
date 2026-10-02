/**
 * 第 2 步「接上」（spec §2.3 / §3）：每个选中的宿主一行「一键接上」。
 * 结果照实摆：核对过能连上才打勾；写进去但没核对上、没写成，都给原因 + 再试一次。
 * 替换了原来的 autocrew 配置时，结果里那句「备份在 …」原样显示（O7）。
 *
 * 按钮（review-inbox §4.2，一屏一个主按钮、写后果）：
 * - 还没全部有结果：选了一个 → 那一行的「一键接上」是主按钮；选了几个 → 顶部「全部接上」是主按钮，行内是次按钮；
 *   「先跳过，进去看看」是少用按钮。
 * - 全部有结果（接上或带原因失败）：底部主按钮「好了，进去看看」。
 */
import { useState } from "react";
import { asResult, connectHost, type ConnectResult, type HostId, type HostStatus } from "./connect-api";

export function ConnectRow(props: { h: HostStatus; result?: ConnectResult; busy: boolean; primary: boolean; onRun: () => void }) {
  const r = props.result;
  const state = !r ? "" : r.ok && r.verified ? "ok" : "fail";
  return (
    <div className={`ob-row ${state}`} data-host={props.h.host}>
      <div className="ob-row-head">
        <span className="ob-card-name">{props.h.label}</span>
        {state === "ok" && <span className="ob-tag ok">已接上</span>}
        <span className="ob-row-spacer" />
        {state !== "ok" && (
          <button className={props.primary ? "primary" : undefined} disabled={props.busy} onClick={props.onRun}>
            {props.busy ? "正在接…" : r ? "再试一次" : "一键接上"}
          </button>
        )}
      </div>
      {r && <p className={state === "ok" ? "ob-ok" : "ob-fail"}>{r.ok ? r.message : r.error ?? r.message}</p>}
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
  const [busy, setBusy] = useState<Set<HostId>>(new Set());
  const rows = props.hosts.filter((h) => props.picked.includes(h.host));
  const settled = rows.every((h) => props.results[h.host]);
  const pending = rows.filter((h) => !props.results[h.host]?.verified);
  const many = rows.length > 1;

  const run = async (host: HostId) => {
    if (busy.has(host)) return; // 双击只算一次
    setBusy((b) => new Set(b).add(host));
    props.onResult(asResult(host, await connectHost(host)));
    setBusy((b) => { const n = new Set(b); n.delete(host); return n; });
  };
  const runAll = async () => {
    for (const h of pending) await run(h.host);
  };

  return (
    <>
      <h1 className="ob-title">接上</h1>
      <p className="ob-sub">点一下，AutoCrew 就出现在它的工具里。改它的配置之前会先留一份备份。</p>
      {many && !settled && (
        <div className="ob-actions ob-top">
          <button className="primary" disabled={busy.size > 0} onClick={() => void runAll()}>{busy.size > 0 ? "正在接…" : "全部接上"}</button>
        </div>
      )}
      <div className="ob-rows">
        {rows.map((h) => (
          <ConnectRow key={h.host} h={h} result={props.results[h.host]} busy={busy.has(h.host)}
            primary={!many && !settled} onRun={() => void run(h.host)} />
        ))}
      </div>
      <div className="ob-actions">
        <button className="btn-ghost" onClick={props.onBack}>上一步</button>
        {settled
          ? <button className="primary" onClick={props.onNext}>好了，进去看看</button>
          : <button className="btn-ghost" onClick={props.onNext}>先跳过，进去看看</button>}
      </div>
    </>
  );
}
