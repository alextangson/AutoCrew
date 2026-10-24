/**
 * 英文脚本审阅页（全媒体 spec §3.1 第 2 条、§7 #11）：逐段中英对照表——中文原句、英文、时间槽和预算、
 * 换掉的例子（原例 → 替换例 + 理由 + 出处是否核过）。创始人看中文就能判断，不需要读懂英文。
 * 只读：不改脚本。从「等你拍板」的认稿那件打开。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import { segmentBudget, wordCount, type EnScript, type Swap } from "./script.js";
import { diffHtml, type RebindDiff } from "../lineage/rebind-diff.js";

export interface EnPreviewInput { contentId: string; title: string; script: EnScript; problems: string[]; approval: string; evidence: ReadonlySet<string>; rebindDiff?: RebindDiff | null }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const t = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 100))}`;

function swapHtml(w: Swap, evidence: ReadonlySet<string>): string {
  const src = !w.factual ? "" : w.evidenceId && evidence.has(w.evidenceId) ? `<span class="ok">出处已核（${esc(w.evidenceId)}）</span>` : `<span class="bad">unverified：带事实但没有核过的出处</span>`;
  return `<li>${esc(w.from)} → <b>${esc(w.to)}</b>｜${esc(w.reason)} ${src}</li>`;
}

function rowHtml(s: EnScript["segments"][number], evidence: ReadonlySet<string>): string {
  const b = segmentBudget(s);
  const en = s.keyword ? esc(s.en).replace(esc(s.keyword), `<mark>${esc(s.keyword)}</mark>`) : esc(s.en);
  const budget = `${b.slotS.toFixed(1)}s 槽 · 约 ${b.estimatedS.toFixed(1)}s（${wordCount(s.en)} 词）${b.over ? ' <span class="bad">可能超时</span>' : ""}`;
  const swaps = s.swaps.length ? `<ul>${s.swaps.map((w) => swapHtml(w, evidence)).join("")}</ul>` : "";
  const changed = s.changed ? `<p class="bad">成片换版：${esc(s.changed)}</p>` : "";
  return `<tr><td class="n">${s.index}<br><small>${t(s.startMs)}–${t(s.endMs)}<br>字幕 ${s.cueFrom}–${s.cueTo}</small></td><td>${esc(s.zh)}${changed}</td><td>${en}${swaps}<p class="budget">${budget}</p></td></tr>`;
}

const CSS = `body{font-family:-apple-system,"PingFang SC",sans-serif;margin:0;background:#f4f4f4;color:#222}main{max-width:1100px;margin:0 auto;background:#fff;padding:24px}
table{border-collapse:collapse;width:100%;font-size:15px;line-height:1.6}td,th{border:1px solid #ddd;padding:8px 10px;vertical-align:top}th{background:#fafafa;text-align:left}
td.n{width:90px;color:#666}small{color:#999}.bad{color:#c0392b}.ok{color:#1e8449}.budget{font-size:12px;color:#888;margin:.4em 0 0}mark{background:#ffd60a}ul{margin:.4em 0;padding-left:1.2em;font-size:13px}.meta{background:#f7f7f7;padding:12px 16px;margin-bottom:16px}`;

export function renderEnPreview(i: EnPreviewInput): string {
  const swaps = i.script.segments.reduce((n, s) => n + s.swaps.length, 0);
  const problems = i.problems.length ? `<ul class="bad">${i.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "<p>都齐了，可以批。</p>";
  const rows = i.script.segments.map((s) => rowHtml(s, i.evidence)).join("\n");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>英文版脚本｜${esc(i.title)}</title><style>${CSS}</style></head><body><main>
<h1>英文版脚本：${esc(i.title)}</h1>
<section class="meta"><p>${i.script.segments.length} 段，换了 ${swaps} 处例子。英文通常比中文长 5–25%，每段下面是时间预算。</p><p>批准状态：${esc(i.approval)}</p><h3>还差什么</h3>${problems}</section>
${diffHtml(i.rebindDiff ?? null)}
<table><thead><tr><th>段 / 时间</th><th>中文原句（成片字幕）</th><th>英文（标黄 = 字幕关键词）</th></tr></thead><tbody>
${rows}
</tbody></table></main></body></html>`;
}

export async function writeEnPreview(i: EnPreviewInput, dataDir?: string): Promise<string> {
  const target = projectFile(contentRoot(i.contentId, dataDir), "en-script-review.html");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, renderEnPreview(i), "utf-8");
  return target;
}
