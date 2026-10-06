/**
 * 「要你判断」（spec 2026-10-06 proactive-chat-review §1）：服务端替每件能在对话里定的事写好一段话，
 * agent 原样转述，不自己编判断标准。只讲最新一组 / 最新一版（或创始人点名的那一组 / 一版），其余只给一句数量。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveContentProject } from "../../../storage/content-project.js";
import type { Fact, ProductionDoc } from "../../../storage/production-types.js";
import type { InboxItem } from "../inbox.js";
import { readTranscript } from "../match/cache.js";
import { KIND_NAME } from "../plain-reason.js";
import { groupsOf, versionsOf, type Group, type Version } from "./view.js";

export const NO_COVER_TEXT = "没写封面字";
export const NO_CHANGE_NOTE = "没写改了什么";
export const REPLY_HINT = "回我「用」/「还要改：……」";
export const CANDIDATE_REPLY_HINT = "回我「是」/「不是」";

const nameOf = (f: Fact | undefined) => (f?.path ? path.basename(f.path) : "（文件记录不在了）");
const fact = (doc: ProductionDoc, id: string | undefined) => doc.facts.find((f) => f.id === id);

export function durationText(ms: number | undefined): string {
  if (!ms || ms <= 0) return "时长未知";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}

/** 选中的组：点名的那组，否则最新一组（列表里第一组） */
export function pickedGroup(item: InboxItem, groupId?: string): Group | undefined {
  const groups = groupsOf(item);
  return (groupId ? groups.find((g) => g.group_id === groupId) : undefined) ?? groups[0];
}
export function pickedVersion(item: InboxItem, factId?: string): Version | undefined {
  const versions = versionsOf(item);
  return (factId ? versions.find((v) => v.fact_id === factId) : undefined) ?? versions[0];
}

function coverBrief(item: InboxItem, doc: ProductionDoc, groupId?: string): string[] {
  const groups = groupsOf(item);
  const g = pickedGroup(item, groupId);
  if (!g) return [`《${item.title}》封面：这组封面的记录不在了，刷新再看`];
  const rest = groups.length - 1;
  const text = g.text?.trim() ? `「${g.text.trim()}」` : NO_COVER_TEXT;
  return [
    `《${item.title}》封面：${g.label}${rest > 0 ? `（还有 ${rest} 组）` : ""}`,
    `封面字：${text}`,
    "要你判断：大字是不是一眼就能看清；你本人看着自不自然。",
    `文件：3:4 ${nameOf(fact(doc, g["3:4"]?.fact_id))}、4:3 ${nameOf(fact(doc, g["4:3"]?.fact_id))}`,
    REPLY_HINT,
  ];
}

type Report = { files?: Array<{ sha256?: string }>; result?: string; recorded_at?: string };
const readReport = async (file: string): Promise<Report> => {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as Report; } catch { return {}; }
};

/** 剪辑工位交片时写的「改了什么」：先看登记成片时的备注，再看执行汇报里带这份成片的那条 */
export async function changeNote(contentId: string, f: Fact | undefined, dataDir: string): Promise<string> {
  if (f?.note?.trim()) return f.note.trim();
  if (!f?.sha256) return NO_CHANGE_NOTE;
  const root = resolveContentProject(contentId, dataDir)?.project_root;
  if (!root) return NO_CHANGE_NOTE;
  const dir = path.join(root, "00-project/notes/execution-reports");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let best: { at: string; result: string } | null = null;
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    const r = await readReport(path.join(dir, n));
    if (!r.result?.trim() || !r.files?.some((x) => x.sha256 === f.sha256)) continue;
    if (!best || String(r.recorded_at ?? "") > best.at) best = { at: String(r.recorded_at ?? ""), result: r.result.trim() };
  }
  return best?.result ?? NO_CHANGE_NOTE;
}

async function cutBrief(item: InboxItem, doc: ProductionDoc, dataDir: string, factId?: string): Promise<string[]> {
  const versions = versionsOf(item);
  const v = pickedVersion(item, factId);
  if (!v) return [`《${item.title}》成片：这一版的记录不在了，刷新再看`];
  const f = fact(doc, v.fact_id);
  const no = versions.length - versions.indexOf(v);
  const rest = versions.length - 1;
  return [
    `《${item.title}》成片：第 ${no} 版（${v.label}，${durationText(f?.duration_ms)}）${rest > 0 ? `，还有 ${rest} 版` : ""}`,
    `这版改了什么：${await changeNote(item.content_id!, f, dataDir)}`,
    "要你判断：从头看一遍，留意剪错的地方、卡顿、字幕错字。",
    ...(v.blocked_reason ? [`注意：这一版现在还不能通过（${v.blocked_reason}）`] : []),
    `文件：${nameOf(f)}`,
    REPLY_HINT,
  ];
}

/** 候选：原片只读已有的转写缓存里的第一句，绝不为这件事去转写 */
async function candidateBrief(item: InboxItem, doc: ProductionDoc, dataDir: string): Promise<string[]> {
  const d = item.detail;
  const kind = KIND_NAME[String(d.kind)] ?? "文件";
  const f = fact(doc, String(d.fact_id ?? ""));
  const opening = d.kind === "aroll" && f?.sha256 ? firstSentence((await readTranscript(dataDir, f.sha256))?.text) : null;
  return [
    `《${item.title}》找到一个${kind}文件：${String(d.name ?? nameOf(f))}`,
    ...(opening ? [`开头一句：「${opening}」`] : []),
    `要你判断：这是不是这条稿的${kind}？`,
    CANDIDATE_REPLY_HINT,
  ];
}

export function firstSentence(text: string | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  const s = t.split(/(?<=[。！？!?\n])/)[0].trim();
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** 一件事的「要你判断」；sel 是创始人点名要看的那一组 / 一版 */
export async function briefOf(item: InboxItem, doc: ProductionDoc, dataDir: string, sel: { group_id?: string; fact_id?: string } = {}): Promise<string> {
  if (item.type === "cover_pick") return coverBrief(item, doc, sel.group_id).join("\n");
  if (item.type === "cut_review") return (await cutBrief(item, doc, dataDir, sel.fact_id)).join("\n");
  if (item.type === "candidate") return (await candidateBrief(item, doc, dataDir)).join("\n");
  return "";
}
