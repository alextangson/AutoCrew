/**
 * 视频稿的「待发布 / 已发布」页（spec 2026-10-12 发布台，参照 G-draft-4）：只给本体启用的视频稿，
 * 文字稿、影子 / 被排除 / 导入的照旧用 PublishWorkspace（吸收 7）。
 * 从上到下：标题行 → 封面 + 现在轮到你卡 → 各平台表 → 口播稿（折叠，只读）→ 手动工具（折叠）。
 * 卡和表读同一份读模型（use-desk）；读取中先出骨架，失败一行原因 + 重试（边界 11）。
 */
import type { ReactNode } from "react";
import type { Content } from "../lib";
import type { VersionLike } from "../version-diff";
import { ScriptPeek } from "./ScriptPeek";
import { PublishTable } from "./PublishTable";
import { DeskManualTools } from "./DeskManualTools";
import { useDesk } from "./use-desk";
import { RailLine } from "./ProgressRail";
import "./publish-desk.css";

export interface PublishDeskProps { content: Content; versions: VersionLike[]; stageCard: ReactNode; reload: () => Promise<void>; extra?: ReactNode; stage: string | null }

export function DeskSkeleton({ error, retry }: { error: string | null; retry: () => void }) {
  return <div className="desk" aria-busy={!error}>
    {error ? <p className="desk-error" role="alert">发布台读不出来：{error} <button className="bcard-link" onClick={retry}>重试</button></p>
      : <><div className="desk-skel desk-skel-title" /><div className="desk-skel desk-skel-card" />{[0, 1, 2].map((i) => <div key={i} className="desk-skel desk-skel-row" />)}</>}
  </div>;
}

export function PublishDesk(p: PublishDeskProps) {
  const ctx = useDesk();
  if (!ctx?.data?.active) return <DeskSkeleton error={ctx?.error ?? null} retry={() => void ctx?.refresh()} />;
  const { desk } = ctx.data;
  const c = p.content;
  return <div className="desk">
    <p className="desk-meta">{[p.stage, desk.headline].filter(Boolean).join(" · ")}</p>
    <h1 className="desk-title serif">{c.title || "无标题"}</h1>
    <RailLine desk={desk} />
    {ctx.error && <p className="desk-error" role="alert">刷新没成功：{ctx.error} <button className="bcard-link" onClick={() => void ctx.refresh()}>重试</button></p>}
    <div className="desk-hero">
      {desk.cover ? <img className="desk-cover" alt="已选封面" src={desk.cover.url} /> : <div className="desk-cover is-empty">还没有批准的封面</div>}
      <div className="desk-hero-card">{p.stageCard}</div>
    </div>
    <PublishTable contentId={c.id} title={c.title} desk={desk} refresh={ctx.refresh} reload={p.reload} />
    <ScriptPeek title={c.title} body={c.body ?? ""} summary={`口播稿 · ${desk.script.label}`} hint={desk.script.final ? "认过的那一版，只读。" : "当前正文和认稿时不一样（没重新认），只读。"} />
    <DeskManualTools content={c} desk={desk} versions={p.versions} refresh={ctx.refresh} reload={p.reload} extra={p.extra} />
  </div>;
}
