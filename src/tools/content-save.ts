import { Type } from "@sinclair/typebox";
import { contentSummary } from "./content-summary.js";
import { gateClaimWrite, redactClaim, type WriteGate } from "../storage/claims.js";
import {
  LOCAL_HOST,
  saveContent,
  listContents,
  getDataDir,
  getContent,
  updateContent,
  updateContentChecked,
  transitionStatus,
  transitionPreflight,
  createPlatformVariant,
  listSiblings,
  getAllowedTransitions,
  describeAllowedTransitions,
  normalizeLegacyStatus,
  recordAdoption,
  adoptionStats,
  softDeleteContent,
  restoreContent,
  getCoverReview,
  type ContentUpdates,
} from "../storage/local-store.js";
import type { AdoptionVerdict, Content } from "../storage/local-store.js";
import { EDITING_VIA_HANDOFF, EDITING_VIA_ONTOLOGY, isModelCall, isVideoPlatform } from "../storage/stage-guard.js";
import { recordDiff } from "../modules/learnings/diff-tracker.js";
import { shouldDistillStyle, distillStyleRules } from "../modules/learnings/style-distiller.js";
import type { StyleDistillResult } from "../modules/learnings/style-distiller.js";
import { deriveAndRecordAdoption } from "../modules/learnings/adoption-derive.js";
import { isOntologyEnabled, ScriptFrozenError } from "../storage/production-store.js";
import { executeRecord } from "../modules/production/record.js";
import { reconcileContent } from "../modules/production/reconcile.js";

const ALL_STATUSES = [
  "topic_saved", "drafting", "needs_evidence", "draft_ready", "reviewing", "revision",
  "approved", "editing", "cover_pending", "publish_ready", "publishing", "published", "archived",
  // Legacy compat
  "draft", "review",
] as const;

export const contentSaveSchema = Type.Object({
  action: Type.Unsafe<"save" | "list" | "get" | "summary" | "update" | "transition" | "create_variant" | "siblings" | "allowed_transitions" | "adoption" | "delete" | "restore" | "record">({
    type: "string",
    enum: ["save", "list", "get", "summary", "update", "transition", "create_variant", "siblings", "allowed_transitions", "adoption", "delete", "restore", "record"],
    description:
      "Action: 'save' new content, 'list' all, 'get' by id, 'update' existing, " +
      "'transition' change status via state machine, 'create_variant' create platform variant from topic, " +
      "'siblings' list sibling content, 'allowed_transitions' show valid next statuses, " +
      "'adoption' record adoption verdict (采纳率北极星读数)——仅工作台可用，宿主调用会被服务端拒绝（采纳不能由模型代填）, " +
      "'record' 报制作事实（原片 aroll / 成片 cut / 字幕 srt / 封面 cover / ChatCut 工程 chatcut_project）：只报盘上有什么，不带任何批准；认稿、成片通过、选封面只能创始人点.",
  }),
  id: Type.Optional(Type.String({ description: "Content id (for get/update/transition/siblings/allowed_transitions)" })),
  content_id: Type.Optional(Type.String({ description: "Alias of `id` — other AutoCrew tools call it content_id" })),
  source: Type.Optional(Type.Literal("manual_import", { description: "save/create_variant：仅用户已有成稿导入时填 manual_import，AI 新稿必须走 writer submit；update 不能填入尚未交稿的写作占位。" })),
  import_reason: Type.Optional(Type.String({ description: "save/create_variant：用户提供已有稿件并要求导入的说明；不能用于绕过 AI 交稿门。" })),
  title: Type.Optional(Type.String({ description: "Content title" })),
  body: Type.Optional(Type.String({ description: "Content body (markdown)" })),
  platform: Type.Optional(Type.String({ description: "Target platform: xhs, douyin, wechat_video, wechat_mp, bilibili" })),
  topicId: Type.Optional(Type.String({ description: "Related topic id (for save/create_variant)" })),
  status: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ALL_STATUSES as unknown as string[],
    description: "Content status (for save/update). Use 'transition' action for validated state changes.",
  })),
  target_status: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ALL_STATUSES as unknown as string[],
    description: "Target status for 'transition' action.",
  })),
  tags: Type.Optional(Type.Array(Type.String())),
  hashtags: Type.Optional(Type.Array(Type.String(), { description: "Platform-specific hashtags" })),
  siblings: Type.Optional(Type.Array(Type.String(), { description: "Sibling content IDs" })),
  publish_url: Type.Optional(Type.String({ description: "Published URL on target platform" })),
  performance_data: Type.Optional(Type.Record(Type.String(), Type.Number(), { description: "Performance metrics: views, likes, comments, shares, etc." })),
  from_status: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ALL_STATUSES as unknown as string[],
    description: "Status the caller believes the content is in (for 'transition'). Rejected with a human message if the stored status differs — stale tab / double-click protection.",
  })),
  force: Type.Optional(Type.Boolean({ description: "Force transition even if not in allowed transitions (never bypasses the stage guard)" })),
  diff_note: Type.Optional(Type.String({ description: "Note for revision diff tracking" })),
  verdict: Type.Optional(Type.Unsafe<AdoptionVerdict>({
    type: "string",
    enum: ["adopted", "light_edit", "rewritten"],
    description: "Adoption verdict for 'adoption' action: adopted 直接采纳 | light_edit 轻改采纳 | rewritten 推倒重写.",
  })),
  reason: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ["style_mismatch", "factual_error", "structure_bad"],
    description: "Optional rewrite reason chip for verdict=rewritten (IA v4.2 §B6): style_mismatch 风格不像 | factual_error 事实错 | structure_bad 结构差.",
  })),
  reason_note: Type.Optional(Type.String({
    description: "Optional free-text rewrite reason for verdict=rewritten (IA v5 V5.0) — user's own words on what went wrong; high-value negative signal for style distillation.",
  })),
  kind: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ["aroll", "cut", "srt", "cover", "chatcut_project", "publish"],
    description: "record：事实种类。aroll 原片、cut 成片、srt 字幕、cover 封面、chatcut_project ChatCut 工程、publish 发布回执（记为待核，等创始人确认或数据回流核实）.",
  })),
  request_id: Type.Optional(Type.String({ description: "record：这次报告的请求号；重试用同一个，服务端直接重放上次结果." })),
  path: Type.Optional(Type.String({ description: "record：文件的本机路径（可 ~ 开头）。项目内原地收；原片收件箱、ChatCut / 剪映导出目录会挪 / 克隆进项目；其他位置只记候选." })),
  ratio: Type.Optional(Type.String({ description: "record kind=cover：3:4 或 4:3（按像素核对）." })),
  version: Type.Optional(Type.Integer({ minimum: 1, description: "record kind=cover：封面版本号；不填就放新一版." })),
  cover_text: Type.Optional(Type.String({ description: "record kind=cover：封面上的字（只是默认值，不是批准）." })),
  for_cut: Type.Optional(Type.String({ description: "record kind=srt：这份字幕属于哪版成片（成片 fact_id 或 sha256）；不填 = 本轮最新成片." })),
  uses_aroll: Type.Optional(Type.Array(Type.String(), { description: "record kind=chatcut_project：工程里用到的原片 fact_id." })),
  chatcut_project_id: Type.Optional(Type.String({ description: "record kind=chatcut_project：ChatCut 工程 id." })),
  timeline_id: Type.Optional(Type.String({ description: "record kind=chatcut_project：时间线 id（可选）." })),
  note: Type.Optional(Type.String({ description: "record：一句备注（可选）." })),
  account: Type.Optional(Type.String({ description: "record kind=publish：发布账号（可选）." })),
  url: Type.Optional(Type.String({ description: "record kind=publish：作品链接（或填 item_id）." })),
  item_id: Type.Optional(Type.String({ description: "record kind=publish：平台作品 id（或填 url）." })),
  claim_token: Type.Optional(Type.String({
    description:
      "认领令牌（写操作回执或 autocrew_desk claim 给的）。这篇有活认领时 update / transition 必须带它，同宿主的另一个会话也一样；没人认领就不用带，写下去会自动认领并回令牌。",
  })),
});

/**
 * Build the updates object including ONLY fields actually provided.
 * Explicit undefined keys would otherwise survive local-store's
 * `{...existing, ...updates}` spread and destroy existing values.
 */
function buildContentUpdates(params: Record<string, unknown>): ContentUpdates {
  // 谁改的正文（本体 §13-C）：工作台人手改 = 创始人，认稿随改稿重绑；模型改 = agent，认稿作废
  const updates: ContentUpdates = isModelCall(params) ? {} : { _editor: "founder" };
  if (params.title !== undefined) updates.title = params.title as string;
  if (params.body !== undefined) updates.body = params.body as string;
  if (params.platform !== undefined) updates.platform = params.platform as string;
  // status 刻意不在这里：改状态一律走 transitionStatus（阶段制 spec §1.2 收口），
  // update 只管字段。带了 status 的 update 由调用处转成一次流转，阶段门照跑。
  if (params.tags !== undefined) updates.tags = params.tags as string[];
  if (params.hashtags !== undefined) updates.hashtags = params.hashtags as string[];
  if (params.siblings !== undefined) updates.siblings = params.siblings as string[];
  if (params.publish_url !== undefined) updates.publishUrl = params.publish_url as string;
  if (params.performance_data !== undefined) {
    updates.performanceData = params.performance_data as Record<string, number>;
  }
  if (typeof params.diff_note === "string" && params.diff_note.trim()) {
    updates._versionNote = params.diff_note.trim().slice(0, 200);
  }
  return updates;
}

/** 进了剪辑之后的阶段：视频 / 图文的身份在这里定死，阶段门按它判定 */
const PLATFORM_LOCKED = new Set(["editing", "cover_pending", "publish_ready", "publishing", "published", "archived"]);

const PLATFORM_LOCKED_ERROR =
  "这篇已经交接过、审过片、定过封面或进了剪辑之后的阶段，不能在视频和图文平台之间改：视频稿的审片和封面要创始人在工作台批。要换形态，请创作者在工作台处理，或另建一篇。";

/**
 * 模型调用不许把稿件在视频 / 图文之间改来改去：阶段门和创始人批准（gate3 / gate4）都按平台判定，
 * 临时改成公众号就能选封面、推进，再改回来（P6 §14.7 #1）。锁看的是回退状态也抹不掉的事实——
 * 交接过、盖过成片戳、封面定过稿——再加上剪辑之后的阶段。视频平台之间、图文平台之间互换不受影响。
 * 锁外预检一次（被拒不留认领），写入时在稿件写锁内再核一次（挡并发的流转 / 选封面）。
 */
function platformLockCheck(params: Record<string, unknown>, dataDir?: string): ((current: Content) => Promise<string | null>) | null {
  if (!isModelCall(params) || typeof params.platform !== "string") return null;
  const target = params.platform;
  return async (current) => {
    if (isVideoPlatform(target) === isVideoPlatform(current.platform)) return null;
    const locked = PLATFORM_LOCKED.has(normalizeLegacyStatus(current.status)) || Boolean(current.video?.handoff) || Boolean(current.videoDone)
      || Boolean((await getCoverReview(current.id, dataDir))?.approvedLabel);
    return locked ? PLATFORM_LOCKED_ERROR : null;
  };
}

/**
 * 令牌门（P3 §6.1 / P6 §3.8）：`update` / `transition` 是跨岗位的写口，有活认领就得带令牌（同宿主也一样）。
 * 岗位不填 = 沿用现有认领的岗位（封面师改稿不该把自己变成写手），全新认领记 `writer`。
 * 认领归调用宿主时令牌随回执交回（`grant`），否则他下一次写就过不了门。
 */
function gateContentWrite(
  params: Record<string, unknown>,
  id: string,
  dataDir: string | undefined,
): Promise<WriteGate> {
  const host = typeof params._host === "string" && params._host.trim() ? params._host.trim() : LOCAL_HOST;
  const token = typeof params.claim_token === "string" ? params.claim_token.trim() : "";
  return gateClaimWrite(id, { host, token: token || undefined }, dataDir);
}

/** 本体 §2.1：模型推 = agent（认稿及之后一律拒），工作台人手推 = 创始人（认稿即写认稿决定） */
function decidedBy(params: Record<string, unknown>): "agent" | "founder" {
  return isModelCall(params) ? "agent" : "founder";
}

function importSource(params: Record<string, unknown>) {
  return { kind: "manual_import" as const, importedAt: new Date().toISOString(), reason: String(params.import_reason).trim() };
}
function rejectedTransition(pre: { error?: string; blocked?: boolean; code?: string }) {
  return { ok: false, error: pre.error, ...(pre.blocked ? { blocked: true } : {}), ...(pre.code ? { code: pre.code } : {}) };
}

export async function executeContentSave(
  params: Record<string, unknown>,
  deps?: {
    recordDiffImpl?: typeof recordDiff;
    shouldDistillImpl?: typeof shouldDistillStyle;
    distillImpl?: typeof distillStyleRules;
  },
) {
  const action = (params.action as string) || "save";
  // 宿主 P3b 真机：其它工具都叫 content_id，模型对这个工具也会这么猜——认下别名，不让它撞「id is required」
  if (params.id === undefined && typeof params.content_id === "string") params.id = params.content_id;
  const dataDir = (params._dataDir as string) || undefined;
  const isMcpCall = typeof params._host === "string";
  const manualImport = params.source === "manual_import" && typeof params.import_reason === "string" && Boolean(params.import_reason.trim());
  const importReceipt = {
    saved: true, quality_status: "unreviewed", needs_attention: true,
    writing_source: { kind: "manual_import" },
    note: "已有稿件已导入，尚未执行调研、审稿或作者确认；不能将导入成功报告为质量通过。",
  };
  const recordDiffImpl = deps?.recordDiffImpl || recordDiff;
  const shouldDistillImpl = deps?.shouldDistillImpl || shouldDistillStyle;
  const distillImpl = deps?.distillImpl || distillStyleRules;

  // 认领令牌只回给认领者本人（§6.1）：list/get 这些视图一律脱敏，
  // 否则看板一刷新，谁都拿得到别人那枚 fencing token。
  if (action === "list") {
    const contents = await listContents(dataDir);
    return { ok: true, contents: contents.map(redactClaim) };
  }

  // 只读进度摘要（v1.3）：查「这篇到哪了」不用拉 16KB 的整篇
  if (action === "summary") return contentSummary(String(params.id ?? "").trim(), dataDir);

  // 本体 §3：agent 只报事实（原片 / 成片 / 字幕 / 封面 / ChatCut 工程），不要认领、不要交接
  if (action === "record") return executeRecord(params);

  if (action === "get") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for get" };
    // 本体 §4：get 前对这条做一次项目内快扫（只在启用后写）；扫失败照样给稿，但把原因带出来
    const scanned = await reconcileContent(id, dataDir ?? getDataDir()).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
    const content = await getContent(id, dataDir);
    if (!content) return { ok: false, error: `Content ${id} not found` };
    const { resolveContentProject } = await import("../storage/content-project.js");
    return { ok: true, content: redactClaim(content), project: resolveContentProject(id, dataDir), ...(scanned ? { reconcile_warning: `对账没跑完：${scanned}` } : {}) };
  }

  if (action === "update") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for update" };

    // Get old content before update to check for body changes
    const oldContent = await getContent(id, dataDir);
    if (!oldContent) return { ok: false, error: `Content ${id} not found` };
    // Generic editing is for existing drafts. A blank/topic placeholder is not a draft,
    // and filling it here would skip the writer's preparation, gates and review receipt.
    const fillingBody = typeof params.body === "string" && Boolean(params.body.trim()) && params.body !== oldContent.body;
    const unsubmittedPlaceholder = !oldContent.body.trim()
      || oldContent.body.startsWith("<!-- Generated from topic:")
      || Boolean(oldContent.pack && !oldContent.pack.submittedAt && !oldContent.writtenBy);
    if (isMcpCall && fillingBody && unsubmittedPlaceholder) return {
      ok: false, code: "writer_submission_required",
      error: "这篇仍是空白稿或尚未交稿的写作占位，不能通过 content update 填正文绕过交稿。请走 writer pack/submit；已有成稿需要导入时请另用 save 并注明 manual_import。",
      next_action: { tool: "autocrew_writer", params: { action: "pack", content_id: id, topic_id: oldContent.topicId, platform: oldContent.platform } },
    };
    const platformLock = platformLockCheck(params, dataDir);
    if (platformLock && await platformLock(oldContent)) return { ok: false, code: "platform_locked", error: PLATFORM_LOCKED_ERROR };
    // 带 status 的 update 先预检流转：被拒就原样返回，认领门和正文都不动
    if (params.status) {
      const pre = await transitionPreflight(id, normalizeLegacyStatus(params.status as string), { decidedBy: decidedBy(params) }, dataDir);
      if (!pre.ok) return rejectedTransition(pre);
    }
    const gate = await gateContentWrite(params, id, dataDir);
    if ("denied" in gate) return gate.denied;
    const { grant } = gate;
    const oldBody = oldContent.body;
    const newBody = params.body as string | undefined;

    let updated: Content | null;
    try {
      if (platformLock) {
        const checked = await updateContentChecked(id, buildContentUpdates(params), platformLock, dataDir);
        if (checked && !checked.ok) return { ok: false, code: "platform_locked", error: checked.reason, ...grant };
        updated = checked?.content ?? null;
      } else updated = await updateContent(id, buildContentUpdates(params), dataDir);
    } catch (err) {
      if (err instanceof ScriptFrozenError) return { ok: false, code: err.code, error: err.message, ...grant };
      throw err;
    }
    if (!updated) return { ok: false, error: `Content ${id} not found` };

    // 带 status 的 update 转成一次真流转：阶段门只有一条通道，直改状态跳阶段的路已封死。
    // 目标就是当前状态时什么都不做（幂等），被门拦下则连同原因一起返回，不谎报成功。
    if (params.status) {
      const target = normalizeLegacyStatus(params.status as string);
      if (target !== updated.status) {
        const host = typeof params._host === "string" && params._host.trim() ? params._host.trim() : LOCAL_HOST;
        const moved = await transitionStatus(id, target, { host, decidedBy: decidedBy(params) }, dataDir);
        if (!moved.ok) return { ok: false, error: moved.error, ...(moved.blocked ? { blocked: true } : {}), ...(moved.code ? { code: moved.code } : {}), ...grant };
        updated = moved.content ?? updated;
      }
    }

    // Record diff if body changed
    let styleLearned: StyleDistillResult | undefined;
    if (newBody && newBody !== oldBody) {
      try {
        await recordDiffImpl(id, "body", oldBody, newBody, dataDir, params.diff_note as string | undefined, oldContent.platform);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          ok: true,
          content: redactClaim(updated),
          warning: `diff 记录失败：${errorMsg}，稿件已正常保存`,
          ...grant,
        };
      }

      // MCP edits remain host-driven: record their source material, but never
      // silently call a model or promote inferred preferences to durable rules.
      // Internal workbench edits retain the existing best-effort auto-distillation.
      try {
        if (!isMcpCall && await shouldDistillImpl(dataDir)) {
          styleLearned = await distillImpl(dataDir);
        }
      } catch {
        /* distill is best-effort; the edit is saved regardless */
      }
    }

    return styleLearned
      ? { ok: true, content: redactClaim(updated), styleLearned, ...grant }
      : { ok: true, content: redactClaim(updated), ...grant };
  }

  if (action === "delete") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for delete" };
    const deleted = await softDeleteContent(id, dataDir);
    if (!deleted) return { ok: false, error: `Content ${id} not found` };
    return { ok: true, content: redactClaim(deleted) };
  }

  if (action === "restore") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for restore" };
    const restored = await restoreContent(id, dataDir);
    if (!restored) return { ok: false, error: `Content ${id} not found` };
    return { ok: true, content: redactClaim(restored) };
  }

  if (action === "adoption") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for adoption" };
    const verdict = params.verdict as AdoptionVerdict | undefined;
    if (verdict !== "adopted" && verdict !== "light_edit" && verdict !== "rewritten") {
      return { ok: false, error: "verdict must be one of: adopted | light_edit | rewritten" };
    }
    // §B6 重写原因 chip（可选,仅 rewritten）:非法值静默忽略,不阻断裁决落库
    const rawReason = params.reason as string | undefined;
    const reason =
      rawReason === "style_mismatch" || rawReason === "factual_error" || rawReason === "structure_bad"
        ? rawReason
        : undefined;
    // V5.0 自由文本原因:用户自己的话是最高价值负信号,截断防爆(超长粘贴)
    const reasonNote =
      typeof params.reason_note === "string" && params.reason_note.trim()
        ? params.reason_note.trim().slice(0, 200)
        : undefined;
    const updated = await recordAdoption(id, verdict, dataDir, reason, reasonNote);
    if (!updated) return { ok: false, error: `Content ${id} not found` };
    // 附带全局采纳率：UI toast 直接可见北极星读数（白盒资格线的一部分）
    const stats = await adoptionStats(dataDir);
    return { ok: true, content: redactClaim(updated), stats };
  }

  if (action === "transition") {
    const id = params.id as string;
    const targetStatus = params.target_status as string;
    if (!id) return { ok: false, error: "id is required for transition" };
    if (!targetStatus) return { ok: false, error: "target_status is required for transition" };
    // 状态机和阶段门先于认领门：被拒的流转不新占、不续约认领
    const pre = await transitionPreflight(id, normalizeLegacyStatus(targetStatus), { force: params.force as boolean, decidedBy: decidedBy(params) }, dataDir);
    if (!pre.ok) return rejectedTransition(pre);
    const gate = await gateContentWrite(params, id, dataDir);
    if ("denied" in gate) return gate.denied;
    // from_status：调用方手里那一版的状态。旧标签页/双击推进时后端据此人话拒绝，不硬盖
    const from = typeof params.from_status === "string" ? normalizeLegacyStatus(params.from_status) : undefined;
    const target = normalizeLegacyStatus(targetStatus);
    const host = typeof params._host === "string" && params._host.trim() ? params._host.trim() : LOCAL_HOST;
    const moved = await transitionStatus(
      id,
      target,
      {
        force: params.force as boolean,
        diffNote: params.diff_note as string,
        host,
        decidedBy: decidedBy(params),
        ...(from ? { expectedStatus: from } : {}),
      },
      dataDir,
    );
    // 令牌不外泄（§6.1）：流转回执里也带着整份稿件
    const result = { ...(moved.content ? { ...moved, content: redactClaim(moved.content) } : moved), ...gate.grant };
    // 到「已发布」的另一条路（publish.ts confirm_published 是第一条）：同样在发布时刻
    // 推导一次采纳判定。best-effort——判定失败不该把已经发生的状态流转打回。
    if (result.ok && target === "published") {
      try {
        const adoption = await deriveAndRecordAdoption(id, dataDir);
        if (adoption) return { ...result, adoption };
      } catch {
        /* 判定是附加读数，流转本身已完成 */
      }
    }
    return result;
  }

  if (action === "create_variant") {
    const topicId = params.topicId as string;
    const platform = params.platform as string;
    if (!topicId) return { ok: false, error: "topicId is required for create_variant" };
    if (!platform) return { ok: false, error: "platform is required for create_variant" };
    const hasBody = typeof params.body === "string" && Boolean(params.body.trim());
    if (isMcpCall && hasBody && !manualImport) return {
      ok: false, code: "writer_submission_required",
      error: "平台变体的新正文也必须走 writer pack/submit；只有用户提供的已有成稿，才能以 source=manual_import 并说明 import_reason 导入。",
      next_action: { tool: "autocrew_workflow", params: { action: "prepare", topic_id: topicId, platform } },
    };
    const result = await createPlatformVariant(
      topicId,
      platform,
      { title: params.title as string, body: params.body as string, ...(hasBody && manualImport ? { writingSource: importSource(params) } : {}) },
      dataDir,
    );
    return result.ok && hasBody && manualImport ? { ...result, ...importReceipt } : result;
  }

  if (action === "siblings") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for siblings" };
    const sibs = await listSiblings(id, dataDir);
    return { ok: true, siblings: sibs };
  }

  if (action === "allowed_transitions") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for allowed_transitions" };
    const content = await getContent(id, dataDir);
    if (!content) return { ok: false, error: `Content ${id} not found` };
    const currentStatus = normalizeLegacyStatus(content.status);
    const allowed = getAllowedTransitions(currentStatus);
    // transitions 带阶段门预判：推进下拉灰显要说得出原因,不是点了才报错
    const transitions = await describeAllowedTransitions(content, dataDir);
    return { ok: true, currentStatus, allowedTransitions: allowed, transitions };
  }

  // MCP must not silently use generic storage as an alternative AI writing pipeline.
  if (isMcpCall && !manualImport) return {
    ok: false, code: "writer_submission_required",
    error: "新生成稿必须走 workflow prepare → writer pack/submit。只有用户提供的已有成稿，才能以 source=manual_import 并说明 import_reason 导入。",
    next_action: { tool: "autocrew_workflow", params: { action: "prepare", topic_id: params.topicId, platform: params.platform } },
  };
  // save
  const title = params.title as string;
  const body = params.body as string;
  if (!title || !body) {
    return { ok: false, error: "title and body are required for save" };
  }

  const rawStatus = manualImport ? "draft_ready" : (params.status as string) || "draft_ready";
  // 「剪辑中」只能由交接进入（§13.4-C）：直接建在剪辑中和 update/transition 一样拒绝，说清怎么交接
  if (normalizeLegacyStatus(rawStatus) === "editing") return { ok: false, code: "editing_requires_handoff", error: (await isOntologyEnabled(params._dataDir as string | undefined)) ? EDITING_VIA_ONTOLOGY : EDITING_VIA_HANDOFF };
  const content = await saveContent({
    title,
    body,
    platform: (params.platform as string) || undefined,
    topicId: (params.topicId as string) || undefined,
    status: normalizeLegacyStatus(rawStatus),
    tags: (params.tags as string[]) || [],
    hashtags: (params.hashtags as string[]) || [],
    ...(manualImport ? { writingSource: importSource(params) } : {}),
  }, dataDir);

  return { ok: true, content, ...(manualImport ? importReceipt : {}) };
}
