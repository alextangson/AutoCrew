import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { listContents, type Content } from "../../storage/local-store.js";
import { canonicalJson } from "../research/brief-snapshot.js";
const sentence = Type.String({ minLength: 1, maxLength: 600 });
export const outlineSchema = Type.Object({
  thesis: sentence,
  points: Type.Array(Type.Object({ text: sentence, kind: Type.Union([Type.Literal("case"), Type.Literal("cause"), Type.Literal("demo"), Type.Literal("boundary"), Type.Literal("firsthand")]), seconds: Type.Number({ minimum: 0, maximum: 3600 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
  structure: Type.Object({ opening: sentence, progression: sentence, ending: sentence }, { additionalProperties: false }),
  said: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }), kind: Type.Union([Type.Literal("concept"), Type.Literal("judgment"), Type.Literal("metaphor"), Type.Literal("example")]), text: sentence }, { additionalProperties: false }), { maxItems: 40 }),
  techniqueNotes: Type.Optional(sentence),
}, { additionalProperties: false });
export type Outline = Static<typeof outlineSchema>;
export const techniqueRefsSchema = Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), { maxItems: 10 });
export type TechniqueRef = Static<typeof techniqueRefsSchema>[number];
export const gapSchema = Type.Object({ available: sentence, missing: sentence, questions: Type.Array(sentence, { minItems: 1, maxItems: 10 }) }, { additionalProperties: false });
export type GapRecord = Static<typeof gapSchema> & { packId: string; at: string };
export const SERIES_STATES = new Set(["draft_ready", "approved", "editing", "publish_ready", "publishing", "published"]);
export function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export function draftHash(content: Pick<Content, "title" | "body" | "platform">): string {
  return createHash("sha256").update(JSON.stringify([content.title, content.body, content.platform])).digest("hex");
}
export interface SeriesItem {
  content_id: string; draft_hash: string; outline_version: number; title: string;
  label: "已发" | "待发（写过，观众还没看到）"; enteredAt: string;
  outline?: Outline; excerpts?: { opening: string; ending: string };
  items: Array<{ id: string; text: string }>;
  insufficient: boolean; truncated: boolean;
}
export interface SeriesSnapshot { id: string; platform: string; items: SeriesItem[] }
export async function seriesSnapshot(platform: string, exclude: string, dataDir?: string, now = Date.now()): Promise<SeriesSnapshot> {
  const contents = (await listContents(dataDir)).filter(c => c.id !== exclude && c.platform === platform && SERIES_STATES.has(c.status));
  const timed = contents.map(c => ({ c, at: c.seriesEnteredAt ?? (c.status === "published" ? c.publishedAt : c.draftReadyAt) ?? "" }))
    .filter(({ at }) => Number.isFinite(Date.parse(at)) && Date.parse(at) >= now - 30 * 86400_000 && Date.parse(at) <= now)
    .sort((a, b) => b.at.localeCompare(a.at) || a.c.id.localeCompare(b.c.id));
  const seen = new Set<string>();
  const items: SeriesItem[] = [];
  for (const { c, at } of timed) {
    const key = c.topicId ?? c.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const valid = c.outline && c.outlineDraftHash === draftHash(c);
    const raw = valid ? c.outline : undefined;
    // Bound each summary to 6000 characters; never truncate serialized JSON into invalid data.
    const outline = raw && JSON.stringify(raw).length <= 6000 ? raw : undefined;
    const paragraphs = c.body.split(/\n\s*\n/).filter(p => p.trim());
    const excerpts = { opening: (paragraphs[0] ?? "").slice(0, 600), ending: (paragraphs.at(-1) ?? "").slice(-600) };
    items.push({ content_id: c.id, draft_hash: draftHash(c), outline_version: c.outlineVersion ?? 0,
      title: c.title.slice(0, 200), label: c.status === "published" ? "已发" : "待发（写过，观众还没看到）", enteredAt: at,
      ...(outline ? { outline } : { excerpts }),
      items: outline ? [{ id: "thesis", text: outline.thesis }, ...Object.entries(outline.structure).map(([id, text]) => ({ id: `structure:${id}`, text })), ...outline.said.map(s => ({ id: `said:${s.id}`, text: s.text }))]
        : [{ id: "opening", text: excerpts.opening }, { id: "ending", text: excerpts.ending }],
      insufficient: !outline, truncated: Boolean(raw && !outline) || (!outline && paragraphs.some(p => p.length > 600)),
    });
    if (items.length === 10) break;
  }
  return { id: digest({ platform, items }), platform, items };
}
export const seriesReviewSchema = Type.Object({
  snapshot_id: Type.String(),
  checked: Type.Array(Type.String(), { maxItems: 20 }),
  insufficient: Type.Array(Type.String(), { maxItems: 20 }),
  findings: Type.Array(Type.Object({ content_id: Type.String(), item_id: Type.String(), quote: Type.String({ minLength: 1, maxLength: 200 }), disposition: Type.Union([Type.Literal("blocker"), Type.Literal("allowed")]), reason: sentence, issue_id: Type.Optional(Type.String()) }, { additionalProperties: false }), { maxItems: 40 }),
}, { additionalProperties: false });
export type SeriesReview = Static<typeof seriesReviewSchema>;
export function validateSeriesReview(raw: unknown, snapshot: SeriesSnapshot, issues: Array<{ id?: string; severity?: string }>, body: string): string | null {
  if (!Value.Check(seriesReviewSchema, raw)) return "series_review 必須完整提交快照、覆盖与比对结果";
  const same = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x));
  if (raw.snapshot_id !== snapshot.id || !same(raw.checked, snapshot.items.map(i => i.content_id)) || !same(raw.insufficient, snapshot.items.filter(i => i.insufficient).map(i => i.content_id))) return "series_review 快照或覆盖不完整";
  for (const finding of raw.findings) {
    const item = snapshot.items.find(i => i.content_id === finding.content_id);
    if (!item?.items.some(i => i.id === finding.item_id) || !body.includes(finding.quote) || !finding.reason.trim()) return "series_review 引用不在快照或当前稿中";
    if (finding.disposition === "blocker" && !issues.some(i => i.id === finding.issue_id && i.severity === "blocker")) return "重复 blocker 必须关联 issues 中的 blocker id";
  }
  return null;
}
export function lengthHint(body: string, requirements?: string, defaultWords?: string) {
  const parse = (s?: string) => s?.match(/(\d{2,5})\s*[-–—~～至到]\s*(\d{2,5})\s*字/);
  const range = parse(requirements) ?? parse(defaultWords);
  const chars = Array.from(body.replace(/\s/g, "")).length;
  return { chars, min: range ? Number(range[1]) : null, max: range ? Number(range[2]) : null,
    status: !range ? "unknown" : chars < Number(range[1]) ? "short" : chars > Number(range[2]) ? "long" : "within", advisory: true };
}
export const SERIES_INSTRUCTIONS = `先写中心思想和信息点（case/cause/demo/boundary/firsthand），逐条估时；不足七分钟先领取补证任务，查页、核对、入账，再挖原因，最后请创始人补充。仍不足则提交 gap，不交填充稿。估时不是事实或材料充分的证明。
新包提交 outline: thesis、points[{text,kind,seconds}]、structure{opening,progression,ending}、said[{id,kind,text}]；technique_ids[{id,version}] 可为空。
系列快照只作去重参考，不作事实依据或观众知识前提。已发稿概念可以直接用，待发稿概念仍须正常讲。换掉近期重复开头结尾；一句话说不出与每篇的主张区别就请创始人澄清。
审稿必须逐条提交 series_review：snapshot_id、checked、insufficient、findings。样板解释换词、主线判断相同、比喻案例重复当主菜判 blocker 并关联 issue_id；顺带旧概念或明确承接已发稿可 allowed，逐项写理由。
凑数段须用短引文定位、说明范围及缺少的贡献；删除后不损害主旨、理解和节奏且无新事实、原因、做法或必要过渡才是 blocker。铺垫、必要转场和助理解的类比可保留。
创始人覆盖只豁免指定项目，须有相应用户决定；宿主不能自行宣布豁免。明确要求 > 立意卡骨架 > 手法卡；手法 ID 不证明骨架不同，冲突取舍写进 outline.techniqueNotes。`;
