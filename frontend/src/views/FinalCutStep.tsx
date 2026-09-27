/**
 * 「现在轮到你」· 成片待审（P6 §13.4-F 第 3 步）：成片在剪映里看，这里只放一行文件核对信息和两个动作。
 * 「通过成片」提交的是页面上显示的那个指纹；服务端当场重算，不一致就拒（点击前又导出过）。
 */
import { MovieIcon, RejectInline, RevealLink } from "./board-parts";
import { finalCutMeta, middleEllipsis } from "./board-view";
import type { ProjectReview } from "./project-board";

type Submit = (payload: Record<string, unknown>) => Promise<boolean>;

export function FinalCutStep(props: { review: ProjectReview; contentId: string; busy: boolean; submit: Submit }) {
  const { review, busy, submit } = props, card = review.final_cut, view = review.gates?.gate3;
  if (!card) return <NowTitle title="Codex 还没交成片" sub="在剪映里导出后，Codex 会把它报上来。" />;
  const rejected = view?.status === "rejected";
  const approve = () => void submit({ action: "approve", which: "final_cut", files: [{ path: card.path, sha256: card.sha256 }], manifest_hash: review.manifest_hash });
  const reject = (note: string) => submit({ action: "reject", which: "final_cut", note, artifact_sha256: view?.reject_sha256 ?? card.sha256, manifest_hash: review.manifest_hash });
  return <>
    <NowTitle title={rejected ? "这版已打回，等 Codex 出下一版" : "在剪映里看完这版成片，满意就点通过"}
      sub={rejected ? `你的原话：「${view?.rejection?.note ?? ""}」` : "通过后 Codex 会把它挪进项目的「交付」文件夹，接着做封面。"} />
    {(card.changed || view?.status === "invalidated") && <p className="pb-warn">导出文件变了，需要重新通过</p>}
    <div className="pb-file">
      <MovieIcon />
      <div className="pb-file-text">
        <div className="pb-file-name" title={card.name}>{middleEllipsis(card.name)}</div>
        <div className="pb-file-meta">{card.missing ? "文件找不到了（可能已挪走），等 Codex 报新位置" : finalCutMeta(card)}</div>
      </div>
      <RevealLink contentId={props.contentId} target={card.sha256} />
    </div>
    {!rejected && !card.missing && <div className="pb-actions">
      <button className="primary" disabled={busy || card.changed} onClick={approve}>通过成片</button>
      <RejectInline busy={busy} onReject={reject} />
    </div>}
  </>;
}

export function NowTitle(props: { title: string; sub?: string }) {
  return <>
    <h3 className="pb-now-title">{props.title}</h3>
    {props.sub && <p className="pb-now-sub">{props.sub}</p>}
  </>;
}
