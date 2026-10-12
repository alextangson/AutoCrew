/**
 * 稿件页左侧进度栏（发布台 spec「创始人已定」+ 吸收 12）：本体启用的视频稿每个阶段都挂。
 * 写稿 → 录制 → 剪辑 → 封面 → 发布 → 数据；当前一步红点，退回写原因，后面做了这步没证据写「没有记录」。
 * 窄屏（<1100px）整栏藏起，换成标题下一行小字（RailLine）。
 */
import type { ReactNode } from "react";
import { useDesk } from "./use-desk";
import { lengthText, railLine, stepSub } from "./desk-model";
import type { Desk } from "./desk-api";
import "./publish-desk.css";

export function ProgressRail(p: { versions?: ReactNode; handoff?: ReactNode }) {
  const ctx = useDesk();
  const desk = ctx?.data?.active ? ctx.data.desk : null;
  if (!desk) return null;
  const r = desk.rail;
  return <aside className="desk-rail" aria-label="这一条的进度">
    <ol className="desk-steps">
      {r.steps.map((s) => <li key={s.key} className={`desk-step is-${s.state}${s.current ? " is-current" : ""}`} aria-current={s.current ? "step" : undefined}>
        <span className="desk-dot" aria-hidden />
        <strong>{s.label}</strong>
        <small>{stepSub(s)}</small>
      </li>)}
    </ol>
    <div className="desk-rail-meta">
      <p><span className="muted">平台</span> {r.platforms.length ? `${r.platforms[0]}${r.platforms.length > 1 ? ` 等 ${r.platforms.length} 个` : ""}` : "—"}</p>
      <p className="muted">{lengthText(r.chars, r.wpm)}</p>
      {p.versions}
      {p.handoff}
    </div>
  </aside>;
}

/** 窄屏时标题下的一行小字 */
export function RailLine({ desk }: { desk: Desk }) {
  return <p className="desk-rail-line">{railLine(desk.rail.steps)}</p>;
}
