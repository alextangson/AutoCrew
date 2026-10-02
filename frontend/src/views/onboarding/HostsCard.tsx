/**
 * 设置 · 接入更多 ·「宿主」（onboarding-connect §3）：每个宿主一行——接上 / 断开 / 状态。
 * 与引导页、`autocrew connect` 同一套实现；令牌值不进这个组件。
 * 不在三家里的命名令牌（如 dsh）照旧列出来，只能撤销。
 */
import { useEffect, useState } from "react";
import { invoke } from "../../transport";
import { confirmDialog, toast } from "../../ui";
import { relativeTime } from "../engine-lib";
import { hostLabel } from "../host-badge";
import { asResult, connectHost, disconnectHost, loadConnect, type ConnectResult, type HostId, type HostStatus } from "./connect-api";

interface TokenView { host: string; createdAt: string; lastUsedAt?: string }
const OWN_TOKENS = new Set(["claude-code", "codex", "workbuddy"]);

function HostRow(props: { h: HostStatus; reload: () => void }) {
  const { h } = props;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectResult | null>(null);
  const act = async (verb: "connect" | "disconnect") => {
    if (busy) return;
    if (verb === "disconnect") {
      const ok = await confirmDialog({
        title: `断开 ${h.label}？`,
        body: `会从 ${h.label} 的配置里删掉 AutoCrew（先留备份），并撤销它的令牌：它正在做的事会当场断掉，之后再调用会被拒绝。想再接回来点「接上」就行。`,
        confirmLabel: "断开",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    const r = asResult(h.host, verb === "connect" ? await connectHost(h.host) : await disconnectHost(h.host));
    setBusy(false);
    setResult(r);
    props.reload();
  };
  const now = Date.now();
  const state = h.connected
    ? (h.lastUsedAt ? `已接上 · ${relativeTime(h.lastUsedAt, now)}用过` : "已接上 · 还没用过")
    : h.unverified ? `写进去了但没连上：${h.unverified}` : h.detail;
  return (
    <div className="row" data-host={h.host}>
      <span className="row-title">{h.label}</span>
      <span className="muted">{state}</span>
      {h.connected
        ? <button className="btn-ghost" disabled={busy} onClick={() => void act("disconnect")}>{busy ? "正在断开…" : "断开"}</button>
        : h.found && <button disabled={busy || h.loggedIn === false} onClick={() => void act("connect")}>{busy ? "正在接…" : h.unverified ? "再试一次" : "接上"}</button>}
      {result && <p className={result.ok && (result.verified || !result.registered) ? "set-test-ok" : "set-test-fail"}>{result.ok ? result.message : result.error ?? result.message}</p>}
    </div>
  );
}

export function HostsCard() {
  const [hosts, setHosts] = useState<HostStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [others, setOthers] = useState<TokenView[]>([]);
  const load = async () => {
    const [c, t] = await Promise.all([loadConnect(), invoke("hosts:list")]);
    if (c.ok) { setHosts(c.data.hosts); setError(null); } else setError(c.error);
    if (t.ok) setOthers(((t as unknown as { data?: { hosts?: TokenView[] } }).data?.hosts ?? []).filter((x) => !OWN_TOKENS.has(x.host)));
  };
  useEffect(() => { void load(); }, []);
  const revoke = async (host: string) => {
    if (!(await confirmDialog({ title: `撤销 ${hostLabel(host)} 的令牌？`, body: `${host} 之后的每一次调用都会被拒绝，正在做的事会当场断掉。`, confirmLabel: "撤销", danger: true }))) return;
    const r = await invoke("hosts:revoke", { host });
    toast(r.ok ? String((r as { message?: string }).message ?? "已撤销") : (r.error ?? "撤销失败"));
    void load();
  };
  const connected = hosts?.filter((h) => h.connected).length ?? 0;
  return (
    <section className="set-zone" data-zone="hosts">
      <div className="set-head">
        <h3 className="serif set-title">宿主 · Claude Code / Codex / WorkBuddy</h3>
        <span className="chip">{hosts ? (connected ? `${connected} 个已接上` : "还没接") : "…"}</span>
      </div>
      <p className="muted int-line">让你电脑上的 AI 直接用 AutoCrew：Claude Code 写稿、审稿、发布；Codex 当剪辑工位（登记成片和素材，其余只看不改）；WorkBuddy 看进度、帮你干活。</p>
      {error && <p className="set-test-fail">没查到宿主状态：{error}</p>}
      {hosts?.map((h) => <HostRow key={h.host} h={h} reload={() => void load()} />)}
      {others.map((t) => (
        <div key={t.host} className="row">
          <span className="row-title">{hostLabel(t.host)}</span>
          <span className="muted">{t.lastUsedAt ? `${relativeTime(t.lastUsedAt, Date.now())}用过` : "还没用过"}</span>
          <button className="btn-ghost" onClick={() => void revoke(t.host)}>撤销</button>
        </div>
      ))}
      <p className="muted int-line">命令行也行：<code>npx autocrew connect claude</code>（或 codex / workbuddy），<code>npx autocrew connect --list</code> 看谁接上了。</p>
    </section>
  );
}
