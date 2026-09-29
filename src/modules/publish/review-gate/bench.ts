/**
 * 上线前评测（发布前把关 spec §10，Codex P2-13）：用已发 / 待发的真实标题、文案、字幕（或定稿正文）构造正反例，
 * 按视频分组；每个问题正反各 ≥5 例。问的就是生产里的同一套问题（buildA / buildB / interpret），不另写一份。
 *
 * - positive = 应当判「没问题」的例子（pass）；negative = 应当被提醒的例子（warn）。
 * - 结论三态：通过 / 提醒 / 弃权（无法判断、未覆盖）；误报 = 正例被提醒，漏报 = 反例被放过。
 * - 概率分布按问题、按正反例列出，供复盘定阈值；不据此自动开拦截。
 */
import { buildA, buildB, interpret, type BEntryView, type Instruction } from "./semantic.js";
import type { JevCaller } from "./jev-client.js";
import type { Basis } from "./subtitles.js";
import type { CheckItem, Override } from "./types.js";

export interface BenchVideo { id: string; title: string; basis: Basis; entries: Array<{ platform: string; label: string; title: string; caption: string }> }

export type BenchQuestion = "A1" | "A2" | "A3" | "B" | "O";
export interface BenchCase {
  id: string; video: string; question: BenchQuestion; expect: "positive" | "negative"; note: string;
  /** A 类 */ a?: { title: string; caption: string; coverText: string | null };
  /** B / O 类 */ b?: { entry: BEntryView; instruction?: string; override?: Override };
}

const OTHER_NUMBER = "效率提升 73%";

function entryView(label: string, title: string, caption: string, cover: { ratio: string; file: string }, extra: Partial<BEntryView> = {}): BEntryView {
  return { platform: label, 平台集合: [label], 账号: "哈姆雷鹿", 标题: title, 文案: caption, 标签: [], 封面: [{ 用途: "封面", 比例: cover.ratio, 文件: cover.file }], 排期: null, 活动: [], ...extra };
}

/** 字幕 / 正文里挑一句真说过的话当「有据」说法（取中段一行，去掉标点尾巴） */
function supportedClaim(basis: Basis): string {
  const lines = basis.text.split(/\n|。/).map((l) => l.trim()).filter((l) => l.length >= 6 && l.length <= 30);
  return lines[Math.floor(lines.length / 2)] ?? basis.text.slice(0, 20);
}

function aCases(v: BenchVideo, other: BenchVideo): BenchCase[] {
  const e = v.entries[0];
  const o = other.entries[0];
  const c = (q: BenchQuestion, expect: BenchCase["expect"], note: string, a: BenchCase["a"]): BenchCase => ({ id: `${v.id}:${q}:${expect}:${note}`, video: v.id, question: q, expect, note, a });
  const first = v.basis.text.split("\n")[0]?.slice(0, 16) ?? "";
  return [
    c("A1", "positive", "真实标题文案", { title: e.title, caption: e.caption, coverText: null }),
    c("A1", "negative", "换成别条视频的标题文案", { title: o.title, caption: o.caption, coverText: null }),
    c("A2", "positive", "字幕里说过的话", { title: `「${supportedClaim(v.basis)}」`, caption: "", coverText: null }),
    c("A2", "negative", "塞一个字幕里没有的数字", { title: OTHER_NUMBER, caption: "", coverText: null }),
    c("A3", "positive", "稿件标题当封面字", { title: e.title, caption: e.caption, coverText: v.title.slice(0, 24) }),
    c("A3", "negative", "别条视频的标题当封面字", { title: e.title, caption: e.caption, coverText: other.title.slice(0, 24) }),
    ...(first ? [c("A3", "negative", "开头第一句当封面字", { title: e.title, caption: e.caption, coverText: first })] : []),
  ];
}

function bCases(v: BenchVideo): BenchCase[] {
  const e = v.entries[0];
  const c = (q: BenchQuestion, expect: BenchCase["expect"], note: string, b: BenchCase["b"]): BenchCase => ({ id: `${v.id}:${q}:${expect}:${note}`, video: v.id, question: q, expect, note, b });
  const xhs = (ratio: string) => entryView("小红书", e.title, e.caption, { ratio, file: `封面-${ratio.replace(":", "x")}.png` });
  const dy = (extra: Partial<BEntryView>) => ({ ...entryView("抖音", e.title, e.caption, { ratio: "3:4", file: "封面-3x4.png" }), ...extra });
  const quoteOverride = { platform: "xiaohongshu", rule: "cover_extra_ratio", founder_quote: "小红书这次就传横版封面，按我说的来" };
  return [
    c("B", "negative", "原话「小红书的封面用 3:4 的」配 4:3", { entry: xhs("4:3"), instruction: "小红书的封面用 3:4 的" }),
    c("B", "positive", "原话「小红书的封面用 3:4 的」配 3:4", { entry: xhs("3:4"), instruction: "小红书的封面用 3:4 的" }),
    c("B", "negative", "原话点名两个平台、计划只有一个", { entry: dy({ 平台集合: ["抖音"] }), instruction: "抖音和小红书都发" }),
    c("B", "positive", "原话点名两个平台、计划两个都有", { entry: dy({ 平台集合: ["抖音", "小红书"] }), instruction: "抖音和小红书都发" }),
    c("B", "negative", "原话要定时明晚 8 点，计划是早上 9 点", { entry: dy({ 排期: "2026-10-01T09:00:00+08:00" }), instruction: "定时 10 月 1 日晚上 8 点发" }),
    c("B", "positive", "原话要定时明晚 8 点，计划一致", { entry: dy({ 排期: "2026-10-01T20:00:00+08:00" }), instruction: "定时 10 月 1 日晚上 8 点发" }),
    c("O", "positive", "原话确实在要求这条例外", { entry: xhs("4:3"), override: quoteOverride }),
    c("O", "negative", "原话与这条例外无关", { entry: xhs("4:3"), override: { ...quoteOverride, founder_quote: "今天的标题挺好的" } }),
  ];
}

export function buildBenchSet(videos: BenchVideo[]): BenchCase[] {
  const usable = videos.filter((v) => v.entries.length && v.basis.text.trim());
  return usable.flatMap((v, i) => [...aCases(v, usable[(i + 1) % usable.length]), ...bCases(v)]);
}

export type Outcome = "pass" | "warn" | "abstain" | "not_run";
export interface BenchResult { id: string; video: string; question: BenchQuestion; expect: BenchCase["expect"]; note: string; outcome: Outcome; probability: number | null; reason?: string; input_tokens?: number }

function pickItem(q: BenchQuestion, items: CheckItem[]): CheckItem | undefined {
  if (q === "A1") return items.find((i) => i.check.startsWith("A1"));
  if (q === "A2") return items.find((i) => i.check.startsWith("A2"));
  if (q === "A3") return items.find((i) => i.check.startsWith("A3"));
  if (q === "O") return items.find((i) => i.check === "例外原话核对");
  return items.find((i) => i.result === "warn") ?? items.find((i) => i.check.startsWith("B"));
}

/** 一例的「问题概率」：A1/A3 取模型选中的选项概率；A2/O 取支持概率；B 取最大违反概率 */
function probabilityOf(q: BenchQuestion, answers: Record<string, { type: string; noul?: number; choice?: string; probabilities?: Record<string, number> }>): number | null {
  if (q === "A1" || q === "A3") { const a = answers[q === "A1" ? "a1" : "a3"]; return a?.probabilities?.[a.choice ?? ""] ?? null; }
  if (q === "A2") return Object.entries(answers).find(([k]) => k.startsWith("a2_"))?.[1].noul ?? null;
  if (q === "O") return answers.o0?.noul ?? null;
  const v = Object.entries(answers).filter(([k]) => k.startsWith("v")).map(([, a]) => a.noul ?? 0);
  return v.length ? Math.max(...v) : null;
}

async function runOne(c: BenchCase, basis: Basis | undefined, caller: JevCaller): Promise<BenchResult> {
  const base = { id: c.id, video: c.video, question: c.question, expect: c.expect, note: c.note };
  let req, ctx: { basis?: Basis; instructions?: Instruction[] } = {};
  if (c.a) {
    if (!basis) return { ...base, outcome: "not_run", probability: null, reason: "没有比对底稿" };
    const built = buildA({ platform: "抖音", title: c.a.title, caption: c.a.caption, coverText: c.a.coverText, scriptTitle: "", basis });
    if (c.question === "A2" && built.codeItems.length && !Object.keys(built.request!.questions).some((k) => k.startsWith("a2_"))) return { ...base, outcome: "pass", probability: 1, reason: "代码逐字判过" };
    req = built.request!; ctx = { basis };
  } else {
    const instructions: Instruction[] = c.b!.instruction ? [{ n: 1, source: "原话", text: c.b!.instruction }] : [];
    req = buildB(c.b!.entry, instructions, c.b!.override ? [c.b!.override] : [])!; ctx = { instructions };
  }
  try {
    const r = await caller(req.state, req.questions);
    const item = pickItem(c.question, interpret(req, r.answers, ctx));
    const outcome: Outcome = !item || item.result === "unchecked" ? "abstain" : item.result === "warn" ? "warn" : "pass";
    return { ...base, outcome, probability: probabilityOf(c.question, r.answers as never), input_tokens: r.usage.input_tokens };
  } catch (e) {
    return { ...base, outcome: "not_run", probability: null, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 并发有上限地跑完；A 类例子要带所属视频的比对底稿 */
export async function runBench(cases: BenchCase[], videos: BenchVideo[], caller: JevCaller, concurrency = 4): Promise<BenchResult[]> {
  const basis = new Map(videos.map((v) => [v.id, v.basis]));
  const out: BenchResult[] = new Array(cases.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (next < cases.length) { const i = next++; out[i] = await runOne(cases[i], basis.get(cases[i].video), caller); }
  }));
  return out;
}

export interface QuestionStats { question: BenchQuestion; positives: number; negatives: number; false_positive: number; false_negative: number; abstain: number; not_run: number; pos_probs: number[]; neg_probs: number[]; by_video: Record<string, { fp: number; fn: number; abstain: number; n: number }> }

export function summarizeBench(results: BenchResult[]): QuestionStats[] {
  const qs: BenchQuestion[] = ["A1", "A2", "A3", "B", "O"];
  return qs.map((q) => {
    const rs = results.filter((r) => r.question === q);
    const s: QuestionStats = { question: q, positives: 0, negatives: 0, false_positive: 0, false_negative: 0, abstain: 0, not_run: 0, pos_probs: [], neg_probs: [], by_video: {} };
    for (const r of rs) {
      const v = (s.by_video[r.video] ??= { fp: 0, fn: 0, abstain: 0, n: 0 });
      v.n++;
      if (r.expect === "positive") s.positives++; else s.negatives++;
      if (r.probability !== null) (r.expect === "positive" ? s.pos_probs : s.neg_probs).push(Math.round(r.probability * 1000) / 1000);
      if (r.outcome === "not_run") { s.not_run++; continue; }
      if (r.outcome === "abstain") { s.abstain++; v.abstain++; continue; }
      if (r.expect === "positive" && r.outcome === "warn") { s.false_positive++; v.fp++; }
      if (r.expect === "negative" && r.outcome === "pass") { s.false_negative++; v.fn++; }
    }
    return s;
  });
}

const fmt = (xs: number[]) => (xs.length ? `n=${xs.length} min=${Math.min(...xs)} 中位=${[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]} max=${Math.max(...xs)}` : "—");

export function benchMarkdown(stats: QuestionStats[], results: BenchResult[], meta: { videos: number; model: string; at: string; tokens: number }): string {
  const lines = [`# 发布前把关 · 上线前评测（${meta.at}）`, "", `模型 ${meta.model}；${meta.videos} 条视频；${results.length} 例；输入 ${meta.tokens} token。`, "",
    "| 问题 | 正例 | 反例 | 误报（正例被提醒） | 漏报（反例被放过） | 弃权 | 没跑成 | 正例概率 | 反例概率 |", "|---|---|---|---|---|---|---|---|---|",
    ...stats.map((s) => `| ${s.question} | ${s.positives} | ${s.negatives} | ${s.false_positive} | ${s.false_negative} | ${s.abstain} | ${s.not_run} | ${fmt(s.pos_probs)} | ${fmt(s.neg_probs)} |`),
    "", "概率口径：A1/A3 = 模型选中项的概率；A2 = 字幕支持概率；B = 该条指令下各字段最大违反概率；O = 原话在要求这条例外的概率。", "",
    "## 按视频", ""];
  for (const s of stats) {
    lines.push(`### ${s.question}`, "", "| 视频 | 例数 | 误报 | 漏报 | 弃权 |", "|---|---|---|---|---|");
    for (const [v, x] of Object.entries(s.by_video)) lines.push(`| ${v} | ${x.n} | ${x.fp} | ${x.fn} | ${x.abstain} |`);
    lines.push("");
  }
  lines.push("## 判错的例子", "", ...results.filter((r) => (r.expect === "positive" && r.outcome === "warn") || (r.expect === "negative" && r.outcome === "pass") || r.outcome === "abstain" || r.outcome === "not_run")
    .map((r) => `- ${r.question} ${r.expect === "positive" ? "正例" : "反例"} · ${r.video} · ${r.note} → ${r.outcome}${r.probability !== null ? `（${r.probability}）` : ""}${r.reason ? `：${r.reason}` : ""}`));
  return lines.join("\n") + "\n";
}
