/**
 * `autocrew_content summary`（spec v1.3 §1）：只读，只回「这篇到哪了」——不带正文，≤1.5KB。
 * 「卡在哪」复用现有判定：认领（claims.activeClaim）、角度（angle-cards.activeAngleCard）、审稿结论（content.review）、
 * 证据门（needs_evidence 的 blockedReason / unverifiedNumbers）、写作包（pack 发出未回）、最近一次失败（lastError）。
 * 推断不出来就写「没有进行中的流程」（M5）；找不到 / 已删就明说（M3）；认领只写谁、多久前，绝不带令牌（M4）。
 */
import { activeClaim } from "../storage/claims.js";
import { CONTENT_STATUS_LABEL, getContent, getDataDir, getTopic, type Content, type ContentStatus } from "../storage/local-store.js";
import { activeAngleCard } from "../modules/research/angle-cards.js";
import { resolveEffectiveBrief } from "../modules/research/brief-snapshot.js";
import { topicHashOf } from "../modules/research/research-job-store.js";
import { explainContent } from "../modules/production/read.js";
import type { Explanation } from "../modules/production/explain.js";
import { isOntologyActive } from "../storage/production-store.js";
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
  待录制: "原片放进「我的内容/0 原片放这里」后用 autocrew_content record kind=aroll 报上来",
  剪辑中: "剪辑工位把成片 / 字幕 / 封面用 autocrew_content record 报上来；成片通过、选封面只能创始人在卡片上点",
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
export function fitBudget(out: Record<string, unknown>, part: ProductionPart | null): Record<string, unknown> {
  const merged = () => ({ ...out, ...part?.fields });
  const size = () => Buffer.byteLength(JSON.stringify(merged()));
  while (part && size() > SUMMARY_BUDGET && part.shrink()) { /* 先截 changes，再截候选依据，再给原片行分页 */ }
  if (size() > SUMMARY_BUDGET && Array.isArray(out.blockers)) out.blockers = (out.blockers as string[]).slice(0, 1).map((b) => clip(b, 40));
  if (size() > SUMMARY_BUDGET && part) part.fields.candidates = [];
  if (size() > SUMMARY_BUDGET) { out.reason = clip(String(out.reason ?? ""), 20); out.next = clip(String(out.next ?? ""), 40); }
  if (size() <= SUMMARY_BUDGET) return merged();
  return minimalShape(out, part);
}

/**
 * 最后手段（Codex 审 segB11 P2）：只留 ok / id / stage、必需的那一行原片（全路径，agent 要原样用）和翻页游标。
 * 必需路径本身就超预算时照样返回并标 oversize——上限的唯一例外，路径不截。
 */
function minimalShape(out: Record<string, unknown>, part: ProductionPart | null): Record<string, unknown> {
  const f = part?.fields ?? {};
  const row = (f.aroll as Array<{ fact_id: string; state: string; round: number; path?: string }> | undefined)?.[0];
  const keep = ["changes", "has_more", "next_since_seq", "latest_seq", "aroll_has_more", "aroll_next_offset"];
  const minimal: Record<string, unknown> = { ok: out.ok, id: out.id, stage: out.stage,
    ...(row ? { aroll: [{ fact_id: row.fact_id, state: row.state, round: row.round, ...(row.path ? { path: row.path } : {}) }] } : {}),
    ...Object.fromEntries(keep.filter((k) => f[k] !== undefined).map((k) => [k, f[k]])) };
  return Buffer.byteLength(JSON.stringify(minimal)) > SUMMARY_BUDGET ? { ...minimal, oversize: true } : minimal;
}

export async function contentSummary(id: string, dataDir?: string, now = Date.now(), sinceSeqRaw?: unknown, arollOffsetRaw?: unknown): Promise<Record<string, unknown>> {
  if (!id) return { ok: false, error: "id is required for summary" };
  const since = parseSinceSeq(sinceSeqRaw);
  if (!since.ok) return { ok: false, code: "bad_param", error: "since_seq 要是非负整数（用上次 summary 回的 next_since_seq）" };
  const offset = parseSinceSeq(arollOffsetRaw);
  if (!offset.ok) return { ok: false, code: "bad_param", error: "aroll_offset 要是非负整数（用上次 summary 回的 aroll_next_offset）" };
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
  }, part);
}
