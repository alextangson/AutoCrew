/**
 * 2026-10-15 写法与范文上线的一次性迁移（spec §4、§15.3、§15.4、§5）。幂等，只认固定 id：
 * 1. 6 条待批规则 → disabled（仍是 pending 才改）；5 份手册提案 → stale（仍是 pending 才改）。不碰否决记录、不碰之后新增的。
 * 2. §4 表里挪走的 4 条生效规则加 skipPlatforms:["douyin"]：先按 id 找，再核原文开头；对不上就整次中止。
 * 3. 加底线「观众是不写代码的职场人」（platform:douyin，生效）。
 * 4. 5 本手册发布压缩版（templates/playbooks 的正文）成新版本；已经是这一版就不动。
 * 前后各算一次每个平台的生效规则，只允许抖音那一列变，否则中止。
 */
import { rulesForPlatform, type CreatorProfile, type WritingRule } from "../profile/creator-profile.js";
import type { PlaybookManifest } from "../playbook/types.js";

export const REASON = "2026-10-15 并入写法与范文";
export const FOUNDER_WORDS = "手册可以。提交这批文档，然后按方案把代码一期交给 builder。";
export const PENDING_RULES = ["2cf597d9-f3ba-41ca-9954-52c3ad2fd03b", "e0a12600-d836-40cf-a3a4-dedeaa27746b", "b5a1b79d-560e-419b-855c-b1b983c038f3",
  "7a5a0601-3bf5-401d-828d-fab28eae0c02", "b93ddfe6-ab9d-434e-af69-6a3379d058e3", "c3437b03-1f89-46ae-8fa7-7c5ca16a1279"];
export const STALE_PROPOSALS = ["pp-d1d665a4-2091-4b7a-a036-4b42d899f929", "pp-f82b0d2f-242d-4425-9068-140fc8d5b018", "pp-91f3843a-d09b-4cb2-a127-7719b9fbe3e8",
  "pp-a392b7da-9943-42bf-9fb5-58d1c458d0f1", "pp-09c22dea-f53a-4dc8-b0bd-e0f9d49b8e40"];
/** §4：挪进写法 / 手册 / 流程的生效规则（id → 原文开头，用来核对没被改过） */
export const SKIP_DOUYIN: Record<string, string> = {
  "d097387f-346f-44b9-a029-e2f6ba4d9d54": "先有我们自己的判断再动笔",
  "024a775a-0a25-4a80-985a-a60eb698a95e": "一条主线，一个类比走到底",
  "0ac1aaa0-eae7-4d67-a5ce-42e0ba0820ce": "第一句就点出一个具体对象",
  "600e31d6-648d-42b7-bc72-df357f5354c8": "同系列不撞车",
};
export const FLOOR_ID = "floor-douyin-audience-20261015";
export const FLOOR_RULE = "观众是不写代码的职场人。";
export const PLATFORMS = ["douyin", "xiaohongshu", "wechat_video", "bilibili", "wechat_mp", "youtube"];

export class MigrationError extends Error {}

const statusOf = (r: WritingRule) => r.status ?? (r.disabled ? "disabled" : "active");

/** 在内存里改档案（干跑和真跑共用），返回逐条日志；对不上就抛 */
export function migrateRules(p: CreatorProfile, now: string): string[] {
  const log: string[] = [];
  const byId = new Map(p.writingRules.map((r) => [r.id, r]));
  for (const [id, head] of Object.entries(SKIP_DOUYIN)) {
    const r = byId.get(id);
    if (!r) throw new MigrationError(`规则 ${id} 不在档案里：§4 的表对不上，整次中止`);
    if (!r.rule.trim().startsWith(head)) throw new MigrationError(`规则 ${id} 的原文变了（现在是「${r.rule.slice(0, 30)}…」，预期以「${head}」开头）：整次中止，请人工核对`);
    if (r.skipPlatforms?.includes("douyin")) { log.push(`= ${id} 已经跳过抖音`); continue; }
    r.skipPlatforms = [...(r.skipPlatforms ?? []), "douyin"];
    r.revision = (r.revision ?? 1) + 1;
    log.push(`✓ ${id} 加 skipPlatforms:[douyin]（${head}）`);
  }
  for (const id of PENDING_RULES) {
    const r = byId.get(id);
    if (!r) { log.push(`- 待批规则 ${id} 不在档案里，跳过`); continue; }
    if (statusOf(r) !== "pending") { log.push(`= 待批规则 ${id} 现在是 ${statusOf(r)}，不动`); continue; }
    Object.assign(r, { status: "disabled", disabled: true, disabledReason: REASON, revision: (r.revision ?? 1) + 1 });
    p.ruleDecisions = [...(p.ruleDecisions ?? []), { eventId: `migrate-20261015-${id}`, ruleId: id, revision: r.revision!, decision: "disabled", at: now, source: "migration", founder_words: FOUNDER_WORDS }];
    log.push(`✓ 待批规则 ${id} → disabled（${REASON}）`);
  }
  if (byId.has(FLOOR_ID)) log.push(`= 底线「${FLOOR_RULE}」已在`);
  else {
    p.writingRules.push({ id: FLOOR_ID, revision: 1, status: "active", disabled: false, rule: FLOOR_RULE, scope: "platform:douyin", source: "user_explicit", confidence: 1, evidence: [`创始人确认方案 §4（${FOUNDER_WORDS}）`], createdAt: now } as WritingRule);
    log.push(`✓ 新增底线 platform:douyin「${FLOOR_RULE}」`);
  }
  return log;
}

/** 手册提案 → stale（仍 pending 才改） */
export function migrateProposals(m: PlaybookManifest, now: string): string[] {
  const log: string[] = [];
  for (const id of STALE_PROPOSALS) {
    const hit = m.playbooks.flatMap((e) => e.proposals.map((p) => ({ e, p }))).find((x) => x.p.id === id);
    if (!hit) { log.push(`- 手册提案 ${id} 不在清单里，跳过`); continue; }
    if (hit.p.status !== "pending") { log.push(`= 手册提案 ${id}（${hit.e.id}）现在是 ${hit.p.status}，不动`); continue; }
    Object.assign(hit.p, { status: "stale", decided_at: now, stale_reason: REASON });
    log.push(`✓ 手册提案 ${id}（${hit.e.id}）→ stale（${REASON}）`);
  }
  return log;
}

/** 每个平台的生效规则 id；只允许抖音那一列变 */
export function effectiveTable(p: CreatorProfile): Record<string, string[]> {
  return Object.fromEntries(PLATFORMS.map((pl) => [pl, rulesForPlatform(p, pl).map((r) => r.id ?? r.rule).sort()]));
}

export function assertOnlyDouyinChanged(before: Record<string, string[]>, after: Record<string, string[]>): void {
  const changed = PLATFORMS.filter((pl) => pl !== "douyin" && JSON.stringify(before[pl]) !== JSON.stringify(after[pl]));
  if (changed.length) throw new MigrationError(`除抖音外这些平台的生效规则也变了：${changed.join("、")}；整次中止`);
}

export function renderTable(before: Record<string, string[]>, after: Record<string, string[]>, text: Map<string, string>): string {
  return PLATFORMS.map((pl) => {
    const b = new Set(before[pl]), a = new Set(after[pl]);
    const line = (id: string) => `${id.slice(0, 8)} ${(text.get(id) ?? "").slice(0, 24)}`;
    const removed = before[pl].filter((x) => !a.has(x)).map((x) => `  - ${line(x)}`);
    const added = after[pl].filter((x) => !b.has(x)).map((x) => `  + ${line(x)}`);
    return `${pl}: ${before[pl].length} → ${after[pl].length} 条${removed.length + added.length ? "" : "（不变）"}\n${[...removed, ...added].join("\n")}`.trimEnd();
  }).join("\n");
}

export interface PlaybookPublish { id: string; from: number; changed: boolean }

/** 手册：压缩版和当前版不同就记一版（author agent，kind edit）；返回计划，apply=false 时不写 */
export async function publishPlaybooks(m: PlaybookManifest, seeds: Array<{ id: string; text: string }>, readCurrent: (id: string, v: number) => Promise<string>): Promise<PlaybookPublish[]> {
  const out: PlaybookPublish[] = [];
  for (const s of seeds) {
    const e = m.playbooks.find((x) => x.id === s.id);
    if (!e) throw new MigrationError(`手册清单里没有 ${s.id}`);
    out.push({ id: s.id, from: e.current, changed: (await readCurrent(s.id, e.current)) !== s.text });
  }
  return out;
}
