/**
 * 「现在轮到你」· 封面（P6 §13.4-G）：一版一张卡（3:4 + 4:3 并排，新版在前），点「用这一版」直接批准这一对；
 * 点图看大图。都不行就整批打回写原话，Codex 出下一版，旧版留着对比。
 * 平台预览（下一片）从 renderPreview 插进每张版本卡，现在没人传就不显示任何东西。
 */
import { useCallback, useState, type ReactNode } from "react";
import { artifactUrl, RejectInline, RevealLink, when } from "./board-parts";
import {
  approvedVersion, approveFiles, confirmLabel, COVER_RATIOS, coverVersions, missingNote, RATIO_LABEL, versionLabel, viewerOrder,
  type CoverRatio, type CoverVersion,
} from "./cover-board";
import { CoverViewer } from "./CoverViewer";
import { NowTitle } from "./FinalCutStep";
import type { Artifact, ProjectReview } from "./project-board";

type Submit = (payload: Record<string, unknown>) => Promise<boolean>;
/** 平台预览窗口的插槽：拿到一版封面，返回要挂在卡片里的东西 */
export type CoverPreviewSlot = (version: CoverVersion) => ReactNode;

export function CoverStep(props: { review: ProjectReview; contentId: string; busy: boolean; submit: Submit; renderPreview?: CoverPreviewSlot }) {
  const { review, contentId, busy, submit } = props;
  const [viewing, setViewing] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const versions = coverVersions(review.execution?.artifacts ?? []), view = review.gates?.gate4;
  const order = viewerOrder(versions), item = viewing ? order.find((x) => x.artifact.sha256 === viewing) ?? null : null;
  if (viewing && !item) { setViewing(null); setGone(true); }
  const close = useCallback(() => setViewing(null), []);
  const open = useCallback((sha: string) => { setGone(false); setViewing(sha); }, []);
  const folder = <RevealLink contentId={contentId} target="covers_dir" label="打开封面文件夹" />;
  if (versions.length === 0) return <><NowTitle title="Codex 还没交封面" sub="成片已通过，Codex 接着做封面。" />{folder}</>;
  const rejected = view?.status === "rejected", approved = approvedVersion(versions, review.cover_selection, view);
  const labelOf = (v: CoverVersion) => (rejected ? null : confirmLabel(v, approved));
  const approve = (v: CoverVersion) => void submit({ action: "approve", which: "covers", files: approveFiles(v), manifest_hash: review.manifest_hash });
  const reject = (note: string) => submit({ action: "reject", which: "covers", note, artifact_sha256: view?.reject_sha256, manifest_hash: review.manifest_hash });
  const viewed = item ? versions.find((v) => v.version === item.version) ?? null : null;
  return <>
    <NowTitle title={rejected ? "这批封面已打回，等 Codex 出下一版" : approved !== null ? `封面用 ${versionLabel(approved)}` : "挑一版封面"}
      sub={rejected ? `你的原话：「${view?.rejection?.note ?? ""}」` : "点图看大图；登记发布前都能改用别的版本。"} />
    {view?.status === "invalidated" && <p className="pb-warn">封面文件变了，需要重新选一版</p>}
    {gone && <p className="muted">刚才看的那张已经不在了（刷新后被换掉），大图已关。</p>}
    <div className="pb-cover-versions">
      {versions.map((v) => <VersionCard key={v.version} v={v} contentId={contentId} busy={busy} label={labelOf(v)}
        onOpen={open} onConfirm={() => approve(v)} extra={props.renderPreview?.(v)} />)}
    </div>
    <div className="pb-actions">
      <RejectInline busy={busy} label="都不行，打回写原话…" disabled={!view?.reject_sha256 || rejected || view?.status === "approved"} onReject={reject} />
      {folder}
    </div>
    {item && viewed && <CoverViewer contentId={contentId} order={order} item={item} confirm={labelOf(viewed)} busy={busy}
      onMove={open} onClose={close} onConfirm={() => approve(viewed)} />}
  </>;
}

function VersionCard(props: { v: CoverVersion; contentId: string; busy: boolean; label: string | null; onOpen: (sha: string) => void; onConfirm: () => void; extra?: ReactNode }) {
  const { v, label } = props, note = missingNote(v);
  return <section className={"pb-cover-card" + (label === "已选用" ? " is-chosen" : "")}>
    <header><strong>{versionLabel(v.version)}</strong><span className="muted">{when(v.at)}</span></header>
    <div className="pb-cover-pair">
      {COVER_RATIOS.map((r) => <CoverTile key={r} ratio={r} a={v.pair[r]} contentId={props.contentId} onOpen={props.onOpen} />)}
    </div>
    {note && <p className="muted">{note}</p>}
    {label && <button className="primary" disabled={props.busy || label === "已选用"} onClick={props.onConfirm}>{label}</button>}
    {props.extra}
  </section>;
}

function CoverTile(props: { ratio: CoverRatio; a?: Artifact; contentId: string; onOpen: (sha: string) => void }) {
  const { ratio, a } = props;
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const cls = "pb-cover-img r" + ratio.replace(":", "x");
  if (!a) return <div className={cls + " is-empty"}><span className="muted">缺 {RATIO_LABEL[ratio]}</span></div>;
  if (state === "error") return <div className={cls + " is-empty"}><span className="muted">图片读不出来</span><RevealLink contentId={props.contentId} target={a.sha256} /></div>;
  return <button className={cls + (state === "loading" ? " is-loading" : "")} onClick={() => props.onOpen(a.sha256)} aria-label={`看大图 ${RATIO_LABEL[ratio]}`}>
    <img src={artifactUrl(props.contentId, a)} alt={RATIO_LABEL[ratio]} onLoad={() => setState("ok")} onError={() => setState("error")} />
    <span>{RATIO_LABEL[ratio]}</span>
  </button>;
}
