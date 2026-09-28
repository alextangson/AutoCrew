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

export interface GateTarget {
  action: `${string}.${string}`;
  /** 目标对象 id（稿件 / 流水线） */
  targetId: string;
  /** 目标是稿件时，指纹要把稿件当前版本算进去 */
  contentId?: string;
  label: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function classifyPublishAction(tool: string, args: Record<string, unknown>): GateTarget | null {
  const action = str(args.action);
  const contentId = str(args.content_id) || str(args.id);
  if (tool === "autocrew_publish" && (action === "wechat_mp_draft" || action === "confirm_published")) {
    const label = action === "wechat_mp_draft" ? "推送到公众号草稿箱" : "标记为已发布";
    return { action: `${tool}.${action}`, targetId: contentId, contentId, label };
  }
  if (tool === "autocrew_content" && action === "transition" && str(args.target_status) === "published") {
    return { action: `${tool}.transition_published`, targetId: contentId, contentId, label: "转入已发布" };
  }
  if (tool === "autocrew_content" && action === "delete") {
    return { action: `${tool}.delete`, targetId: contentId, contentId, label: "删除稿件" };
  }
  if (tool === "autocrew_asset" && action === "remove") {
    return { action: `${tool}.remove`, targetId: contentId, contentId, label: "删除素材" };
  }
  if (tool === "autocrew_pipeline" && action === "delete") {
    return { action: `${tool}.delete`, targetId: str(args.id) || str(args.name), label: "删除流水线" };
  }
  return null;
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
