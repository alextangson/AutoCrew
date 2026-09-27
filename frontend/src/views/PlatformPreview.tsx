/** 「在平台上看看」：页面内浮层，把一版封面按各平台的真实位置摆出来（规格见 platform-preview.ts） */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "../transport";
import { routeHash } from "../routes";
import { artifactUrl } from "./board-parts";
import { versionLabel, type CoverVersion } from "./cover-board";
import {
  centerCrop, durationBadge, NUMBERS_NOTE, previewSections, profilePlatformsOf, ratioValue, surfaceImage,
  type PlatformSection, type Surface,
} from "./platform-preview";

type Mock = { contentId: string; v: CoverVersion; title: string; duration: string | null };
type Load = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; platforms: string[] };
const NAME = "你的账号";

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
  return <>{sections.map((s) => <PlatformBlock key={s.id} s={s} mock={mock} />)}</>;
}

function PlatformBlock({ s, mock }: { s: PlatformSection; mock: Mock }) {
  return <section className={"pp-platform" + (s.verified ? "" : " is-unverified")}>
    <h3>{s.label}{s.badge && <span className="pp-badge">{s.badge}</span>}</h3>
    {s.notes.map((n) => <p key={n} className="muted">{n}</p>)}
    <div className="pp-surfaces">{s.surfaces.map((x) => <figure key={x.id} className="pp-surface">
      <figcaption>{x.label}</figcaption><SurfaceCard x={x} mock={mock} />
    </figure>)}</div>
  </section>;
}

const WIDTH: Record<Surface["style"], number> = { feed: 170, grid: 150, "bili-web": 260, row: 120 };

function SurfaceCard({ x, mock }: { x: Surface; mock: Mock }) {
  const img = surfaceImage(x, mock.v), width = WIDTH[x.style];
  // B站网页卡：整张 4:3 摆出来，上下标出会被裁掉的条，叠加元素只画在留下的 16:9 里
  const frameRatio = x.style === "bili-web" ? ratioValue(x.cover) : x.ratio;
  if ("missing" in img) return <div className="pp-frame is-missing" style={{ width, aspectRatio: String(frameRatio) }}><span>{img.missing}</span></div>;
  const pic = <img src={artifactUrl(mock.contentId, img.artifact)} alt={x.label} />;
  if (x.style === "bili-web") return <BiliWebCard x={x} mock={mock} width={width}>{pic}</BiliWebCard>;
  if (x.style === "row") return <div className="pp-row"><div className="pp-frame" style={{ width, aspectRatio: String(x.ratio) }}>{pic}</div><Title text={mock.title} /></div>;
  if (x.style === "grid") return <div className="pp-frame" style={{ width, aspectRatio: String(x.ratio) }}>{pic}
    <div className="pp-shade" style={{ height: "20%", background: "linear-gradient(transparent, rgba(0,0,0,0.5))" }} />
    <span className="pp-on-img pp-bl">▷ 1.2万</span>
  </div>;
  return <div className="pp-card" style={{ width }}>
    <div className="pp-frame" style={{ aspectRatio: String(x.ratio) }}>{pic}
      {x.playTopRight && <span className="pp-on-img pp-tr">▶</span>}
      {x.playStats && <><div className="pp-shade" style={{ height: "26%", background: "linear-gradient(transparent, rgba(0,0,0,0.8))" }} /><span className="pp-on-img pp-bl">▷ 1.2万 · 弹幕 356</span></>}
    </div>
    <Title text={mock.title} /><Author right="♡ 1024" />
  </div>;
}

function BiliWebCard({ x, mock, width, children }: { x: Surface; mock: Mock; width: number; children: ReactNode }) {
  const { keptHeight, cutEach } = centerCrop(ratioValue(x.cover), x.ratio), pct = (n: number) => `${n * 100}%`;
  const band = (pos: CSSProperties) => <div className="pp-cut" style={{ ...pos, height: pct(cutEach) }}>被裁掉</div>;
  return <div className="pp-card" style={{ width }}>
    <div className="pp-frame" style={{ aspectRatio: String(ratioValue(x.cover)) }}>{children}
      {band({ top: 0 })}{band({ bottom: 0 })}
      <div className="pp-kept" style={{ top: pct(cutEach), height: pct(keptHeight) }}>
        <div className="pp-shade" style={{ height: "26%", background: "linear-gradient(transparent, rgba(0,0,0,0.8))" }} />
        <span className="pp-on-img pp-bl">▷ 1.2万 · 弹幕 356</span>
        {mock.duration && <span className="pp-on-img pp-br">{mock.duration}</span>}
      </div>
    </div>
    <Title text={mock.title} /><Author right="9-27" />
  </div>;
}

const Title = ({ text }: { text: string }) => <p className="pp-title" title={text}>{text}</p>;
const Author = ({ right }: { right: string }) => <div className="pp-author"><span className="pp-avatar" />{NAME}<span className="pp-right">{right}</span></div>;
