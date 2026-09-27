/**
 * 成片待审（P6 §13.4-F 第 3 步）：成片在剪映里审，这里不播剪映导出目录里的文件，只列核对信息。
 * 「通过成片」提交的是页面上显示的那个指纹；服务端当场重算，不一致就拒（点击前又导出过）。
 * 挪进项目之后可以在页面里播。
 */
import { openDialog } from "../ui";
import { artifactUrl, GateBadge, when } from "./board-parts";
import { durationLabel, type FinalCutCard, type GateView, type ProjectReview } from "./project-board";

type Submit = (payload: Record<string, unknown>) => Promise<boolean>;

export function FinalCutStep(props: { review: ProjectReview; contentId: string; busy: boolean; submit: Submit }) {
  const card = props.review.final_cut, view = props.review.gates?.gate3;
  if (!card) return <p className="muted">成片（gate3）：还没交上来。在剪映里审完导出后，让 Codex 报给 AutoCrew。</p>;
  return <div style={{ margin: "8px 0" }}>
    <p><strong>成片（gate3）</strong> · <GateBadge view={view} /></p>
    <CardFacts card={card} />
    {card.changed && <p className="vid-warn">导出文件变了，需要重新通过：刷新后再看，或让 Codex 重新报这次导出。</p>}
    {card.missing && <p className="vid-warn">找不到这个文件（挪走了还没报新位置，或被删了）。</p>}
    {!card.external && !card.missing && <video key={card.sha256} src={artifactUrl(props.contentId, card)} controls preload="metadata" style={{ maxWidth: "100%", maxHeight: 480 }} />}
    {card.external && <p className="muted">成片在剪映里审；这里不播放，只核对上面几项再点通过。</p>}
    <Actions {...props} card={card} view={view} />
  </div>;
}

function CardFacts({ card }: { card: FinalCutCard }) {
  return <ul className="muted" style={{ margin: "4px 0", paddingLeft: 18 }}>
    <li>文件：{card.name}{card.external ? "（剪映导出目录）" : "（已在项目里）"}</li>
    <li>时长：{durationLabel(card.duration_ms)} · 导出时间：{when(card.exported_at ?? undefined)}</li>
    <li>剪映草稿：{card.jianying_draft ?? "Codex 没报草稿名"} · 指纹 {card.sha8}</li>
  </ul>;
}

function Actions(props: { review: ProjectReview; busy: boolean; submit: Submit; card: FinalCutCard; view?: GateView }) {
  const { card, view } = props;
  if (view?.status === "approved" || view?.status === "rejected" || card.missing) return null;
  const reject = async () => {
    const r = await openDialog({ title: "打回成片", body: "写给剪辑的原话，Codex 按这个出下一版。", fields: [{ key: "note", label: "原话", multiline: true, required: true }], confirmLabel: "打回" });
    if (!r?.note?.trim()) return;
    await props.submit({ action: "reject", which: "final_cut", note: r.note, artifact_sha256: view?.reject_sha256 ?? card.sha256, manifest_hash: props.review.manifest_hash });
  };
  return <p>
    <button disabled={props.busy || card.changed} onClick={() => void props.submit({ action: "approve", which: "final_cut", files: [{ path: card.path, sha256: card.sha256 }], manifest_hash: props.review.manifest_hash })}>通过成片</button>{" "}
    <button disabled={props.busy} onClick={() => void reject()}>打回</button>
  </p>;
}
