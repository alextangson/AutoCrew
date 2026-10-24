/**
 * 源成片换版后的逐句对比（spec §9.1 rebind）：旧成片登记的字幕 vs 新成片登记的字幕，按字幕条（一句一行）比。
 * 结果落在派生稿项目里 `rebind-diff.json`，审阅页、「等你拍板」的 brief、rebind 回执都读这一份。
 * 旧字幕找不到（旧流程 / 没登记 / 被改过）时照实写原因，不假装「没有变化」。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Content } from "../../storage/local-store.js";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { factPath } from "../production/chat-approval/files.js";
import { parseTimedSrt, type SourceCue } from "../en-edition/source.js";

export type DiffOp = "changed" | "added" | "removed";
export interface DiffLine { op: DiffOp; old?: string; new?: string; oldIndex?: number; newIndex?: number }
export interface RebindDiff {
  fromCut: string; toCut: string; at: string;
  /** 旧字幕读不出来的原因；读到了 = 不带 */
  unavailable?: string;
  summary: { same: number; changed: number; added: number; removed: number };
  lines: DiffLine[];
}

const norm = (s: string) => s.replace(/\s+/g, "").trim();

/** 两组字幕条的最长公共子序列：旧第 i 条 → 新第 j 条（文字一样才算同一句） */
export function matchCues(oldCues: SourceCue[], newCues: SourceCue[]): Map<number, number> {
  const a = oldCues.map((c) => norm(c.text)), b = newCues.map((c) => norm(c.text));
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = new Map<number, number>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { out.set(oldCues[i].index, newCues[j].index); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return out;
}

/** 逐句对比：没对上的旧句和新句按出现顺序配成「改了」，多出来的算删掉 / 新加 */
export function diffCues(oldCues: SourceCue[], newCues: SourceCue[]): Pick<RebindDiff, "summary" | "lines"> {
  const m = matchCues(oldCues, newCues);
  const kept = new Set(m.values());
  const lines: DiffLine[] = [];
  let removed: SourceCue[] = [], added: SourceCue[] = [];
  const flush = () => {
    const n = Math.max(removed.length, added.length);
    for (let k = 0; k < n; k++) {
      const o = removed[k], w = added[k];
      lines.push({ op: o && w ? "changed" : o ? "removed" : "added", ...(o ? { old: o.text, oldIndex: o.index } : {}), ...(w ? { new: w.text, newIndex: w.index } : {}) });
    }
    removed = []; added = [];
  };
  let j = 0;
  for (const o of oldCues) {
    const to = m.get(o.index);
    if (to === undefined) { removed.push(o); continue; }
    while (j < newCues.length && newCues[j].index < to) { if (!kept.has(newCues[j].index)) added.push(newCues[j]); j++; }
    flush(); j++;
  }
  for (; j < newCues.length; j++) if (!kept.has(newCues[j].index)) added.push(newCues[j]);
  flush();
  const count = (op: DiffOp) => lines.filter((l) => l.op === op).length;
  return { summary: { same: m.size, changed: count("changed"), added: count("added"), removed: count("removed") }, lines };
}

/** 某一版成片（`sha256:<hex>` 身份）登记的字幕全文；读不出交原因 */
export async function cutSrtText(source: Pick<Content, "id">, cutHash: string, dataDir: string): Promise<{ text: string } | { error: string }> {
  if (!cutHash.startsWith("sha256:")) return { error: "源视频走的是旧流程，那一版成片没有登记字幕" };
  const sha = cutHash.slice("sha256:".length);
  const doc = await readProductionDocOrEmpty(source.id, dataDir);
  const fact = doc.facts.filter((f) => f.kind === "srt" && f.for_cut === sha && f.state === "accepted" && f.path).sort((x, y) => y.at.localeCompare(x.at))[0];
  if (!fact) return { error: "那一版成片没有登记字幕" };
  try {
    const bytes = await fs.readFile(factPath(source.id, fact, dataDir));
    if (createHash("sha256").update(bytes).digest("hex") !== fact.sha256) return { error: "那一版的字幕文件在登记之后被改过" };
    return { text: bytes.toString("utf8") };
  } catch (e) {
    return { error: `那一版的字幕读不了（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）` };
  }
}

const fileOf = (id: string, dataDir: string) => projectFile(contentRoot(id, dataDir), "rebind-diff.json");

export async function writeRebindDiff(id: string, d: RebindDiff, dataDir: string): Promise<void> {
  await fs.mkdir(path.dirname(fileOf(id, dataDir)), { recursive: true });
  await writeJsonAtomic(fileOf(id, dataDir), d);
}

export async function readRebindDiff(id: string, dataDir: string): Promise<RebindDiff | null> {
  try { return JSON.parse(await fs.readFile(fileOf(id, dataDir), "utf8")) as RebindDiff; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(`成片换版对比读不出来（${(e as Error).message}）`); }
}

/** 源成片两版之间的对比；旧的读不出照写原因、新的读不出直接报错（rebind 要绑的就是新成片） */
export async function buildRebindDiff(source: Pick<Content, "id">, fromCut: string, toCut: string, dataDir: string): Promise<RebindDiff | { error: string }> {
  const [oldSrt, newSrt] = await Promise.all([cutSrtText(source, fromCut, dataDir), cutSrtText(source, toCut, dataDir)]);
  const base = { fromCut, toCut, at: new Date().toISOString() };
  if ("error" in newSrt) return toCut.startsWith("sha256:") ? { error: `新成片的字幕读不出来（${newSrt.error}）：先给新成片登记字幕，再 rebind` } : { ...base, unavailable: newSrt.error, summary: { same: 0, changed: 0, added: 0, removed: 0 }, lines: [] };
  if ("error" in oldSrt) {
    const cues = parseTimedSrt(newSrt.text);
    return { ...base, unavailable: `旧成片的字幕读不出来（${oldSrt.error}），没法逐句比：下面列的是新成片全部字幕`, summary: { same: 0, changed: 0, added: cues.length, removed: 0 }, lines: cues.map((c) => ({ op: "added" as const, new: c.text, newIndex: c.index })) };
  }
  return { ...base, ...diffCues(parseTimedSrt(oldSrt.text), parseTimedSrt(newSrt.text)) };
}

const OP_LABEL: Record<DiffOp, string> = { changed: "改了", added: "新加", removed: "删了" };

/** 给创始人看的几行（brief 用；太长只列前 12 处） */
export function diffBriefLines(d: RebindDiff, max = 12): string[] {
  const s = d.summary;
  const head = `源视频成片换了一版（rebind 到新成片）：没变 ${s.same} 句，改了 ${s.changed} 句，新加 ${s.added} 句，删了 ${s.removed} 句${d.unavailable ? `（${d.unavailable}）` : ""}`;
  const rows = d.lines.slice(0, max).map((l) => `  ${OP_LABEL[l.op]}：${l.old ? `「${l.old}」` : ""}${l.op === "changed" ? " → " : ""}${l.new ? `「${l.new}」` : ""}`);
  return [head, ...rows, ...(d.lines.length > max ? [`  …还有 ${d.lines.length - max} 处，审阅页里有全部`] : [])];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 审阅页上的那一块 */
export function diffHtml(d: RebindDiff | null): string {
  if (!d) return "";
  const rows = d.lines.map((l) => `<tr><td>${OP_LABEL[l.op]}</td><td>${esc(l.old ?? "")}</td><td>${esc(l.new ?? "")}</td></tr>`).join("");
  return `<section class="meta"><h3>${esc(diffBriefLines(d, 0)[0])}</h3>${rows ? `<table><thead><tr><th></th><th>旧成片</th><th>新成片</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>逐句没有变化。</p>"}</section>`;
}
