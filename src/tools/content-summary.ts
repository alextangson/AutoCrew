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

async function productionView(c: Content, dataDir?: string): Promise<Explanation | null> {
  if (!isVideoPlatform(c.platform) || !(await isOntologyActive(dataDir, c.id))) return null;
  const exp = await explainContent(c, getDataDir(dataDir));
  return exp.phase === "production" ? exp : null;
}

export async function contentSummary(id: string, dataDir?: string, now = Date.now()): Promise<Record<string, unknown>> {
  if (!id) return { ok: false, error: "id is required for summary" };
  const c = await getContent(id, dataDir);
  if (!c || c.deletedAt) return { ok: false, code: "not_found", error: `找不到这篇稿（${id}）：不存在或已删除`, next_action: "用 autocrew_content list 看现有稿件" };
  const blockers = blockersOf(c, now);
  const angle = await angleBlocker(c, dataDir);
  if (angle) blockers.unshift(angle);
  const exp = await productionView(c, dataDir);
  if (exp) {
    blockers.unshift(...exp.missing.map((m) => `还差：${m}`), ...exp.alerts.map((a) => clip(a, 80)));
    if (exp.candidates.length) blockers.push(`有 ${exp.candidates.length} 个候选文件等创始人确认是不是这条`);
  }
  return {
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
  };
}
