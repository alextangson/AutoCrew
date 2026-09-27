/**
 * 「现在轮到你」· 封面（P6 §13.4-G）：每个尺寸一排缩略图（新版在前），点一张选中，两边都选了才能「通过这两张」。
 * 打回带原话，Codex 出下一批 vNN+1，旧版留着对比。视频稿不调 cover:create / cover:revise。
 */
import { artifactUrl, RejectInline, RevealLink } from "./board-parts";
import { COVER_RATIOS, coverApproveBlock, coverGroups, selectedCover } from "./cover-board";
import { NowTitle } from "./FinalCutStep";
import type { ProjectReview } from "./project-board";

type Submit = (payload: Record<string, unknown>) => Promise<boolean>;
const RATIO_LABEL = { "3:4": "3:4 竖版", "4:3": "4:3 横版" } as const;

export function CoverStep(props: { review: ProjectReview; contentId: string; busy: boolean; submit: Submit }) {
  const { review, contentId, busy, submit } = props;
  const groups = coverGroups(review.execution?.artifacts ?? []), view = review.gates?.gate4;
  const folder = <RevealLink contentId={contentId} target="covers_dir" label="打开封面文件夹" />;
  if (COVER_RATIOS.every((r) => groups[r].length === 0)) return <><NowTitle title="Codex 还没交封面" sub="成片已通过，Codex 接着做封面。" />{folder}</>;
  const block = coverApproveBlock(groups, review.cover_selection), rejected = view?.status === "rejected";
  const approve = () => {
    const files = COVER_RATIOS.map((r) => selectedCover(groups, review.cover_selection, r)!).map((a) => ({ path: a.path, sha256: a.sha256 }));
    void submit({ action: "approve", which: "covers", files, manifest_hash: review.manifest_hash });
  };
  const reject = (note: string) => submit({ action: "reject", which: "covers", note, artifact_sha256: view?.reject_sha256, manifest_hash: review.manifest_hash });
  return <>
    <NowTitle title={rejected ? "这批封面已打回，等 Codex 出下一批" : "每个尺寸挑一张封面"} sub={rejected ? `你的原话：「${view?.rejection?.note ?? ""}」` : undefined} />
    {view?.status === "invalidated" && <p className="pb-warn">封面文件变了，需要重新通过</p>}
    {COVER_RATIOS.map((ratio) => <div key={ratio} className="pb-cover-row">
      <div className="pb-cover-label">{RATIO_LABEL[ratio]}</div>
      {groups[ratio].length === 0 ? <p className="muted">Codex 还没交 {RATIO_LABEL[ratio]}</p> : <div className="pb-cover-tiles">
        {groups[ratio].map((a) => {
          const chosen = selectedCover(groups, review.cover_selection, ratio)?.sha256 === a.sha256;
          return <button key={a.sha256} className={"pb-tile" + (chosen ? " is-chosen" : "")} disabled={busy} aria-pressed={chosen}
            onClick={() => void submit({ action: "select_cover", ratio, sha256: a.sha256 })}>
            <img src={artifactUrl(contentId, a)} alt={`${ratio} v${a.version ?? "?"}`} />
            <span>v{String(a.version ?? "?").padStart(2, "0")}{chosen ? " · 已选" : ""}</span>
          </button>;
        })}
      </div>}
    </div>)}
    {view?.status !== "approved" && <div className="pb-actions">
      {block ? <span className="muted">{block}</span> : <button className="primary" disabled={busy} onClick={approve}>通过这两张</button>}
      <RejectInline busy={busy} disabled={!view?.reject_sha256 || rejected} onReject={reject} />
      {folder}
    </div>}
  </>;
}
