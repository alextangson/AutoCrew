/** 设置页「更新」一栏（self-update §2）：当前版本、上次检查、检查更新、自动检查开关；检查失败的原因只在这里写。 */
import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { Section } from "./settings-kit";
import { checkNow, loadUpdate, saveUpdateSettings, type UpdateView } from "./update/update-api";

export function statusLine(v: UpdateView): string {
  const s = v.status;
  if (!s) return "还没检查过";
  const at = new Date(s.checkedAt).toLocaleString();
  if (s.error) return `上次检查 ${at} 没查成：${s.error}`;
  if (v.banner) return `上次检查 ${at}：有新版本 ${v.banner.version}，看板顶上可以更新`;
  if (s.available && v.settings.skipVersion === s.latest) return `上次检查 ${at}：${s.latest} 你选了先不更新`;
  if (s.reason === "local_ahead") return `上次检查 ${at}：本地程序比最新发布版还新，不提示更新`;
  if (s.reason === "diverged") return `上次检查 ${at}：本地程序和最新发布版 ${s.latest ?? ""} 分叉了（本地有发布版里没有的提交），没法自动更新；请按 README 手动更新`;
  return `上次检查 ${at}：已经是最新版`;
}

export function SettingsUpdate(props: { initial?: UpdateView }) {
  const [view, setView] = useState<UpdateView | null>(props.initial ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.initial) return;
    void loadUpdate().then((r) => (r.ok ? setView(r.data) : setError(r.error)));
  }, [props.initial]);
  const apply = async (p: Promise<{ ok: true; data: UpdateView } | { ok: false; error: string }>) => {
    setBusy(true);
    try { const r = await p; if (r.ok) { setView(r.data); setError(""); } else setError(r.error); } finally { setBusy(false); }
  };
  const version = view ? `版本 ${view.current}${view.currentDate ? ` · ${view.currentDate}` : ""}` : "";
  return <Section title="更新" status={version} on>
    {view && <p className={view.status?.error ? "" : "muted"} role={view.status?.error ? "alert" : undefined}>{statusLine(view)}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="upd-row">
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void apply(checkNow())}>{busy ? "检查中…" : "检查更新"}</Button>
      {view && <label><input type="checkbox" checked={view.settings.autoCheck} disabled={busy}
        onChange={(e) => void apply(saveUpdateSettings({ auto_check: e.target.checked }))} />自动检查更新（每天一次）</label>}
    </div>
  </Section>;
}
