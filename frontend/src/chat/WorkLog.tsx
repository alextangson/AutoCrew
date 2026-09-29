/**
 * 「已处理」过程块（v1.1 工作记录 → v1.2 对齐主流 agent）：思考、工具调用、过渡文字收在一起。
 * - 进行中：展开、实时追加（刷新后也按展开态恢复，X1）；
 * - 结束后：默认收起，标题「已处理 · N 步 · 用时」；停止 / 中断写「已停止 · N 步」（X2）；
 * - 失败红字；同一动作重试成功那条绿字，失败不再算「未解决」（X6）；
 *   仍有没解决的失败，块外露一行「有 N 步失败未解决」，点开定位（U12 / v1.2 §3）。
 */
import { useState } from "react";

export interface WorkItem {
  id: string;
  name: string;
  status: "running" | "done" | "failed";
  error?: string;
  note?: string;
  kind?: "compact" | "thought" | "note";
  resolved?: boolean;
  recovered?: boolean;
}

export interface WorkMeta {
  durationMs?: number;
  stopped?: boolean;
  unresolved?: number;
}

export function parseWorkItems(raw: unknown): WorkItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((w): w is WorkItem => Boolean(w) && typeof (w as WorkItem).id === "string" && typeof (w as WorkItem).name === "string");
}

/** 合并 SSE 帧（同 id 覆盖） */
export function mergeWork(list: WorkItem[], item: unknown): WorkItem[] {
  const [w] = parseWorkItems([item]);
  if (!w) return list;
  const i = list.findIndex((x) => x.id === w.id);
  if (i < 0) return [...list, w];
  const next = [...list];
  next[i] = { ...next[i], ...w };
  return next;
}

/** 「N 步」只数动作（工具调用 / 自动放行 / 整理上下文），思考与过渡文字不算步 */
export function stepCount(items: WorkItem[]): number {
  return items.filter((w) => w.kind !== "thought" && w.kind !== "note").length;
}

export function unresolvedCount(items: WorkItem[]): number {
  return items.filter((w) => w.status === "failed" && !w.resolved).length;
}

export function workTitle(items: WorkItem[], meta: WorkMeta, live: boolean): string {
  const n = stepCount(items);
  if (live) {
    const running = items.find((w) => w.status === "running" && w.kind !== "thought" && w.kind !== "note");
    return running ? `正在处理 · ${running.name}…` : `正在处理 · ${n} 步`;
  }
  if (meta.stopped) return `已停止 · ${n} 步`;
  const secs = meta.durationMs ? Math.max(1, Math.round(meta.durationMs / 1000)) : 0;
  return `已处理 · ${n} 步${secs ? ` · 用时 ${secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`}` : ""}`;
}

export function WorkLog({ items, live, meta = {} }: { items: WorkItem[]; live?: boolean; meta?: WorkMeta }) {
  const [open, setOpen] = useState<boolean | null>(null);
  if (items.length === 0) return null;
  const expanded = open ?? Boolean(live);
  const unresolved = meta.unresolved ?? unresolvedCount(items);
  return (
    <div className="worklog">
      <button className="worklog-toggle mono" onClick={() => setOpen(!expanded)}>{expanded ? "▾" : "▸"} {workTitle(items, meta, Boolean(live))}</button>
      {expanded && <ul className="worklog-list">{items.map((w) => <WorkLine key={w.id} w={w} />)}</ul>}
      {!live && unresolved > 0 && (
        <button className="worklog-unresolved" onClick={() => setOpen(true)}>有 {unresolved} 步失败未解决 →</button>
      )}
    </div>
  );
}

function WorkLine({ w }: { w: WorkItem }) {
  if (w.kind === "thought") return <li className="worklog-item worklog-thought">{w.name}</li>;
  if (w.kind === "note") return <li className="worklog-item worklog-note">{w.name}</li>;
  const mark = w.status === "failed" ? "✗" : w.status === "running" ? "…" : w.recovered ? "✓" : "·";
  const cls = w.status === "failed" ? "worklog-failed" : w.recovered ? "worklog-recovered" : "";
  return (
    <li className={`worklog-item ${cls}`}>
      {mark} {w.name}{w.note ? `（${w.note}）` : ""}{w.error ? `：${w.error}` : ""}
    </li>
  );
}
