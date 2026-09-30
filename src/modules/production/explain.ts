/**
 * `explain()`（spec §2.6）：看板、我的内容、晨报、desk 共用的「这条在哪一步」。纯函数。
 *
 * 影子模式（§4.1）：资料库还没启用本体时，`column` 仍按旧状态给（旧读方照常服务），
 * 推导结果放在 `shadow` 里，供启用前的差异清单用。启用后 `column` 就是推导结果。
 */
import type { Content, ContentStatus } from "../../storage/local-store.js";
import { bodyHash, scriptApprovalFor } from "../../storage/production-store.js";
import { emptyProductionDoc, type ProductionDoc } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import type { LegacyImport } from "./legacy.js";
import { candidatesOf, deriveStage, UNREGISTERED_PUBLISH, writingBadge, type CandidateView, type PublishEvidence, type Rule, type Stage } from "./derive.js";

export type Column = "写稿中" | "待录制" | "剪辑中" | "待发布" | "已发布";

/** status 投影：待录制=approved、剪辑中=editing、待发布=publish_ready、已发布=published */
export const STAGE_STATUS: Record<Stage, ContentStatus> = { 待录制: "approved", 剪辑中: "editing", 待发布: "publish_ready", 已发布: "published" };

export interface Explanation {
  column: Column | null;
  phase: "writing" | "production" | "other";
  stage: Stage | null;
  rule: Rule | null;
  /** 制作段投影出来的 status；写稿段 / 图文 = null（不由推导写） */
  status: ContentStatus | null;
  missing: string[];
  badges: string[];
  /** 真有问题的提示（界面标红） */
  alerts: string[];
  /** 一句人话原因（规则代码只在 rule 里） */
  reason: string;
  candidates: CandidateView[];
  publishable: boolean;
  evidence: string[];
  /** 未启用时：推导出来会是什么（启用前的差异清单读它） */
  shadow?: Explanation;
}

export interface ExplainInput {
  content: Pick<Content, "id" | "status" | "platform" | "body" | "deletedAt"> & { video?: Content["video"] };
  doc: ProductionDoc | null;
  enabled: boolean;
  publish: PublishEvidence;
}

/** 认稿之后的状态：旧库里它们等价于「认过稿」（迁移时补一条 legacy 认稿） */
export const POST_APPROVAL: ReadonlySet<ContentStatus> = new Set(["approved", "editing", "cover_pending", "publish_ready", "publishing", "published"]);

/** 旧列（原 my-content-plan.columnOf）+ 发布记录已投出的待发布算已发布（取代看板读时写状态） */
export function legacyColumn(c: Pick<Content, "status" | "platform">, publish: PublishEvidence): Column | null {
  const video = isVideoPlatform(c.platform);
  switch (c.status) {
    case "drafting": case "needs_evidence": case "reviewing": case "revision": case "draft_ready": return "写稿中";
    case "approved": return video ? "待录制" : "待发布";
    case "editing": case "cover_pending": return "剪辑中";
    case "publish_ready": case "publishing": return publish.verified ? "已发布" : "待发布";
    case "published": return "已发布";
    default: return null;
  }
}

/**
 * 旧状态等价的决定（§4.1 迁移规则）：认过稿之后的状态补 legacy 认稿；已发布补 legacy「我发了」。
 * 已登记的待发布稿只有在 `legacy`（legacy.ts 从旧 register 核过的批准 + 字幕导入的完整组合）齐全时才补登记；
 * 否则不补，卡片按 D3 / D4 显示需要重新通过的那几项。只补缺的，不覆盖真决定。
 */
export function withLegacyDecisions(doc: ProductionDoc | null, content: ExplainInput["content"], at = "1970-01-01T00:00:00.000Z", legacy?: LegacyImport): ProductionDoc {
  const d: ProductionDoc = structuredClone(doc ?? emptyProductionDoc());
  if (!isVideoPlatform(content.platform) || !POST_APPROVAL.has(content.status)) return d;
  const bh = bodyHash(content.body ?? "");
  const round = d.round;
  const anyScript = d.decisions.some((x) => x.round === round && (x.type === "script_approval" || x.type === "script_revoke"));
  if (!anyScript) d.decisions.push({ id: `legacy-script-${round}`, type: "script_approval", round, at, source: "legacy", body_hash: bh });
  if (content.status === "published" && !d.decisions.some((x) => x.round === round && x.type === "i_published")) {
    d.decisions.push({ id: `legacy-published-${round}`, type: "i_published", round, at, source: "legacy", platform: content.platform, note: "旧状态是已发布" });
  }
  if (legacy?.registrations.length && !d.registrations.some((r) => r.round === round)) {
    for (const f of legacy.facts) if (!d.facts.some((x) => x.kind === f.kind && x.sha256 === f.sha256 && x.round === round)) d.facts.push(f);
    for (const x of legacy.decisions) if (!d.decisions.some((y) => y.id === x.id)) d.decisions.push(x);
    d.registrations.push(...legacy.registrations);
  }
  return d;
}

function nonProduction(column: Column | null, phase: Explanation["phase"], badge: string | null): Explanation {
  return { column, phase, stage: null, rule: null, status: null, missing: [], badges: badge ? [badge] : [], alerts: [], reason: phase === "writing" ? badge ?? "还没认稿" : "", candidates: [], publishable: false, evidence: [] };
}

export const LEGACY_REGISTERED = "按旧流程登记";
export const LEGACY_REGISTERED_RECUT = "按旧流程登记；发布后成片换过版本";

/**
 * 已发布、本轮没有本体登记记录，但稿件上有旧流程的登记（video.final.register_hash）：不是「未登记就发布」（创始人 09-30）。
 * 只改说法，不放宽旧登记导入规则。登记之后本轮又出现了另一版成片（含发布后导出的候选）→ 加「发布后成片换过版本」（提醒）。
 */
function legacyRegisteredNote<T extends { rule: string | null; alerts: string[]; badges: string[] }>(r: T, doc: ProductionDoc, content: ExplainInput["content"]): T {
  const final = content.video?.final;
  if (r.rule !== "D1" || !final?.register_hash || !r.alerts.includes(UNREGISTERED_PUBLISH)) return r;
  const after = Date.parse(final.at ?? "");
  const recut = doc.facts.some((f) => f.round === doc.round && f.kind === "cut" && f.state !== "rejected" && f.sha256 && f.sha256 !== final.sha256
    && !Number.isNaN(after) && Date.parse(f.at) > after);
  const alerts = r.alerts.filter((a) => a !== UNREGISTERED_PUBLISH);
  return recut ? { ...r, alerts: [LEGACY_REGISTERED_RECUT, ...alerts] } : { ...r, alerts, badges: [LEGACY_REGISTERED, ...r.badges] };
}

/** 本体规则下的结果（不管启没启用） */
export function deriveExplanation(input: ExplainInput): Explanation {
  const { content, doc, publish } = input;
  if (content.deletedAt || content.status === "archived" || content.status === "topic_saved") return nonProduction(null, "other", null);
  if (!isVideoPlatform(content.platform)) return nonProduction(legacyColumn(content, publish), "other", null);
  const d = doc ?? emptyProductionDoc();
  // 写稿段也把候选带出来：认稿前发现的疑似 A-roll 要在卡上看得见（E4）
  if (!scriptApprovalFor(d, content.body ?? "")) return { ...nonProduction("写稿中", "writing", writingBadge(d)), candidates: candidatesOf(d) };
  const r = legacyRegisteredNote(deriveStage(d, content.body ?? "", publish), d, content);
  const badges = content.status === "publishing" && r.stage !== "已发布" ? [...r.badges, "发布中"] : r.badges;
  return { column: r.stage, phase: "production", stage: r.stage, rule: r.rule, status: STAGE_STATUS[r.stage], missing: r.missing, badges, alerts: r.alerts, reason: r.reason, candidates: r.candidates, publishable: r.publishable, evidence: r.evidence };
}

export function explain(input: ExplainInput): Explanation {
  if (input.enabled) return deriveExplanation(input);
  const shadow = deriveExplanation({ ...input, doc: withLegacyDecisions(input.doc, input.content) });
  const column = input.content.deletedAt ? null : legacyColumn(input.content, input.publish);
  return { ...nonProduction(column, shadow.phase, null), shadow };
}
