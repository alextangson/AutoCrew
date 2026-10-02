/**
 * meeting_save 的入参归一与校验（系统边界：模型传来的工具参数）。
 *
 * 中转端点会把数组/对象序列化成 JSON 字符串、还可能带未转义的引号：数组照收、字符串解析、
 * 修引号重试，只有真解析不出来才打回；绝不把解析失败当成空片单（那等于静默丢掉会上的决定）。
 */
import { escapeStrayQuotes } from "../video/tool-args.js";
import { normalizePlatform } from "../flywheel/outcome-schema.js";
import { pullableMetric, PULLABLE_METRICS } from "../insights/metric-review.js";
import { emptyPayoffReason } from "../research/angle-meeting.js";
import { MEETING_FORMATS, PERSONA_TIER_KEYS, type MeetingFormat, type MeetingSlot, type PersonaTierKey } from "./meeting-store.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** 字符串 → JSON（失败修引号再试）；非字符串原样返回 */
export function decodeArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (!raw || !/^[[{]/.test(raw)) return value;
  try { return JSON.parse(raw); } catch {
    try { return JSON.parse(escapeStrayQuotes(raw)); } catch { throw new Error(`参数不是合法 JSON：${raw.slice(0, 60)}…`); }
  }
}

/** 数组参数：缺省 = 空；数组/JSON 串照收；其余打回（不当成空数组） */
export function listArg(value: unknown, field: string): Obj[] {
  if (value === undefined || value === null) return [];
  const decoded = decodeArg(value);
  if (!Array.isArray(decoded)) throw new Error(`${field} 必须是数组（收到 ${typeof decoded}）`);
  return decoded.map((item, i) => {
    const obj = decodeArg(item);
    if (!isObj(obj)) throw new Error(`${field}[${i}] 必须是对象`);
    return obj;
  });
}

const objArg = (value: unknown): Obj => { const d = decodeArg(value); return isObj(d) ? d : {}; };

function readWatch(raw: unknown, tag: string, errors: string[]): MeetingSlot["watch"] | null {
  const w = objArg(raw);
  const platform = normalizePlatform(text(w.platform));
  const metric = text(w.metric);
  const day = Number(w.day);
  if (!PULLABLE_METRICS[platform]) errors.push(`${tag}.watch.platform 只能是 ${Object.keys(PULLABLE_METRICS).join("/")}（B 站等不回流）`);
  else if (!pullableMetric(platform, metric)) errors.push(`${tag}.watch.metric「${metric}」不在 ${platform} 可回流表里：${PULLABLE_METRICS[platform].map((m) => m.metric).join("/")}`);
  if (day !== 3 && day !== 7) errors.push(`${tag}.watch.day 只能是 3 或 7（D+1 读数可能是发布后 7h 也可能 29h）`);
  return errors.length ? null : { platform, metric, day: day as 3 | 7 };
}

function readPersona(raw: unknown, tag: string, errors: string[]): MeetingSlot["persona"] | null {
  const p = objArg(raw);
  const key = text(p.key);
  if (!(PERSONA_TIER_KEYS as readonly string[]).includes(key) || !text(p.name)) {
    errors.push(`${tag}.persona 要 {key: core|adjacent|surprise, name: 档案里该层当前名字}`);
    return null;
  }
  return { key: key as PersonaTierKey, name: text(p.name) };
}

function requireText(o: Obj, keys: Array<[string, string]>, tag: string, errors: string[]): void {
  for (const [key, label] of keys) if (!text(o[key])) errors.push(`${tag}.${key}（${label}）必填`);
}

/** 一个片单位；hypothesisId 由保存时按日期+slotId 生成 */
export function readSlot(o: Obj, index: number, date: string): { slot: Omit<MeetingSlot, "title"> | null; errors: string[] } {
  const tag = `slots[${index}]`;
  const errors: string[] = [];
  requireText(o, [["topic_id", "选题 id"], ["payoff", "观众拿走什么"], ["why_now", "为什么现在"], ["data_basis", "数据依据，没有就写「无数据依据，纯判断」"], ["bet", "可证伪的一句假设"], ["premortem", "到期没中最可能的原因"]], tag, errors);
  const reason = emptyPayoffReason(text(o.payoff));
  if (reason) errors.push(`${tag}：${reason}`);
  const format = text(o.format);
  if (!(MEETING_FORMATS as readonly string[]).includes(format)) errors.push(`${tag}.format 只能是 ${MEETING_FORMATS.join("/")}`);
  const probability = Number(o.probability);
  if (o.probability === undefined || o.probability === "" || !Number.isFinite(probability) || probability < 0 || probability > 100) {
    errors.push(`${tag}.probability 必须是创始人给的 0-100 百分数（技能不代填）`);
  }
  const decision = text(o.angle_decision);
  if (decision && decision !== "rerun" && decision !== "accept_deviation") errors.push(`${tag}.angle_decision 只能是 rerun 或 accept_deviation`);
  const persona = readPersona(o.persona, tag, errors);
  const watch = readWatch(o.watch, tag, errors);
  if (text(o.bet).length > 200) errors.push(`${tag}.bet 超过 200 字`);
  if (errors.length || !persona || !watch) return { slot: null, errors };
  const slotId = text(o.slot_id) || `s${index + 1}`;
  return { errors, slot: {
    slotId, topicId: text(o.topic_id), hypothesisId: `hyp-meeting-${date}-${slotId}`, persona, payoff: text(o.payoff),
    format: format as MeetingFormat, ...(text(o.line) ? { line: text(o.line) } : {}), whyNow: text(o.why_now),
    dataBasis: text(o.data_basis), bet: text(o.bet), watch, probability, premortem: text(o.premortem),
    ...(decision ? { angleDecision: decision as "rerun" | "accept_deviation" } : {}),
  } };
}

export function readRejected(list: Obj[]): Array<{ topicId?: string; title: string; reason: string }> {
  return list.map((o, i) => {
    if (!text(o.title) || !text(o.reason)) throw new Error(`rejected[${i}] 需要 title 与 reason（毙题要带理由）`);
    return { ...(text(o.topic_id) ? { topicId: text(o.topic_id) } : {}), title: text(o.title), reason: text(o.reason) };
  });
}

export function readReviews(list: Obj[]): Array<{ hypothesisId: string; wouldRepeat: string }> {
  return list.map((o, i) => {
    if (!text(o.hypothesis_id) || !text(o.would_repeat)) throw new Error(`reviews[${i}] 需要 hypothesis_id 与 would_repeat（创始人的原话）`);
    return { hypothesisId: text(o.hypothesis_id), wouldRepeat: text(o.would_repeat) };
  });
}
