/**
 * 卡片「发现的候选」给人看的样子（1b 预演反馈）：第一行 = 种类 + 文件名 + 来源（人话）；第二行 = 一句原因；
 * 分数、前三名、完整路径只放在「依据」里。纯函数：来源目录由调用方给。
 */
import path from "node:path";
import type { Fact } from "../../storage/production-types.js";
import { isWithin } from "../../storage/storage-roots.js";

export interface SourceDirs { inbox: string | null; chatcut: string | null; jianying: string | null }
export interface CandidateRow {
  fact_id: string; kind: Fact["kind"]; state: Fact["state"]; sha256?: string; started_at?: string;
  name: string; origin: string; reason: string; detail: string; path: string | null;
  /** 「等你拍板」列着它：卡片只给「去『等你拍板』处理」；不列的（发布后导出、已发布、归了别条）卡片上直接定 */
  in_inbox?: boolean;
}

const KIND: Partial<Record<Fact["kind"], string>> = { aroll: "原片", cut: "成片", srt: "字幕", cover: "封面" };

export function originOf(f: Fact, dirs: SourceDirs): string {
  if (f.source === "founder") return "你挂的";
  if (f.source === "record") return "agent 报的";
  const file = f.path && path.isAbsolute(f.path) ? f.path : null;
  if (file && dirs.inbox && path.dirname(file) === dirs.inbox) return "收件箱";
  if (file && dirs.chatcut && isWithin(dirs.chatcut, file)) return "ChatCut 导出";
  if (file && dirs.jianying && isWithin(dirs.jianying, file)) return "剪映导出";
  return f.source === "legacy" ? "旧记录" : "对账发现";
}

export function reasonOf(f: Fact, contentId: string): string {
  if (f.state === "pending_match") return "正在听开头核对是不是这条";
  const m = f.match;
  if (m) {
    if (m.reason.startsWith("文件名对上")) return "文件名对上标题";
    if (m.winner === contentId) return "开头说的话和这条稿对上了";
    if (m.winner) return `听起来更像《${m.top3.find((r) => r.content_id === m.winner)?.title ?? "别条"}》`;
    return m.top3[0]?.content_id === contentId ? "开头说的话最像这条，但和别条分不太开，要你确认" : "像这条，但不确定，要你确认";
  }
  const e = f.evidence ?? "";
  if (e.includes("文件名前缀对上标题") || e.includes("文件名对上")) return "文件名对上标题";
  if (e.includes("转写环境没装好")) return "转写环境没装好，只比了文件名，要你确认";
  return "归属要你确认";
}

export function candidateRow(f: Fact, contentId: string, dirs: SourceDirs): CandidateRow {
  const file = f.path ?? null;
  const scores = f.match?.top3.length ? `前三名：${f.match.top3.map((r) => `《${r.title}》${r.l2 !== undefined ? ` ${r.l2}` : ""}`).join("、")}` : "";
  return {
    fact_id: f.id, kind: f.kind, state: f.state, ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.state === "pending_match" && f.match_started_at ? { started_at: f.match_started_at } : {}),
    name: `${KIND[f.kind] ?? f.kind} · ${file ? path.basename(file) : "（没有文件）"}`, origin: originOf(f, dirs), reason: reasonOf(f, contentId),
    detail: [file, f.evidence, scores].filter(Boolean).join("\n"), path: file,
  };
}
