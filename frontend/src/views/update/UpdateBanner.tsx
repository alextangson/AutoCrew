/**
 * 看板最上方的版本提醒（self-update §2-5、§3-9）：一行安静的提示，「看看更新了什么」就地展开，
 * 「更新」先就地写明后果再确认；更新中盖一层「AutoCrew 正在更新」，服务回来后自动刷新。
 */
import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { loadUpdate, saveUpdateSettings, startUpdate, waitBack, type ReleaseNotes, type UpdateView } from "./update-api";
import "./update.css";

export function NotesList(props: { notes: ReleaseNotes[] }) {
  if (!props.notes.length) return <p className="muted">这一版没写更新说明。</p>;
  return <>{props.notes.map((n) => <div key={n.version} className="upd-notes">
    <h4>{n.version} · {n.date}</h4>
    {n.todo.length > 0 && <div className="upd-todo" role="note"><strong>需要你做的</strong><ul>{n.todo.map((t) => <li key={t}>{t}</li>)}</ul></div>}
    {n.news.length > 0 && <><strong>新东西</strong><ul>{n.news.map((t) => <li key={t}>{t}</li>)}</ul></>}
    {n.fixes.length > 0 && <><strong>修好的</strong><ul>{n.fixes.map((t) => <li key={t}>{t}</li>)}</ul></>}
  </div>)}</>;
}

export function UpdatingOverlay(props: { stalled: boolean; log?: string }) {
  // 卡住了也不叫人重启：重启会打断还在跑的更新（第 12 轮 P2）；页面照样接着等，服务回来就自动刷新
  return <div className="upd-overlay" role="alertdialog" aria-label="正在更新">
    <div className="upd-overlay-card">
      <h3>AutoCrew 正在更新，大约 1 分钟</h3>
      <p className="muted">{props.stalled
        ? "服务已经 5 分钟连不上了。更新可能还在进行，先别手动重启，这一页会一直等它回来。"
        : "更新完会自动刷新这一页，不用动。网慢时装依赖要多等几分钟。"}</p>
      {props.log && <p className="muted">完整记录：{props.log}</p>}
    </div>
  </div>;
}

export function UpdateBanner(props: { initial?: UpdateView | null; reload?: () => void }) {
  const [view, setView] = useState<UpdateView | null>(props.initial ?? null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState<"no" | "yes" | "stalled">("no");
  const [log, setLog] = useState("");
  // 后台检查（启动 1 分钟后、之后每天）的结果要自己冒出来：每分钟重读一次本机状态，切回这个标签页时也读（Codex 审 P2）
  useEffect(() => {
    const read = () => void loadUpdate().then((r) => { if (r.ok) setView(r.data); });
    if (props.initial === undefined) read();
    const timer = window.setInterval(read, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [props.initial]);
  const watch = async () => {
    setUpdating("yes");
    await waitBack({ onState: (s) => setUpdating(s === "stalled" ? "stalled" : "yes") });
    (props.reload ?? (() => window.location.reload()))();
  };
  useEffect(() => { if (view?.running && updating === "no") void watch(); }, [view?.running]);
  if (updating !== "no") return <UpdatingOverlay stalled={updating === "stalled"} {...(log ? { log } : {})} />;
  const banner = view?.banner;
  if (!banner) return null;
  const go = async () => {
    setError("");
    const r = await startUpdate();
    if (!r.ok) { setConfirming(false); return setError(r.error); }
    setLog(r.data.log);
    void watch();
  };
  const skip = async () => {
    const r = await saveUpdateSettings({ skip_version: banner.version });
    if (r.ok) setView(r.data); else setError(r.error);
  };
  return <div className="upd-banner" role="status">
    <div className="upd-row">
      <span>有新版本 {banner.version}</span>
      <Button variant="quiet" size="sm" onClick={() => setOpen((v) => !v)}>{open ? "收起" : "看看更新了什么"}</Button>
      {!confirming && <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>更新</Button>}
    </div>
    {confirming && <div className="upd-confirm">
      <span>更新时 AutoCrew 会重启，大约 1 分钟，这期间页面用不了；出问题会自动退回现在的版本。</span>
      <Button variant="primary" size="sm" onClick={() => void go()}>开始更新</Button>
      <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>先不</Button>
    </div>}
    {error && <p className="upd-error" role="alert">{error}</p>}
    {open && <div className="upd-detail">
      <NotesList notes={banner.notes} />
      <Button variant="quiet" size="sm" onClick={() => void skip()}>这个版本先不更新</Button>
    </div>}
  </div>;
}
