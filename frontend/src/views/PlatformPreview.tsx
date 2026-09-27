/** 「在平台上看看」：页面内浮层，每个平台一个小标签，各位置装进手机/浏览器外壳（规格见 platform-preview.ts） */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke } from "../transport";
import { routeHash } from "../routes";
import { versionLabel, type CoverVersion } from "./cover-board";
import {
  activeTab, durationBadge, NUMBERS_NOTE, previewSections, profilePlatformsOf, SHELL_NOTE, stepTab,
  type PlatformId, type PlatformSection,
} from "./platform-preview";
import { SurfaceStage } from "./PreviewFrames";
import type { Mock } from "./PreviewCards";

type Load = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; platforms: string[] };

export function PlatformPreview(props: { contentId: string; v: CoverVersion; title: string; durationMs?: number | null; onClose: () => void }) {
  const { onClose } = props;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const fetchProfile = useCallback(async () => {
    setLoad({ state: "loading" });
    const r = await invoke("onboarding:status");
    const p = profilePlatformsOf(r);
    setLoad(p ? { state: "ok", platforms: p } : { state: "error", error: r.error ?? "账号资料读不出来" });
  }, []);
  useEffect(() => { void fetchProfile(); }, [fetchProfile]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const mock: Mock = { contentId: props.contentId, v: props.v, title: props.title, duration: durationBadge(props.durationMs) };
  return <div className="pb-viewer pp-overlay" role="dialog" aria-modal="true" aria-label="在平台上看看" onClick={onClose}>
    <div className="pp-body" onClick={(e) => e.stopPropagation()}>
      <header className="pp-head">
        <strong>{versionLabel(props.v.version)} 在平台上的样子</strong>
        <button className="pb-link" onClick={onClose}>关闭</button>
      </header>
      <p className="muted">{SHELL_NOTE}</p>
      <p className="muted">{NUMBERS_NOTE}</p>
      <PreviewBody load={load} mock={mock} retry={fetchProfile} />
    </div>
  </div>;
}

function PreviewBody({ load, mock, retry }: { load: Load; mock: Mock; retry: () => void }) {
  if (load.state === "loading") return <p className="muted">正在读账号资料…</p>;
  if (load.state === "error") return <p className="pb-warn">账号资料读不出来：{load.error} <button className="pb-link" onClick={retry}>重试</button></p>;
  const sections = previewSections(load.platforms);
  if (sections.length === 0) return <p>账号资料里没勾选视频平台。<a href={routeHash({ view: "calibration" })}>去品牌校准里勾选</a></p>;
  return <PlatformTabs sections={sections} mock={mock} />;
}

/** 选中的标签存在组件里：浮层开着（含看板 15 秒刷新）就一直记得 */
function PlatformTabs({ sections, mock }: { sections: PlatformSection[]; mock: Mock }) {
  const [chosen, setChosen] = useState<PlatformId | null>(null);
  const tabRefs = useRef(new Map<PlatformId, HTMLButtonElement>());
  const ids = sections.map((s) => s.id), current = activeTab(ids, chosen)!;
  const s = sections.find((x) => x.id === current)!;
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = stepTab(ids, current, e.key === "ArrowRight" ? 1 : -1);
    setChosen(next);
    tabRefs.current.get(next)?.focus();
  };
  return <>
    <div className="pp-tabs" role="tablist" aria-label="平台" onKeyDown={onKey}>
      {sections.map((x) => <button key={x.id} role="tab" aria-selected={x.id === current} tabIndex={x.id === current ? 0 : -1}
        className={"pp-tab" + (x.id === current ? " is-on" : "")} onClick={() => setChosen(x.id)}
        ref={(el) => { if (el) tabRefs.current.set(x.id, el); else tabRefs.current.delete(x.id); }}>{x.label}</button>)}
    </div>
    <section role="tabpanel" aria-label={s.label} className={"pp-platform" + (s.verified ? "" : " is-unverified")}>
      {s.badge && <p><span className="pp-badge">{s.badge}</span></p>}
      {s.notes.map((n) => <p key={n} className="muted">{n}</p>)}
      <div className="pp-surfaces">{s.surfaces.map((x) => <SurfaceStage key={x.id} platform={s.id} x={x} mock={mock} />)}</div>
    </section>
  </>;
}
