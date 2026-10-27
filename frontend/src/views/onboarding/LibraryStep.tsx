/**
 * 引导「资料放哪」（onboarding-connect §7.2-3）：默认 ~/AutoCrew资料库，可改（NAS 也行），点了当场建好。
 * 路径不合适（O13 非空文件夹、O14 隐私文件夹 / NAS 没挂载）照实说原因，不悄悄换地方；
 * 旧位置有稿（O15）先问搬不搬，搬之前先备份。
 */
import { useEffect, useState } from "react";
import { loadLibrary, setupLibrary, type LibraryStatus, type SetupResult } from "./library-api";

function okMessage(r: SetupResult): string | null {
  const base = okBase(r);
  const later = "afterRestart" in r && r.afterRestart?.length ? ` 注意：${r.afterRestart.join("；")}。` : "";
  return base ? base + later : null;
}

function okBase(r: SetupResult): string | null {
  if (r.status === "created") return `建好了：${r.root}。你自己看的稿在里面的「我的内容」文件夹。`;
  if (r.status === "opened") return `${r.root} 本来就是导演椅资料库，已经接上用。`;
  if (r.status === "already") return `资料库已经在 ${r.root}。`;
  if (r.status === "migrated") return `建好了，旧稿已经搬进去（搬之前的备份在 ${r.backup}）。`;
  if (r.status === "queued_restart") return `旧稿已经备份到 ${r.backup}。搬家要重启一次导演椅才会执行，现在先用着原来的位置。`;
  return null;
}

function LegacyChoice(p: { drafts: number; files?: number; busy: boolean; onPick: (c: "migrate" | "keep") => void }) {
  return (
    <div className="ob-note">
      <p>你在原来的位置已经有 {p.drafts} 篇稿{p.files ? `（共 ${p.files} 个资料文件）` : ""}。要搬进新资料库吗？搬之前会先整份备份。</p>
      <div className="ob-actions ob-top">
        <button className="primary" disabled={p.busy} onClick={() => p.onPick("migrate")}>{p.busy ? "正在处理…" : "搬进去"}</button>
        <button disabled={p.busy} onClick={() => p.onPick("keep")}>不搬，旧稿留在原处</button>
      </div>
    </div>
  );
}

export function LibraryStep(props: { onNext: () => void }) {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadLibrary().then((r) => {
      if (!r.ok) { setError(`读不到资料库状态：${r.error}`); setStatus({ configured: false, root: null, defaultPath: "", legacyDrafts: 0 }); return; }
      setStatus(r.data);
      setPath(r.data.defaultPath);
    });
  }, []);

  const run = async (legacy?: "migrate" | "keep") => {
    if (busy || !path.trim()) return; // 双击只算一次
    setBusy(true); setError(null);
    const r = await setupLibrary(path.trim(), legacy);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setResult(r.data);
  };

  if (!status) return <p className="ob-sub">正在看资料放在哪…</p>;
  const done = result ? okMessage(result) : status.configured ? `资料库已经在 ${status.root}。` : null;
  return (
    <>
      <h1 className="ob-title">资料放哪</h1>
      <p className="ob-sub">稿件、素材、调研都存在一个文件夹里。你自己看的稿在里面的「我的内容」，其余是 AI 干活用的。</p>
      {!done && (
        <div className="ob-key">
          <input aria-label="资料库位置" value={path} disabled={busy} onChange={(e) => { setPath(e.target.value); setResult(null); }} />
        </div>
      )}
      {result?.status === "refused" && (
        <p className="ob-fail">{result.error}{" "}
          {result.suggestion && <button className="btn-ghost ob-inline" onClick={() => { setPath(result.suggestion!); setResult(null); }}>改用 {result.suggestion}</button>}
        </p>
      )}
      {result?.status === "needs_legacy_choice" && <LegacyChoice drafts={result.drafts} {...(result.files ? { files: result.files } : {})} busy={busy} onPick={(c) => void run(c)} />}
      {done && <p className="ob-ok">{done}</p>}
      {error && <p className="ob-fail">没建成：{error}</p>}
      {!done && <p className="ob-hint">以后也能在 设置 → 模型 → 用户资料库 里建；不建就先存在本机的旧位置。</p>}
      <div className="ob-actions">
        {done
          ? <button className="primary" onClick={props.onNext}>下一步</button>
          : <>
              <button className="btn-ghost" disabled={busy} onClick={props.onNext}>以后再说</button>
              {result?.status !== "needs_legacy_choice" && <button className="primary" disabled={busy || !path.trim()} onClick={() => void run()}>{busy ? "正在建…" : "就放这里"}</button>}
            </>}
      </div>
    </>
  );
}
