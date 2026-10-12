/**
 * 发布台底部「手动工具」（发布台 spec §5 / 吸收 15），默认收起：发布前检查、给某平台补作品链接、
 * 某平台手填数据（只在该平台不自动回流时出现）、采纳判定改判、版本记录（后两个是整条稿级别，不按平台）。
 */
import { useState, type ReactNode } from "react";
import type { Content } from "../lib";
import type { VersionLike } from "../version-diff";
import { useGuardedAction } from "./guarded-action";
import { AdoptionBlock, VersionList, runPreCheck } from "./EditorToolParts";
import { moreAction } from "./PublishTable";
import type { Desk } from "./desk-api";

export function DeskManualTools(p: { content: Content; desk: Desk; versions: VersionLike[]; refresh: () => Promise<void>; reload: () => Promise<void>; extra?: ReactNode }) {
  const g = useGuardedAction();
  const [checking, setChecking] = useState(false);
  const links = p.desk.rows.filter((r) => r.more.includes("add_work_url"));
  const manual = p.desk.rows.filter((r) => r.more.includes("record_metrics"));
  const act = (r: Desk["rows"][number], m: "add_work_url" | "record_metrics") => void g.run(`${m}:${r.platform}`, async () => {
    const res = await moreAction({ contentId: p.content.id, desk: p.desk }, r, m);
    if (res.ok) await Promise.all([p.refresh(), p.reload()]);
    return res;
  });
  return <details className="ed-tools desk-tools">
    <summary>手动工具</summary>
    <div className="desk-tools-row">
      <button disabled={checking} onClick={() => { setChecking(true); void runPreCheck(p.content.id, p.reload).finally(() => setChecking(false)); }}>{checking ? "检查中…" : "发布前检查"}</button>
      {links.map((r) => <button key={`l:${r.platform}`} disabled={g.busy} onClick={() => act(r, "add_work_url")}>补{r.label}作品链接</button>)}
      {manual.map((r) => <button key={`m:${r.platform}`} disabled={g.busy} onClick={() => act(r, "record_metrics")}>手填{r.label}数据</button>)}
    </div>
    {g.error && <p className="desk-error" role="alert">没做成：{g.error} <button className="bcard-link" disabled={g.busy} onClick={() => void g.retry()}>重试</button></p>}
    <AdoptionBlock contentId={p.content.id} content={p.content} reload={p.reload} />
    <VersionList contentId={p.content.id} versions={p.versions} dirty={false} reload={p.reload} />
    {p.extra}
  </details>;
}
