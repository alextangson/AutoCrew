/** 发布台的纯函数：复制文案、数据列的字、进度栏的一行小字、本地日期 */
import type { DeskRow, RailStep, RowCopy } from "./desk-api";

/** 复制到平台的一段：标题、简介、标签（#标签 空格分开） */
export function copyText(c: RowCopy): string | null {
  if (c.kind !== "ready") return null;
  return [c.title, c.caption, c.tags.map((t) => `#${t}`).join(" ")].filter((x) => x.trim()).join("\n\n");
}

const n = (v: number) => (v >= 10_000 ? `${(v / 10_000).toFixed(1).replace(/\.0$/, "")} 万` : String(v));

/** 数据列：播放 · 点赞 · 评论；没数据写原因，不写 0（边界 5） */
export function dataText(r: DeskRow): string {
  const d = r.data;
  if (d.kind === "note") return d.text;
  return [`播放 ${n(d.views)}`, d.likes !== null ? `点赞 ${n(d.likes)}` : null, d.comments !== null ? `评论 ${n(d.comments)}` : null].filter(Boolean).join(" · ");
}

/** 本地日期 MM-DD */
export function localDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 进度栏每步下面那一行：完成写日期（录制写「原片到」）；退回 / 撤回带原因；没有记录如实说 */
export function stepSub(s: RailStep): string {
  const day = localDay(s.at);
  if (s.state === "完成") return [day, s.note ?? (s.key === "publish" ? "投出" : s.key === "data" ? "首次回流" : s.key === "script" ? "认稿" : s.key === "cut" ? "成片" : "")].filter(Boolean).join(" ");
  if (s.state === "被退回" || s.state === "被撤回") return `${s.state === "被退回" ? "退回" : "撤回"}${s.note ? ` · ${s.note}` : ""}`;
  return s.state;
}

const MARK: Record<string, string> = { 完成: "✓", 进行中: "●", 被退回: "✕", 被撤回: "↩", 没有记录: "–", 未到: "○" };

/** 窄屏（<1100px）收成标题下一行小字：「写稿 ✓ · 录制 ✓ · 剪辑 ● …」 */
export function railLine(steps: RailStep[]): string {
  const cur = steps.findIndex((s) => s.current);
  const shown = cur >= 0 ? steps.slice(0, cur + 1) : steps;
  return shown.map((s) => `${s.label} ${MARK[s.state]}`).join(" · ") + (cur >= 0 && cur < steps.length - 1 ? " …" : "");
}

/** 字数估时长：「约 1,200 字 · 约 4.5 分钟」；没语速不估 */
export function lengthText(chars: number, wpm: number | null): string {
  const base = `约 ${chars.toLocaleString("en-US")} 字`;
  return wpm ? `${base} · 约 ${(Math.round((chars / wpm) * 2) / 2).toFixed(1)} 分钟` : base;
}
