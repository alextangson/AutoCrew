/**
 * 执行前审批（spec §地基 2）：总编辑本机 agent 经 MCP 调发布类动作时，MCP 层不执行，
 * 回 `approval_required{approval_id,next_action}`；网页弹审批卡，批准后 agent 带 id 重调。
 *
 * 发布类动作按代码逐条枚举（src/tools/*.ts 的 action 枚举）：
 * - autocrew_publish wechat_mp_draft（推公众号草稿箱，外部写）
 * - autocrew_publish confirm_published（标记已上线 → 转入已发布）
 * - autocrew_content transition → published（转入已发布的另一条路）
 * - autocrew_content delete（删稿）
 * - autocrew_asset remove（删素材）
 * - autocrew_pipeline delete（删流水线）
 * ego_lite_prepare 只备上传包、不点发布，clipboard / digest 不外发，都不算。
 *
 * 审批绑定 动作 + 目标 + 内容指纹（稿件标题/正文/平台/状态 + 规范化参数），单次消费、有期限。
 */
import { createHash } from "node:crypto";
import type { ApprovalBinding } from "../approval-gate.js";
import { normalizeLegacyStatus } from "../../storage/local-store.js";

export interface GateTarget {
  action: `${string}.${string}`;
  /** 目标对象 id（稿件 / 流水线） */
  targetId: string;
  /** 目标是稿件时，指纹要把稿件当前版本算进去 */
  contentId?: string;
  label: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export type Classified = GateTarget | { refuse: string } | null;

/**
 * 目标解析与执行器同一口径：autocrew_content / autocrew_pipeline 认 `id`，
 * autocrew_publish / autocrew_asset 认 `content_id`。两个别名同时给且不一致 → 直接拒，
 * 否则审批的是 A、执行的是 B。
 */
function resolveTarget(tool: string, args: Record<string, unknown>): { id: string } | { refuse: string } {
  const id = str(args.id);
  const contentId = str(args.content_id);
  if (id && contentId && id !== contentId) return { refuse: `id（${id}）和 content_id（${contentId}）不一致，发布类动作只能指向一个目标` };
  const primary = tool === "autocrew_content" || tool === "autocrew_pipeline" ? id || contentId : contentId || id;
  return { id: primary };
}

/** 任何把稿件状态推到「已发布」的参数（transition 的 target_status、update/save 的 status） */
function toPublished(args: Record<string, unknown>): boolean {
  return [args.target_status, args.status].some((v) => typeof v === "string" && normalizeLegacyStatus(v.trim()) === "published");
}

function publishKind(tool: string, action: string, args: Record<string, unknown>): { key: string; label: string } | null {
  if (tool === "autocrew_publish" && action === "wechat_mp_draft") return { key: action, label: "推送到公众号草稿箱" };
  if (tool === "autocrew_publish" && action === "confirm_published") return { key: action, label: "标记为已发布" };
  if (tool === "autocrew_content" && action === "delete") return { key: "delete", label: "删除稿件" };
  if (tool === "autocrew_content" && toPublished(args)) return { key: "to_published", label: "转入已发布" };
  if (tool === "autocrew_asset" && action === "remove") return { key: "remove", label: "删除素材" };
  if (tool === "autocrew_pipeline" && action === "delete") return { key: "delete", label: "删除流水线" };
  return null;
}

export function classifyPublishAction(tool: string, args: Record<string, unknown>): Classified {
  const kind = publishKind(tool, str(args.action), args);
  if (!kind) return null;
  // article_path 发布读的是任意文件，批准后改文件无从察觉：本机 agent 一律走 content_id
  if (kind.key === "wechat_mp_draft" && str(args.article_path)) return { refuse: "本机 agent 推草稿箱只能用 content_id，不能用 article_path（文件内容无法绑定到审批）" };
  const target = resolveTarget(tool, args);
  if ("refuse" in target) return target;
  const isContent = tool !== "autocrew_pipeline";
  return { action: `${tool}.${kind.key}`, targetId: target.id, ...(isContent ? { contentId: target.id } : {}), label: kind.label };
}

/** 参与指纹的参数：去掉归因/审批/认领这些不属于「要做什么」的键 */
const NON_SEMANTIC = new Set(["approval_id", "claim_token", "_host", "_session", "_dataDir"]);

function canonicalArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).filter((k) => !NON_SEMANTIC.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, args[k]]));
}

export interface ContentSnapshot {
  title?: string;
  body?: string;
  platform?: string;
  status?: string;
}

export function approvalBindingFor(
  target: GateTarget,
  args: Record<string, unknown>,
  dataDir: string,
  content: ContentSnapshot | null,
): ApprovalBinding {
  const fingerprint = createHash("sha256")
    .update(canonicalArgs(args))
    .update("\0")
    .update(JSON.stringify(content ? [content.title ?? "", content.body ?? "", content.platform ?? "", content.status ?? ""] : null))
    .digest("hex");
  return { action: target.action, contentId: target.targetId, workspaceDir: dataDir, contentFingerprint: fingerprint };
}

export function approvalRequiredResult(approvalId: string, target: GateTarget, reason?: string): Record<string, unknown> {
  return {
    ok: false,
    code: "approval_required",
    approval_id: approvalId,
    error: `${reason ? `${reason}。` : ""}「${target.label}」需要创始人在网页上批准后才能执行`,
    next_action: "停下来，告诉创始人你在等他批准这个动作；不要换别的方式执行。批准后你会收到一条带 approval_id 的消息，届时用完全相同的参数外加 approval_id 重调这个工具。",
  };
}
