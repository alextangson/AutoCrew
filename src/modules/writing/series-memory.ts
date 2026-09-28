/**
 * 系列记忆（spec 2026-09-28 §3 A/B、§4）：稿件摘要 outline、近期稿件快照、系列比对结构校验、长度提示。
 *
 * 服务端只做确定性的事：按口径挑稿、冻结、校验引用和覆盖。「意思是不是重复」由宿主审稿人判断，这里不调模型。
 * 首版假设一个资料目录只对应一个创作者账号（快照不区分账号）。
 */
import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { listContents, type Content } from "../../storage/local-store.js";
import { draftHash } from "../../storage/draft-hash.js";
import { SERIES_STATES } from "../../storage/series-transaction.js";
import { canonicalJson } from "../research/brief-snapshot.js";

const sentence = Type.String({ minLength: 1, maxLength: 600 });
const POINT_KINDS = ["case", "cause", "demo", "boundary", "firsthand"] as const;
const SAID_KINDS = ["concept", "judgment", "metaphor", "example"] as const;
const literals = <T extends readonly string[]>(xs: T) => Type.Union(xs.map((x) => Type.Literal(x)));

export const outlineSchema = Type.Object({
  thesis: Type.String({ minLength: 1, maxLength: 200, description: "中心思想，一句话" }),
  points: Type.Array(Type.Object({
    text: sentence,
    kind: literals(POINT_KINDS),
    seconds: Type.Number({ minimum: 0, maximum: 3600, description: "估时（秒），只是规划信息" }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
  structure: Type.Object({ opening: sentence, progression: sentence, ending: sentence }, { additionalProperties: false }),
  said: Type.Array(Type.Object({
    id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,40}$" }),
    kind: literals(SAID_KINDS),
    text: Type.String({ minLength: 1, maxLength: 200, description: "按意思记，一句话" }),
  }, { additionalProperties: false }), { maxItems: 40 }),
  techniqueNotes: Type.Optional(sentence),
}, { additionalProperties: false, description: "submit：新写作包必填的稿件摘要——中心思想、信息点（带类型和估时）、骨架、按意思记下的「说过的东西」；卡冲突的取舍写 techniqueNotes" });
export type Outline = Static<typeof outlineSchema>;

/** 结构不对返回原因（人话），合格返回 null */
export function checkOutline(raw: unknown): string | null {
  if (!Value.Check(outlineSchema, raw)) {
    const first = Value.Errors(outlineSchema, raw).First();
    return `${first?.path || "outline"} ${first?.message ?? "结构不符"}；需要 thesis、points[{text,kind,seconds}]、structure{opening,progression,ending}、said[{id,kind,text}]`;
  }
  if (new Set(raw.said.map((s) => s.id)).size !== raw.said.length) return "said 里的 id 重复";
  return null;
}

export const techniqueRefsSchema = Type.Array(Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false }), { maxItems: 10, description: "submit：用了哪些已审手法卡 [{id,version}]，可为空；只能用本包冻结的目录" });
export type TechniqueRef = Static<typeof techniqueRefsSchema>[number];

export const gapSchema = Type.Object({
  available: Type.String({ minLength: 1, maxLength: 2000, description: "已有什么材料" }),
  missing: Type.String({ minLength: 1, maxLength: 2000, description: "缺什么" }),
  questions: Type.Array(Type.String({ minLength: 1, maxLength: 600 }), { minItems: 1, maxItems: 10, description: "要创始人回答的问题" }),
}, { additionalProperties: false, description: "gap：材料补不上时的缺口记录" });
export type GapRecord = Static<typeof gapSchema> & { packId: string; at: string };

// ─── 快照 ───────────────────────────────────────────────────────────────────

export { SERIES_STATES };
export const SERIES_WINDOW_DAYS = 30;
export const SERIES_MAX_ITEMS = 10;
/** 每条摘要进快照的上限（字符）；超出截断并标注 */
export const SERIES_ITEM_BUDGET = 1500;
const EXCERPT_CHARS = 300;

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface SeriesEntry { id: string; text: string }
export interface SeriesItem {
  content_id: string;
  draft_hash: string;
  /** 摘要版本号；0 = 没有有效摘要 */
  outline_version: number;
  title: string;
  label: "已发" | "待发（写过，观众还没看到）";
  enteredAt: string;
  /** 可引用的比对条目：thesis / structure:* / said:<id>，或覆盖不足时的 opening / ending */
  entries: SeriesEntry[];
  insufficient: boolean;
  truncated: boolean;
  note?: string;
}
export interface SeriesSnapshot { id: string; platform: string; builtAt: string; items: SeriesItem[] }

/** 摘要只对写它时的那版正文有效；正文改了（含选区改写、回滚到别的版本）即失效，退回原文节选 */
export function validOutline(c: Pick<Content, "title" | "body" | "platform" | "outline" | "outlineDraftHash">): Outline | null {
  return c.outline && c.outlineDraftHash === draftHash(c) ? c.outline : null;
}

function enteredAt(c: Content): string {
  return c.seriesEnteredAt ?? (c.status === "published" && c.publishedAt ? c.publishedAt : c.draftReadyAt) ?? c.updatedAt;
}

function outlineEntries(o: Outline): { entries: SeriesEntry[]; truncated: boolean } {
  const all: SeriesEntry[] = [
    { id: "thesis", text: o.thesis },
    { id: "structure:opening", text: o.structure.opening },
    { id: "structure:progression", text: o.structure.progression },
    { id: "structure:ending", text: o.structure.ending },
    ...o.said.map((s) => ({ id: `said:${s.id}`, text: `[${s.kind}] ${s.text}` })),
  ];
  const entries: SeriesEntry[] = [];
  let used = 0;
  for (const e of all) {
    if (used + e.text.length > SERIES_ITEM_BUDGET) return { entries, truncated: true };
    entries.push(e);
    used += e.text.length;
  }
  return { entries, truncated: false };
}

function excerptEntries(body: string): { entries: SeriesEntry[]; truncated: boolean } {
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const first = paras[0] ?? "", last = paras.length > 1 ? paras[paras.length - 1] : "";
  const entries = [{ id: "opening", text: first.slice(0, EXCERPT_CHARS) }, ...(last ? [{ id: "ending", text: last.slice(-EXCERPT_CHARS) }] : [])];
  return { entries, truncated: first.length > EXCERPT_CHARS || last.length > EXCERPT_CHARS };
}

function toItem(c: Content, at: string): SeriesItem {
  const outline = validOutline(c);
  const { entries, truncated } = outline ? outlineEntries(outline) : excerptEntries(c.body);
  return {
    content_id: c.id,
    draft_hash: draftHash(c),
    outline_version: outline ? c.outlineVersion ?? 1 : 0,
    title: c.title.slice(0, 120),
    label: c.status === "published" ? "已发" : "待发（写过，观众还没看到）",
    enteredAt: at,
    entries,
    insufficient: !outline,
    truncated,
    ...(outline ? {} : { note: "覆盖不足：没有有效摘要，只放首尾原文，中段不在比对范围内" }),
  };
}

/**
 * 近期稿件快照（§3 B 口径）：同平台、白名单状态、最近 30 天进入这些状态、按时间倒序再按 id，同选题只取最新一版，最多 10 条。
 * 平台缺失的稿、本篇及同选题的其他版本（exclude：那是这篇自己的前身，不是系列里的另一条）、删除/归档稿都不进。
 */
export interface SeriesExclude { contentId?: string; topicId?: string }

export function buildSeriesSnapshot(contents: Content[], platform: string, exclude: SeriesExclude, now = Date.now()): SeriesSnapshot {
  const since = now - SERIES_WINDOW_DAYS * 86_400_000;
  const timed = contents
    .filter((c) => c.id !== exclude.contentId && !(exclude.topicId && c.topicId === exclude.topicId))
    .filter((c) => Boolean(platform) && c.platform === platform && SERIES_STATES.has(c.status))
    .map((c) => ({ c, at: enteredAt(c) }))
    .filter(({ at }) => { const t = Date.parse(at); return Number.isFinite(t) && t >= since && t <= now; })
    .sort((a, b) => b.at.localeCompare(a.at) || a.c.id.localeCompare(b.c.id));
  const seen = new Set<string>();
  const items: SeriesItem[] = [];
  for (const { c, at } of timed) {
    const key = c.topicId ?? `content:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(toItem(c, at));
    if (items.length === SERIES_MAX_ITEMS) break;
  }
  return { id: digest({ platform, items }), platform, builtAt: new Date(now).toISOString(), items };
}

/** 从资料目录现读一份快照（领包冻结、审稿前核对过时都用它） */
export async function loadSeriesSnapshot(platform: string, exclude: SeriesExclude, dataDir?: string, now = Date.now()): Promise<SeriesSnapshot> {
  return buildSeriesSnapshot(await listContents(dataDir), platform, exclude, now);
}

/** 冻结之后有没有新稿进入范围（或范围内的稿正文变了）：这些条目需要补审 */
export function snapshotAdditions(frozen: SeriesSnapshot, live: SeriesSnapshot): SeriesItem[] {
  return live.items.filter((i) => !frozen.items.some((o) => o.content_id === i.content_id && o.draft_hash === i.draft_hash));
}

// ─── 系列比对（审稿结果扩展） ─────────────────────────────────────────────────

export const seriesReviewSchema = Type.Object({
  snapshot_id: Type.String({ minLength: 1, maxLength: 100 }),
  checked: Type.Array(Type.String({ maxLength: 100 }), { maxItems: SERIES_MAX_ITEMS, description: "逐条查过的快照稿 content_id，必须覆盖快照全部条目" }),
  insufficient: Type.Array(Type.String({ maxLength: 100 }), { maxItems: SERIES_MAX_ITEMS, description: "覆盖不足（只有首尾原文）的 content_id，必须与快照标注一致" }),
  findings: Type.Array(Type.Object({
    content_id: Type.String({ maxLength: 100 }),
    item_id: Type.String({ maxLength: 60, description: "快照里该稿的条目 id，如 thesis、said:xxx、opening" }),
    quote: Type.String({ minLength: 2, maxLength: 200, description: "新稿中逐字引文" }),
    disposition: Type.Union([Type.Literal("blocker"), Type.Literal("allowed")]),
    reason: Type.String({ minLength: 1, maxLength: 600 }),
    issue_id: Type.Optional(Type.String({ maxLength: 100, description: "blocker 必须指向 issues 里同 id 的 blocker" })),
  }, { additionalProperties: false }), { maxItems: 40 }),
}, { additionalProperties: false });
export type SeriesReview = Static<typeof seriesReviewSchema>;

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));
}

/** 只校验结构：快照对得上、覆盖完整、引用的稿和条目在快照里、引文在新稿里、blocker 挂到 issues。 */
export function validateSeriesReview(
  raw: unknown, snapshot: SeriesSnapshot, issues: Array<{ id?: string; severity?: string }>, draftText: string,
): string | null {
  if (raw === undefined) return "新写作包的审稿必须提交 series_review（快照 id、逐条覆盖、比对结果），空 issues 不算查完";
  if (!Value.Check(seriesReviewSchema, raw)) return "series_review 结构不符：需要 snapshot_id、checked、insufficient、findings";
  if (raw.snapshot_id !== snapshot.id) return `series_review.snapshot_id 不是本次审稿包的快照（应为 ${snapshot.id}）`;
  if (!sameSet(raw.checked, snapshot.items.map((i) => i.content_id))) return "series_review.checked 必须逐条覆盖快照里的全部稿件，不能多也不能少";
  if (!sameSet(raw.insufficient, snapshot.items.filter((i) => i.insufficient).map((i) => i.content_id))) return "series_review.insufficient 必须如实列出快照中标注覆盖不足的稿件";
  for (const f of raw.findings) {
    const item = snapshot.items.find((i) => i.content_id === f.content_id);
    if (!item) return `series_review 引用的稿件 ${f.content_id} 不在快照里`;
    if (!item.entries.some((e) => e.id === f.item_id)) return `series_review 引用的条目 ${f.item_id} 不在快照稿 ${f.content_id} 里`;
    if (!draftText.includes(f.quote)) return `series_review 的引文「${f.quote.slice(0, 30)}」不在当前稿中，须逐字复制`;
    if (f.disposition === "blocker" && !issues.some((i) => i.id !== undefined && i.id === f.issue_id && i.severity === "blocker")) {
      return "系列重复判 blocker 时，issue_id 必须指向 issues 里同 id 的 blocker";
    }
  }
  return null;
}

// ─── 长度提示（永不进门禁） ────────────────────────────────────────────────────

export interface LengthHint {
  chars: number; min: number | null; max: number | null;
  status: "unknown" | "short" | "within" | "long";
  source: "requirements" | "profile" | null;
  advisory: true;
  note: string;
}

function parseRange(text: string | undefined): [number, number] | null {
  const m = text?.match(/(\d{2,5})\s*[-–—~～至到]\s*(\d{2,5})\s*字/);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a <= b ? [a, b] : null;
}

/** 字数口径：正文去掉空白后的字符数。上下限先看本次要求再看档案；解析不出就是 unknown，不猜。 */
export function lengthHint(text: string, requirements?: string, profileWordCount?: string): LengthHint {
  const chars = Array.from(text.replace(/\s/g, "")).length;
  const fromReq = parseRange(requirements);
  const range = fromReq ?? parseRange(profileWordCount);
  const source = fromReq ? "requirements" : range ? "profile" : null;
  const status = !range ? "unknown" : chars < range[0] ? "short" : chars > range[1] ? "long" : "within";
  return {
    chars, min: range?.[0] ?? null, max: range?.[1] ?? null, status, source, advisory: true,
    note: "只是提示，不打回、不扣修复次数；短了先补料或交缺口记录，别拿话去凑。估时和字数都证明不了材料真实或充分。",
  };
}

// ─── 写作包 / 审稿包里的用法说明 ─────────────────────────────────────────────

export const SERIES_WRITING_RULES = `【先规划再动笔（篇幅靠补料，不靠凑）】
1. 动笔前先写一句中心思想，列信息点并注明类型：case 真实案例 / cause 往下挖一层的原因 / demo 完整演示 / boundary 反方意见和边界 / firsthand 创始人亲历，每条估个时长。
2. 估出来够本次目标时长（或篇幅）就写。
3. 不够就按顺序补：先 find_evidence 领补证任务，自己查、scout read_page 抓页、cite 核对入账；再把原因往下挖一层；再请创始人补。
4. 仍然补不上，用 autocrew_writer gap{content_id,pack_id,gap:{available,missing,questions},claim_token} 交缺口记录，不交凑出来的稿。
估时只是规划，不能证明材料真实或充分。交稿必须附 outline：thesis、points[{text,kind,seconds}]、structure{opening,progression,ending}、said[{id,kind(concept|judgment|metaphor|example),text}]（按意思记下解释过的概念、下过的判断、用过的比喻和例子，每项一句话）。technique_ids[{id,version}] 可为空。

【系列记忆怎么用】
- 快照只是去重参考，不是事实证据，也不是观众已经知道的前提。
- 「已发」稿里解释过的词可以直接用；「待发」稿里解释过的照常讲，观众还没看过。
- 最近用过的开头和收尾，这条换一种。
- 中心思想要能一句话说出和快照里每一条的区别；说不出就停下来问创始人。
- 优先级：创作者本次明确要求 > 已选立意卡的骨架 > 手法卡。两张卡 id 不同不代表骨架不同；卡冲突由你取舍，写进 outline.techniqueNotes。`;

export const SERIES_REVIEW_RULES = `【系列比对（必交 series_review）】
逐条比对新稿和下面冻结的快照，按意思找已经说过的东西：
- 判 blocker：样板式解释换了说法；主线判断跟快照某条实质相同；用过的比喻或例子再次当主菜。blocker 要同时写进 issues（带 id），finding.issue_id 指向它。
- 放过（allowed，写理由）：为讲新东西顺带提一句的旧概念；明确承接「已发」稿（待发稿不能当承接）。
- series_review{snapshot_id, checked:[快照全部 content_id], insufficient:[覆盖不足的 content_id], findings:[{content_id,item_id,quote(新稿逐字),disposition,reason,issue_id?}]}；快照为空也要交（checked:[]）。
【凑数段】删掉以后中心思想、理解和节奏都不受影响，也没带来新的事实、原因、做法或必要过渡的段落，判 blocker：quote 用短引文定位，instruction 说明范围和「它没贡献什么」。叙事铺垫、必要转场、帮观众理解的类比放过。
创始人覆盖只豁免他指定的那一项（指定开头只豁免开头），且要有对应的用户决定；审稿人不能自己宣布豁免。`;

/** 写作包里渲染快照（空就写「暂无」） */
export function renderSnapshot(s: SeriesSnapshot | undefined): string {
  if (!s || !s.items.length) return `【近期同平台稿件快照】暂无（快照 id ${s?.id ?? "-"}）`;
  const lines = s.items.map((i) => [
    `■ ${i.content_id}《${i.title}》${i.label}${i.insufficient ? "｜覆盖不足：中段不在比对范围内" : ""}${i.truncated ? "｜已截断" : ""}`,
    ...i.entries.map((e) => `  - ${e.id}：${e.text}`),
  ].join("\n"));
  return `【近期同平台稿件快照 ${s.id}】\n${lines.join("\n")}`;
}
