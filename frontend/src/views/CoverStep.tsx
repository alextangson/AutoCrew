/**
 * 看板的封面步（P6 §13.4-G）：左边是已进项目的成片，右边按 3:4 / 4:3 分组列出 Codex 交来的各版封面。
 * 每个尺寸选一张再「通过封面」；打回带原话，Codex 出下一批 vNN+1，旧版留着对比。
 * 视频稿不调 cover:create / cover:revise（那是 AutoCrew 自己按量计费的出图）。
 */
import { openDialog } from "../ui";
import { artifactUrl, GateBadge } from "./board-parts";
import { COVER_RATIOS, coverApproveBlock, coverGroups, selectedCover } from "./cover-board";
import { fileName, finalCutArtifact, type ProjectReview } from "./project-board";

type Submit = (payload: Record<string, unknown>) => Promise<boolean>;

export function CoverStep(props: { review: ProjectReview; contentId: string; busy: boolean; submit: Submit }) {
  const { review, contentId, busy, submit } = props;
  const artifacts = review.execution?.artifacts ?? [];
  const final = finalCutArtifact(artifacts), groups = coverGroups(artifacts), view = review.gates?.gate4;
  const block = coverApproveBlock(groups, review.cover_selection);
  const pick = (ratio: string, sha256: string) => void submit({ action: "select_cover", ratio, sha256 });
  const approve = () => {
    const files = COVER_RATIOS.map((r) => selectedCover(groups, review.cover_selection, r)!).map((a) => ({ path: a.path, sha256: a.sha256 }));
    void submit({ action: "approve", which: "covers", files, manifest_hash: review.manifest_hash });
  };
  const reject = async () => {
    const r = await openDialog({ title: "打回这一批封面", body: "写给剪辑的原话，Codex 按这个出下一批。", fields: [{ key: "note", label: "原话", multiline: true, required: true }], confirmLabel: "打回" });
    if (!r?.note?.trim()) return;
    await submit({ action: "reject", which: "covers", note: r.note, artifact_sha256: view?.reject_sha256, manifest_hash: review.manifest_hash });
  };
  return <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
    <div style={{ flex: "0 0 40%" }}>
      {final && /\.mp4$/i.test(final.path)
        ? <video key={final.sha256} src={artifactUrl(contentId, final)} controls preload="metadata" style={{ width: "100%" }} />
        : <p className="muted">{final ? `成片：${fileName(final.path)}` : "成片还没进项目"}</p>}
    </div>
    <div style={{ flex: 1 }}>
      <p>封面（gate4）：<GateBadge view={view} /></p>
      {COVER_RATIOS.map((ratio) => <div key={ratio}>
        <h4>{ratio}</h4>
        {groups[ratio].length === 0 && <p className="muted">还没有 {ratio} 封面</p>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {groups[ratio].map((a) => {
            const chosen = selectedCover(groups, review.cover_selection, ratio)?.sha256 === a.sha256;
            return <button key={a.sha256} disabled={busy} aria-pressed={chosen} onClick={() => pick(ratio, a.sha256)}
              style={{ padding: 4, border: chosen ? "2px solid var(--accent, #c60)" : "1px solid var(--border)", background: "transparent" }}>
              <img src={artifactUrl(contentId, a)} alt={`${ratio} v${a.version ?? "?"}`} style={{ height: 160, objectFit: "contain", display: "block" }} />
              <span className="muted">v{String(a.version ?? "?").padStart(2, "0")}{chosen ? " · 已选" : ""}</span>
            </button>;
          })}
        </div>
      </div>)}
      {view?.status !== "approved" && <p>
        <button disabled={busy || Boolean(block)} title={block ?? ""} onClick={approve}>通过封面</button>{" "}
        {block && <span className="muted">{block}</span>}{" "}
        <button disabled={busy || !view?.reject_sha256 || view.status === "rejected"} onClick={() => void reject()}>打回</button>
      </p>}
    </div>
  </div>;
}
