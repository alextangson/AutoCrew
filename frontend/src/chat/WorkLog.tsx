/**
 * 「工作记录」（v1.1）：工具调用收成一组灰色小字，可展开；出错的那条红字始终露在外面（U12）；
 * 压缩显示成一行「整理了一下上下文」。正文与卡片不在这里。
 */
import { useState } from "react";

export interface WorkItem {
  id: string;
  name: string;
  status: "running" | "done" | "failed";
  error?: string;
  note?: string;
  kind?: "compact";
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

export function WorkLog({ items, live }: { items: WorkItem[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const failed = items.filter((w) => w.status === "failed");
  const running = items.find((w) => w.status === "running");
  const summary = live && running ? `工作记录 · ${running.name}…` : `工作记录 · ${items.length} 步`;
  return (
    <div className="worklog">
      <button className="worklog-toggle mono" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"} {summary}</button>
      {open && (
        <ul className="worklog-list">
          {items.map((w) => <WorkLine key={w.id} w={w} />)}
        </ul>
      )}
      {!open && failed.length > 0 && (
        <ul className="worklog-list">{failed.map((w) => <WorkLine key={w.id} w={w} />)}</ul>
      )}
    </div>
  );
}

function WorkLine({ w }: { w: WorkItem }) {
  const mark = w.status === "failed" ? "✗" : w.status === "running" ? "…" : "·";
  return (
    <li className={w.status === "failed" ? "worklog-item worklog-failed" : "worklog-item"}>
      {mark} {w.name}{w.note ? `（${w.note}）` : ""}{w.error ? `：${w.error}` : ""}
    </li>
  );
}
