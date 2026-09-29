/**
 * Jev A（语义把关）与 Jev B（执行是否符合指令）的问题集与判读（spec §8、§9、§7 顺带核对）。
 *
 * - 问题的 instructions 写死在这里；状态里的文字（字幕、标题、原话）只是数据，不改变问题（E10）。
 * - 每条判定的依据由代码拼（原话、字段、概率），不让 Jev 编解释（E5）。
 * - Jev 结论一律 warn；abstain（无法判断）单列为 unchecked，不算通过。
 */
import type { JevAnswer, JevQuestion } from "./jev-client.js";
import type { Basis } from "./subtitles.js";
import type { CheckItem, Override } from "./types.js";

export interface SemanticRequest { kind: "A" | "B"; state: unknown; questions: Record<string, JevQuestion>; /** 判读用的附加信息（问题 id → 元数据） */ meta: Record<string, QuestionMeta> }
export type QuestionMeta =
  | { q: "A1" } | { q: "A3"; cover_text: string } | { q: "A2"; claim: string }
  | { q: "Bscope"; n: number } | { q: "Bviol"; n: number; field: string } | { q: "O"; quote: string; rule: string };

// ---- A ----

const A1_CRITERIA = {
  准确: "标题和文案说的事，字幕里确实讲了，没有夸大或改变意思",
  部分偏离: "大体相关，但有一部分是字幕里没讲的、或被夸大 / 改变了侧重",
  误导: "标题或文案承诺或暗示了字幕里没有的内容，看完会觉得被骗",
  无法判断: "字幕内容不足以判断",
};
const A3_CRITERIA = {
  讲清问题或答案: "封面字点明了视频要解决的问题或给出的答案",
  "只是开头笑点/噱头": "封面字只是视频开头的一个笑点、梗或噱头，看封面猜不到视频讲什么",
  与主题无关: "封面字和视频主题没有关系",
  无法判断: "信息不足以判断",
};

const NUM_UNIT = /\d+(?:\.\d+)?\s*(?:%|％|倍|万|亿|千|百|个|次|天|小时|分钟|秒|年|月|周|人|元|块|美元|条|步|种|款|家|行|字|[kKwW])/g;
const QUOTED = /[「『“"]([^」』”"]{2,40})[」』”"]/g;
const SUPERLATIVE = /[^，。！？,.!?\s]{0,12}(?:第一|唯一|最[一-龥]{1,3})[^，。！？,.!?\s]{0,12}/g;
const MAX_CLAIMS = 12;

/** 代码先抽候选说法：数字+单位 / 百分比、引号里的话、「第一 / 唯一 / 最」类 */
export function extractClaims(text: string): Array<{ claim: string; numeric: boolean }> {
  const out: Array<{ claim: string; numeric: boolean }> = [];
  const push = (claim: string, numeric: boolean) => { const c = claim.trim(); if (c && !out.some((x) => x.claim === c)) out.push({ claim: c, numeric }); };
  for (const m of text.matchAll(NUM_UNIT)) push(m[0], true);
  for (const m of text.matchAll(QUOTED)) push(m[1], false);
  for (const m of text.matchAll(SUPERLATIVE)) push(m[0], false);
  return out.slice(0, MAX_CLAIMS);
}

const squash = (s: string) => s.replace(/\s+/g, "").replace(/％/g, "%");

export interface AInput { platform: string; title: string; caption: string; coverText: string | null; scriptTitle: string; basis: Basis }

/** 返回 Jev 请求（可能没有问题可问 → null）与代码直接判掉的数值说法 */
export function buildA(input: AInput): { request: SemanticRequest | null; codeItems: CheckItem[] } {
  const questions: Record<string, JevQuestion> = {};
  const meta: Record<string, QuestionMeta> = {};
  const codeItems: CheckItem[] = [];
  questions.a1 = { type: "choice", instructions: "`post_title` 和 `caption` 是否准确反映了 `subtitles` 里这条视频实际讲的事？", criteria: A1_CRITERIA };
  meta.a1 = { q: "A1" };
  const claims = extractClaims(`${input.title}\n${input.caption}`);
  const basisText = squash(input.basis.text);
  claims.forEach((c, i) => {
    if (c.numeric && basisText.includes(squash(c.claim))) {
      codeItems.push({ check: "A2 说法有据", result: "pass", basis: `「${c.claim}」在${input.basis.kind === "srt" ? "字幕" : "定稿正文"}里逐字出现（代码直接判）`, field: "title/caption" });
      return;
    }
    questions[`a2_${i}`] = { type: "noul", instructions: { claim: c.claim, question: "`subtitles` 是否说过或直接支持 `claim` 这句说法？否定、时间范围、因果关系都要对得上。" }, criteria: { true: "字幕说过，或直接支持这句", false: "字幕没说过，或说的意思不同" } };
    meta[`a2_${i}`] = { q: "A2", claim: c.claim };
  });
  if (input.coverText) {
    questions.a3 = { type: "choice", instructions: "`cover_text` 是封面上的大字。它和 `subtitles` 里这条视频的主题是什么关系？", criteria: A3_CRITERIA };
    meta.a3 = { q: "A3", cover_text: input.coverText };
  }
  const state = { subtitles: input.basis.text, platform: input.platform, post_title: input.title, caption: input.caption, cover_text: input.coverText ?? "", script_title: input.scriptTitle };
  return { request: { kind: "A", state, questions, meta }, codeItems };
}

// ---- B ----

export const B_FIELDS = ["平台集合", "账号", "标题", "文案", "标签", "封面", "排期", "活动"] as const;
const NO_FIELD = "不约束发布内容";

export interface Instruction { n: number; source: "原话" | "网页指令" | "发布规则"; text: string }

export const RULE_LABEL: Record<string, string> = {
  platform_missing: "漏发平台", cover_ratio: "封面比例（缺上传槽）", cover_extra_ratio: "封面比例（规则外比例）", cover_registered: "封面必须是登记的那一对",
  cut_registered: "成片必须是登记的那一份", cover_text: "封面字与选封面时一致", title_limit: "标题字数", caption_limit: "文案字数", tags_format: "标签格式",
  schedule_tz: "排期带时区", ownership: "内容归属",
};

export interface BEntryView { platform: string; 平台集合: string[]; 账号: string | null; 标题: string; 文案: string; 标签: string[]; 封面: Array<{ 用途: string | null; 比例: string | null; 文件: string }>; 排期: string | null; 活动: unknown[] }

export function buildB(entry: BEntryView, instructions: Instruction[], overrides: Override[]): SemanticRequest | null {
  if (!instructions.length && !overrides.length) return null;
  const questions: Record<string, JevQuestion> = {};
  const meta: Record<string, QuestionMeta> = {};
  for (const ins of instructions) {
    questions[`s${ins.n}`] = {
      type: "choice",
      instructions: { instruction: ins.text, question: "`instruction` 是创始人关于这次发布的一条要求。它约束的是发布条目里的哪个字段？" },
      criteria: Object.fromEntries([...B_FIELDS.map((f) => [f, `约束 \`entry\` 的「${f}」`]), [NO_FIELD, "这句不约束发布内容（闲聊、情绪、与发布无关）"]]),
    };
    meta[`s${ins.n}`] = { q: "Bscope", n: ins.n };
    B_FIELDS.forEach((f, k) => {
      questions[`v${ins.n}_${k}`] = { type: "noul", instructions: { instruction: ins.text, field: f, question: "`entry` 这个平台条目的 `field` 字段是否违反了 `instruction` 这条要求？" }, criteria: { true: "违反了", false: "没有违反，或这条要求与这个字段无关" } };
      meta[`v${ins.n}_${k}`] = { q: "Bviol", n: ins.n, field: f };
    });
  }
  overrides.forEach((o, j) => {
    questions[`o${j}`] = { type: "noul", instructions: { founder_quote: o.founder_quote, platform: entry.platform, rule: RULE_LABEL[o.rule] ?? o.rule, question: "`founder_quote` 这句原话是否在要求对 `platform` 的「`rule`」这条规则破例？" } };
    meta[`o${j}`] = { q: "O", quote: o.founder_quote, rule: o.rule };
  });
  return { kind: "B", state: { entry }, questions, meta };
}

// ---- 判读 ----

const pct = (p: number) => `${Math.round(p * 100)}%`;
const choiceProb = (a: JevAnswer) => (a.type === "choice" ? a.probabilities[a.choice] ?? 0 : a.noul);

function readA(id: string, m: QuestionMeta, a: JevAnswer, basis: Basis): CheckItem | null {
  if (m.q === "A1" && a.type === "choice") {
    const result = a.choice === "准确" ? "pass" : a.choice === "无法判断" ? "unchecked" : "warn";
    return { check: "A1 标题文案与视频一致", result, field: "title/caption", basis: `Jev 判「${a.choice}」（${pct(choiceProb(a))}）；${basis.note}`, jev: { question: id, answer: a.choice, probability: choiceProb(a) } };
  }
  if (m.q === "A2" && a.type === "noul") {
    const supported = a.noul >= 0.5;
    const result = supported ? "pass" : basis.truncated ? "unchecked" : "warn";
    const why = supported ? "字幕支持" : basis.truncated ? `未覆盖（${basis.note}，不据此提醒）` : "字幕里没找到支持";
    return { check: "A2 说法有据", result, field: "title/caption", basis: `「${m.claim}」：${why}（支持概率 ${pct(a.noul)}）`, jev: { question: id, answer: a.noul, probability: a.noul } };
  }
  if (m.q === "A3" && a.type === "choice") {
    const result = a.choice === "讲清问题或答案" ? "pass" : a.choice === "无法判断" ? "unchecked" : "warn";
    return { check: "A3 封面字点题", result, field: "cover_text", basis: `封面字「${m.cover_text}」：Jev 判「${a.choice}」（${pct(choiceProb(a))}）`, jev: { question: id, answer: a.choice, probability: choiceProb(a) } };
  }
  return null;
}

/** 约束该字段的概率门槛：scope 的 choice 就是它，或它的概率 ≥ 0.25（一条话可能同时约束两个字段） */
const SCOPE_MIN = 0.25;

function readB(answers: Record<string, JevAnswer>, meta: Record<string, QuestionMeta>, instructions: Instruction[]): CheckItem[] {
  const items: CheckItem[] = [];
  for (const ins of instructions) {
    const scope = answers[`s${ins.n}`];
    if (!scope || scope.type !== "choice") continue;
    const tag = `第 ${ins.n} 条（${ins.source}）「${ins.text}」`;
    if (scope.choice === NO_FIELD) { items.push({ check: "B 执行符合指令", result: "pass", basis: `${tag}：不约束发布内容（${pct(choiceProb(scope))}）` }); continue; }
    const hits: CheckItem[] = [];
    B_FIELDS.forEach((f, k) => {
      const p = scope.probabilities[f] ?? 0;
      const v = answers[`v${ins.n}_${k}`];
      if ((scope.choice !== f && p < SCOPE_MIN) || !v || v.type !== "noul" || v.noul < 0.5) return;
      hits.push({ check: "B 执行符合指令", result: "warn", field: f, basis: `${tag}：「${f}」看着违反了这条（违反概率 ${pct(v.noul)}，约束该字段 ${pct(p)}）`, jev: { question: `v${ins.n}_${k}`, answer: v.noul, probability: v.noul } });
    });
    items.push(...(hits.length ? hits : [{ check: "B 执行符合指令", result: "pass" as const, field: scope.choice, basis: `${tag}：约束「${scope.choice}」，未见违反` }]));
  }
  for (const [id, m] of Object.entries(meta)) {
    if (m.q !== "O") continue;
    const a = answers[id];
    if (!a || a.type !== "noul") continue;
    items.push(a.noul >= 0.5
      ? { check: "例外原话核对", result: "pass", rule: m.rule, basis: `「${m.quote}」看着确实在要求这条例外（${pct(a.noul)}）` }
      : { check: "例外原话核对", result: "warn", rule: m.rule, basis: `这句原话看着不像在说这条例外：「${m.quote}」（${pct(a.noul)}）`, jev: { question: id, answer: a.noul, probability: a.noul } });
  }
  return items;
}

export function interpret(req: SemanticRequest, answers: Record<string, JevAnswer>, ctx: { basis?: Basis; instructions?: Instruction[] }): CheckItem[] {
  if (req.kind === "B") return readB(answers, req.meta, ctx.instructions ?? []);
  const out: CheckItem[] = [];
  for (const [id, m] of Object.entries(req.meta)) {
    const a = answers[id];
    const item = a && ctx.basis ? readA(id, m, a, ctx.basis) : null;
    if (item) out.push(item);
  }
  return out;
}
