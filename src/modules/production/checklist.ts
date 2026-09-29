/**
 * 实拍版核对清单（本体 spec §5「实拍版核对清单，不挡发布」）：摘自 confident-raman 的 retro-checklist，
 * 登记提交时对成片字幕跑一遍，落在项目 01-script/spoken/ 旁边。纯函数，不碰盘。
 *
 * 识别在整段口播上跑（与交接出处门同一个 `factualSentences`），跨两条字幕的归因才不漏
 * （「Anthropic 在一篇教小公司老板用 / AI 的教程里出过…」）；显示只取命中的数字 / 归因所在那几条字幕，
 * 归因再带下一条当上下文——字幕没有标点，整句常常几十秒，创始人没法判断。
 * 只有「明确匹配」才标已有出处：这条字幕（去空白与标点后）整段落在某条出处的正文摘录里，且那条出处的
 * 证据字段有效。不按数字相同自动匹配——现有 citations 绑的是正文偏移，不能套到字幕上（评审 #10）。
 */
import type { Content } from "../../storage/local-store.js";
import { factualSentences, type FactualSentence } from "../video/handoff/factual-sentences.js";
import { CREATOR_OPINION, type Citation } from "../video/handoff/project-evidence.js";
import { parseSrt, type SrtCue } from "../video/handoff/spoken.js";

/** 核验清单的一条：实拍口播里的数字 / 归因句，按字幕定位 */
export interface CheckItem {
  text: string;
  numbers: string[];
  attribution?: string;
  /** 第几条到第几条字幕（从 1 起，与 SRT 序号口径一致） */
  cue_from: number;
  cue_to: number;
  start_ms: number;
  end_ms: number;
  status: "sourced" | "unverified";
  evidence_id?: string;
}

const NORMALIZE_RE = /[\s，。！？；、,.!?;:：「」“”‘’『』（）()《》"'…—-]+/g;
const norm = (s: string) => s.replace(NORMALIZE_RE, "");

interface Spoken { text: string; spans: Array<{ start: number; end: number; cue: SrtCue; index: number }> }

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

/** 与 spokenFromSrt 同一种拼法（中文直接拼、西文补空格），但记下每条字幕在口播里的起止 */
function joinCues(cues: SrtCue[]): Spoken {
  let text = "";
  const spans: Spoken["spans"] = [];
  cues.forEach((cue, i) => {
    if (text && !(CJK.test(text.slice(-1)) || CJK.test(cue.text[0]))) text += " ";
    const start = text.length;
    text += cue.text;
    spans.push({ start, end: text.length, cue, index: i + 1 });
  });
  return { text, spans };
}

type Span = Spoken["spans"][number];

/**
 * 命中的数字 / 归因落在哪几条字幕；找不到原文就退回整句覆盖的字幕。
 * 归因原文是「句首到标记词」（没标点时能拖出几十秒），所以按标记词收尾那条定位，再带前一条（主语常在那里）。
 */
function hitCues(spoken: Spoken, s: FactualSentence): Span[] {
  const inSentence = spoken.spans.filter((sp) => sp.end > s.start && sp.start < s.end);
  const picked = new Set<Span>();
  const pick = (from: number, to: number) => inSentence.filter((sp) => sp.end > from && sp.start < to).forEach((sp) => picked.add(sp));
  for (const n of s.numbers) {
    const at = spoken.text.indexOf(n.trim(), s.start);
    if (at < 0 || at >= s.end) return inSentence;
    pick(at, at + n.trim().length);
  }
  if (s.attribution) {
    const at = spoken.text.indexOf(s.attribution, s.start);
    if (at < 0 || at >= s.end) return inSentence;
    const endAt = at + s.attribution.length - 1;
    const i = inSentence.findIndex((sp) => sp.end > endAt && sp.start <= endAt);
    inSentence.slice(Math.max(0, i - 1), i + 1).forEach((sp) => picked.add(sp));
  }
  return picked.size ? inSentence.filter((sp) => picked.has(sp)) : inSentence;
}

/** 证据字段有效：台账条目在、来源等级/原话/链接逐字对得上、有核查结论。创作者观点一律不算已核验 */
function citationValid(c: Citation, content: Pick<Content, "evidenceLedger">): boolean {
  if (c.sourceType === CREATOR_OPINION || !c.verification?.trim()) return false;
  const e = (content.evidenceLedger?.entries ?? []).find((x) => x.id === c.evidence_id);
  if (!e || e.source !== c.sourceType || e.quote !== c.quote || e.sourceUrl !== c.sourceUrl) return false;
  return c.sourceType !== "verified_quote" || (/^https?:\/\//.test(c.sourceUrl ?? "") && Boolean(c.quote.trim()));
}

export function buildChecklist(srtRaw: string, citations: readonly Citation[], content: Pick<Content, "evidenceLedger">): CheckItem[] {
  const spoken = joinCues(parseSrt(srtRaw));
  const valid = citations.filter((c) => citationValid(c, content));
  return factualSentences(spoken.text).map((s) => {
    const cues = hitCues(spoken, s);
    const text = cues.map((sp) => sp.cue.text).join(" ");
    const first = cues[0], last = cues[cues.length - 1];
    const hit = norm(text) !== "" ? valid.find((c) => norm(c.excerpt).includes(norm(text))) : undefined;
    return {
      text, numbers: s.numbers, ...(s.attribution ? { attribution: s.attribution } : {}),
      cue_from: first?.index ?? 0, cue_to: last?.index ?? 0,
      start_ms: first?.cue.startMs ?? 0, end_ms: last?.cue.endMs ?? 0,
      status: hit ? "sourced" : "unverified", ...(hit ? { evidence_id: hit.evidence_id } : {}),
    };
  });
}

/** 字幕最大结束时间（不是末条：按时间排序后取 max(endMs)，评审 #13） */
export function srtMaxEndMs(srtRaw: string): number {
  return parseSrt(srtRaw).reduce((max, c) => Math.max(max, c.endMs), 0);
}

/** 标黄不拦：末尾比成片短 10 秒以上 / 有字幕条超出成片（多半是粗剪字幕，由创始人判断） */
export function srtWarnings(srtRaw: string, finalMs: number): Array<"srt_short" | "srt_overflow"> {
  const maxEnd = srtMaxEndMs(srtRaw);
  const out: Array<"srt_short" | "srt_overflow"> = [];
  if (finalMs - maxEnd > 10_000) out.push("srt_short");
  if (maxEnd > finalMs) out.push("srt_overflow");
  return out;
}
