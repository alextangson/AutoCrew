/**
 * `autocrew_content summary`（spec v1.3 §1）：只读，只回「这篇到哪了」——不带正文，≤1.5KB。
 * 「卡在哪」复用现有判定：认领（claims.activeClaim）、角度（angle-cards.activeAngleCard）、审稿结论（content.review）、
 * 证据门（needs_evidence 的 blockedReason / unverifiedNumbers）、写作包（pack 发出未回）、最近一次失败（lastError）。
 * 推断不出来就写「没有进行中的流程」（M5）；找不到 / 已删就明说（M3）；认领只写谁、多久前，绝不带令牌（M4）。
 */
import { isChatSource } from "../modules/production/decision-provenance.js";
import { activeClaim } from "../storage/claims.js";
import { CONTENT_STATUS_LABEL, getContent, getDataDir, getTopic, type Content, type ContentStatus } from "../storage/local-store.js";
import { activeAngleCard } from "../modules/research/angle-cards.js";
import { resolveEffectiveBrief } from "../modules/research/brief-snapshot.js";
import { topicHashOf } from "../modules/research/research-job-store.js";
import { explainContent } from "../modules/production/read.js";
import type { Explanation } from "../modules/production/explain.js";
import { isOntologyActive, readProductionDoc } from "../storage/production-store.js";
import { askRows, attachmentsChanged } from "../modules/production/asks.js";
import { readInbox } from "../modules/production/inbox-read.js";
import { isVideoPlatform } from "../storage/stage-guard.js";
import { productionPart, SUMMARY_BUDGET, type ProductionPart } from "./content-summary-production.js";

const EMPLOYEE: Record<string, string> = { writer: "写手", cover: "封面师", editor: "剪辑师" };
const minutesAgo = (iso: string | undefined, now: number): number | null => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)) : null);
const clip = (s: string, n: number): string => (Array.from(s).length > n ? `${Array.from(s).slice(0, n).join("")}…` : s);

/** 下一步建议：按阶段给一句能照做的话（不替人做决定） */
const NEXT: Partial<Record<ContentStatus, string>> = {
  topic_saved: "用 autocrew_workflow prepare 开始准备材料",
  drafting: "领写作包（autocrew_writer pack）后写稿并 submit",
  needs_evidence: "补证据（autocrew_writer find_evidence）或改掉没来源的数字后重交",
  draft_ready: "审稿（autocrew_review_desk pack → submit）",
  reviewing: "交审稿意见（autocrew_review_desk submit）",
  revision: "按审稿意见改稿后重交（autocrew_writer submit）",
  approved: "进入下一阶段（封面 / 剪辑 / 发布前检查）",
  editing: "等剪辑完成并登记成片",
  cover_pending: "定封面",
  publish_ready: "发布（需要创始人批准）",
  publishing: "等发布结果回来",
  published: "已发布，可看数据回流",
};

async function angleBlocker(c: Content, dataDir?: string): Promise<string | null> {
  if (!c.topicId || c.usedAngle || !["topic_saved", "drafting"].includes(c.status)) return null;
  const topic = await getTopic(c.topicId, dataDir).catch(() => null);
  if (!topic) return null;
  const snap = await resolveEffectiveBrief(topic.id, getDataDir(dataDir)).catch(() => null);
  if (!snap) return null;
  return activeAngleCard(topic.selectedAngle, snap.brief, topicHashOf(topic.title, topic.description)) ? null : "还没选角度（调研简报里有候选，等创始人在选题页选）";
}

function blockersOf(c: Content, now: number): string[] {
  const out: string[] = [];
  const claim = activeClaim(c, now);
  if (claim) out.push(`被 ${claim.host}（${EMPLOYEE[claim.employee] ?? claim.employee}）认领，${minutesAgo(claim.at, now) ?? "?"} 分钟前`);
  if (c.status === "needs_evidence") out.push(`证据门没过：${clip(c.blockedReason ?? "有数字缺来源", 80)}${c.unverifiedNumbers?.length ? `（${c.unverifiedNumbers.length} 处）` : ""}`);
  const blockers = c.review?.issues?.filter((i) => i.severity === "blocker") ?? [];
  if (blockers.length && c.review?.status !== "stale") out.push(`审稿还有 ${blockers.length} 条必须改：${clip(`${blockers[0].rule}：${blockers[0].instruction}`, 60)}`);
  if (c.pack && !c.pack.submittedAt && c.status === "drafting") out.push(`写作包已发给 ${c.pack.host}，${minutesAgo(c.pack.issuedAt, now) ?? "?"} 分钟未交稿`);
  if (c.lastError) out.push(`上次失败：${clip(c.lastError, 80)}`);
  return out;
}

/** 按本体走的视频稿、制作段：阶段 / 卡点 / 下一步都取推导结果（explain），不看旧状态表 */
const ONTOLOGY_NEXT: Record<string, string> = {
  待录制: "创始人把原片放进「我的内容/0 原片放这里」、说是哪条后，用 autocrew_review_inbox inbox_list → inbox_attach 挂上",
  剪辑中: "剪辑工位把成片 / 字幕 / 封面用 autocrew_content record 报上来；成片通过、选封面只能创始人在「等你拍板」里点",
  待发布: "先 autocrew_publish check，再带各平台 check_ids 调 ego_lite_prepare；最终点击前停下问创始人",
  已发布: "已发布，可看数据回流",
};

async function ontologyView(c: Content, dataDir?: string): Promise<Explanation | null> {
  if (!isVideoPlatform(c.platform) || !(await isOntologyActive(dataDir, c.id))) return null;
  return explainContent(c, getDataDir(dataDir));
}

/** since_seq 可能被中转端点当字符串传来：数字串照收，别的明确拒 */
function parseSinceSeq(raw: unknown): { ok: true; value: number | undefined } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
}

/**
 * 总长 ≤ 1.5 KB 一定成立（Codex 审 segB7 P2）：先让制作段自己缩（changes、依据、原因、原片行分页），
 * 还超就缩通用字段（卡点只留第一条、截短、去掉候选依据），最后只留最小形状。
 */
/** 请示那一段（review-inbox §5.2）：自己的截短与翻页（先截回答原话，再少给几行），和 changes / 原片游标互不相干 */
export interface AsksPart { fields: Record<string, unknown>; shrink: () => boolean; minimal: () => Record<string, unknown> }

export function fitBudget(out: Record<string, unknown>, part: ProductionPart | null, asks: AsksPart | null = null): Record<string, unknown> {
  const merged = () => ({ ...out, ...part?.fields, ...asks?.fields });
  const size = () => Buffer.byteLength(JSON.stringify(merged()));
  while (part && size() > SUMMARY_BUDGET && part.shrink()) { /* 先截 changes，再截候选依据，再给原片行分页 */ }
  // 条目 id 只是提示（总数照给）：放不下先少给几个，再动请示
  const ids = (out.inbox as { item_ids?: string[] } | undefined)?.item_ids;
  while (ids && ids.length && size() > SUMMARY_BUDGET) ids.pop();
  // 修改意见放不下：原话截到 80 字（agent 至少看得到意思和时间）
  for (const r of (out.rejections as Array<{ note: string }> | undefined) ?? []) if (size() > SUMMARY_BUDGET) r.note = clip(r.note, 80);
  while (asks && size() > SUMMARY_BUDGET && asks.shrink()) { /* 请示：截回答原话，再少给几行（游标跟着退） */ }
  if (size() > SUMMARY_BUDGET && Array.isArray(out.blockers)) out.blockers = (out.blockers as string[]).slice(0, 1).map((b) => clip(b, 40));
  if (size() > SUMMARY_BUDGET && part) part.fields.candidates = [];
  if (size() > SUMMARY_BUDGET) { out.reason = clip(String(out.reason ?? ""), 20); out.next = clip(String(out.next ?? ""), 40); }
  if (size() <= SUMMARY_BUDGET) return merged();
  return minimalShape(out, part, asks);
}

/**
 * 最后手段（Codex 审 segB11 P2）：只留 ok / id / stage、必需的那一行原片（全路径，agent 要原样用）和翻页游标；
 * 请示也至少留一行（已答的在前）和它的游标（Codex 审 2a-1 r2 P2）。
 * 必需路径本身就超预算时照样返回并标 oversize——上限的唯一例外，路径不截。
 */
function minimalShape(out: Record<string, unknown>, part: ProductionPart | null, asks: AsksPart | null = null): Record<string, unknown> {
  const f = part?.fields ?? {};
  const row = (f.aroll as Array<{ fact_id: string; state: string; round: number; path?: string }> | undefined)?.[0];
  const keep = ["changes", "has_more", "next_since_seq", "latest_seq", "aroll_has_more", "aroll_next_offset"];
  const rej = (out.rejections as Array<{ kind: string; note: string; at: string }> | undefined)?.map((r) => ({ kind: r.kind, note: clip(r.note, 40), at: r.at }));
  const minimal: Record<string, unknown> = { ok: out.ok, id: out.id, stage: out.stage, ...(out.inbox ? { inbox: { count: (out.inbox as { count: number }).count } } : {}),
    ...(row ? { aroll: [{ fact_id: row.fact_id, state: row.state, round: row.round, ...(row.path ? { path: row.path } : {}) }] } : {}),
    ...Object.fromEntries(keep.filter((k) => f[k] !== undefined).map((k) => [k, f[k]])), ...asks?.minimal(), ...(rej?.length ? { rejections: rej } : {}) };
  return Buffer.byteLength(JSON.stringify(minimal)) > SUMMARY_BUDGET ? { ...minimal, oversize: true } : minimal;
}

/** 请示一页最多几件（asks[] 用独立游标 asks_offset，不与 since_seq 混用，review-inbox §5.2 / R17） */
const ASKS_PAGE = 3;

/**
 * 创始人的修改意见（verifier 2a P1）：每类最近一次「还要改…」——原话、时间、针对哪一版（成片 fact_id）/ 哪几组封面。
 * agent 交新版前要先读这里。原话不截，预算紧时由 fitBudget 截短。
 */
async function rejectionsOf(c: Content, dataDir: string): Promise<Record<string, unknown>> {
  const doc = await readProductionDoc(c.id, dataDir).catch(() => null);
  if (!doc) return {};
  const last = (type: "cut_reject" | "cover_reject") => doc.decisions.filter((d) => d.round === doc.round && d.type === type).at(-1);
  const cut = last("cut_reject"), cover = last("cover_reject");
  // 对话里转述的「还要改」标出来源：那句原话是 agent 转述的，不是创始人在看板上写的
  const via = (d: { source: string }) => (isChatSource(d.source) ? { source: "chat" } : {});
  const rows = [
    ...(cut ? [{ kind: "cut", note: cut.note ?? "", at: cut.at, ...(cut.fact_id ? { fact_id: cut.fact_id } : {}), ...via(cut) }] : []),
    ...(cover ? [{ kind: "cover", note: cover.note ?? "", at: cover.at, ...(cover.group_ids ? { group_ids: cover.group_ids } : {}), ...via(cover) }] : []),
  ];
  return rows.length ? { rejections: rows } : {};
}

async function inboxOf(c: Content, dataDir: string): Promise<Record<string, unknown>> {
  const view = await readInbox(dataDir, { contentId: c.id }).catch(() => null);
  return view ? { inbox: { count: view.count, item_ids: view.items.slice(0, 5).map((i) => i.item_id), where: "等你拍板" } } : {};
}

/** 请示行：稳定顺序，每行带状态与答复；按 asks_offset 翻页 */
async function asksPart(c: Content, dataDir: string, offset: number): Promise<AsksPart | null> {
  const doc = await readProductionDoc(c.id, dataDir).catch(() => null);
  const all = doc ? askRows(doc, c) : [];
  if (!all.length) return null;
  // 固定集合 = 这条稿全部请示，按（发起时间, id）排、只用 asks_offset 翻页：状态在两页之间会变，但不会挪位置（Codex 审 2a-1）
  // 附件在请示之后变过：这件请示答不了，agent 要重发（verifier 2a P2）
  const rows = await Promise.all(all.map(async (r) => {
    const ask = doc!.asks!.find((x) => x.id === r.ask_id)!;
    return r.state === "open" && ask.attachments.length && await attachmentsChanged(c.id, ask, dataDir) ? { ...r, state: "stale_attachment", reason: "附件变过，请重新发请示" } : r;
  }));
  // 回答原话给全（verifier 2a P2），放不下才截：80 → 30 → 10
  let n = ASKS_PAGE, noteMax = Infinity;
  const fields: Record<string, unknown> = {};
  const render = () => {
    const page = rows.slice(offset, offset + n).map((r) => ({ ...r, ...(r.note ? { note: clip(r.note, noteMax) } : {}) }));
    fields.asks = page;
    if (offset + page.length < rows.length) fields.asks_next_offset = offset + page.length;
    else delete fields.asks_next_offset;
  };
  render();
  const shrink = () => {
    if (noteMax > 80) { noteMax = 80; render(); return true; }
    if (noteMax > 30) { noteMax = 30; render(); return true; }
    if (noteMax > 10) { noteMax = 10; render(); return true; }
    if (n > 1) { n -= 1; render(); return true; }
    return false;
  };
  const minimal = () => {
    const first = rows[offset];
    if (!first) return {};
    return { asks: [{ ask_id: first.ask_id, kind: first.kind, state: first.state, ...(first.option_id ? { option_id: first.option_id, via: first.via } : {}) }], ...(offset + 1 < rows.length ? { asks_next_offset: offset + 1 } : {}) };
  };
  return { fields, shrink, minimal };
}

export async function contentSummary(id: string, dataDir?: string, now = Date.now(), sinceSeqRaw?: unknown, arollOffsetRaw?: unknown, asksOffsetRaw?: unknown): Promise<Record<string, unknown>> {
  if (!id) return { ok: false, error: "id is required for summary" };
  const since = parseSinceSeq(sinceSeqRaw);
  if (!since.ok) return { ok: false, code: "bad_param", error: "since_seq 要是非负整数（用上次 summary 回的 next_since_seq）" };
  const offset = parseSinceSeq(arollOffsetRaw);
  if (!offset.ok) return { ok: false, code: "bad_param", error: "aroll_offset 要是非负整数（用上次 summary 回的 aroll_next_offset）" };
  const asksOffset = parseSinceSeq(asksOffsetRaw);
  if (!asksOffset.ok) return { ok: false, code: "bad_param", error: "asks_offset 要是非负整数（用上次 summary 回的 asks_next_offset）" };
  const c = await getContent(id, dataDir);
  if (!c || c.deletedAt) return { ok: false, code: "not_found", error: `找不到这篇稿（${id}）：不存在或已删除`, next_action: "用 autocrew_content list 看现有稿件" };
  const blockers = blockersOf(c, now);
  const angle = await angleBlocker(c, dataDir);
  if (angle) blockers.unshift(angle);
  const view = await ontologyView(c, dataDir);
  const exp = view?.phase === "production" ? view : null;
  const part = view ? await productionPart(c, view, getDataDir(dataDir), since.value, offset.value ?? 0) : null;
  if (exp) {
    blockers.unshift(...exp.missing.map((m) => `还差：${m}`), ...exp.alerts.map((a) => clip(a, 80)));
    if (exp.candidates.length) blockers.push(`有 ${exp.candidates.length} 个候选文件等创始人确认是不是这条`);
  }
  return fitBudget({
    ok: true,
    id: c.id,
    title: clip(c.title, 60),
    platform: c.platform ?? "",
    status: c.status ?? null,
    stage: exp?.stage ?? (c.status ? (CONTENT_STATUS_LABEL[c.status] ?? c.status) : "没有记录状态（旧稿或手写导入）"),
    ...(exp ? { reason: clip(exp.reason, 80) } : {}),
    blockers: blockers.length ? blockers : ["没有进行中的流程"],
    next: (exp?.stage ? ONTOLOGY_NEXT[exp.stage] : undefined) ?? NEXT[c.status] ?? "没有建议的下一步",
    updatedAt: c.updatedAt,
    words: Array.from((c.body ?? "").replace(/\s+/g, "")).length,
    ...(await inboxOf(c, getDataDir(dataDir))),
    ...(await rejectionsOf(c, getDataDir(dataDir))),
  }, part, await asksPart(c, getDataDir(dataDir), asksOffset.value ?? 0));
}
