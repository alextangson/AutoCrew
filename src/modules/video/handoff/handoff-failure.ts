/**
 * 交接失败的三类口径（P6 §13.4-D）。认领的处理跟着类别走：
 * - `handoff_rejected`：提交前就失败（缺料、超限、目录归属、认领转交被拒）。认领恢复成调用前那一份；
 * - `handoff_not_committed`：确认没有提交（状态没推进）。删掉刚写的交接包，认领恢复到原持有者与原令牌；
 * - `handoff_pending_recovery`：提交结果不确定（`PROJECT_COMMIT_UNCERTAIN`）。不删文件、不动认领、
 *   保留事务日志，重启后核定——不谎报回滚成功。
 */
import type { ContentClaim } from "../../../storage/local-store.js";
import { restoreClaim } from "../../../storage/claims.js";
import { resolveContentProject } from "../../../storage/content-project.js";
import type { Content } from "../../../storage/local-store.js";
import { handoffEvidence, HandoffEvidenceError } from "./project-evidence.js";
import { handoffFail, type HandoffCode, type HandoffResult } from "./types.js";

export type HandoffFailureClass = "handoff_rejected" | "handoff_not_committed" | "handoff_pending_recovery";

const NEXT_ACTION: Record<HandoffEvidenceError["code"], string> = {
  missing_decisions: "请创作者在 AutoCrew 工作台确认这条稿的标题、封面字、平台与目标时长，确认后再交接。",
  missing_citations: "写稿侧按 uncovered_sentences 补齐当前定稿的逐句出处，用 autocrew_video citations 提交后再交接。",
};

/** 受管项目交接前的缺料检查：在任何认领写入之前跑，缺什么回什么 */
export async function evidenceBlock(content: Content, dataDir: string): Promise<HandoffResult | null> {
  if (!resolveContentProject(content.id, dataDir)) return null;
  try {
    await handoffEvidence(content, dataDir);
    return null;
  } catch (err) {
    if (!(err instanceof HandoffEvidenceError)) throw err;
    return handoffFail(err.code, err.message, { ...err.details, failure_class: "handoff_rejected", next_action: NEXT_ACTION[err.code] });
  }
}

export function isCommitUncertain(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "PROJECT_COMMIT_UNCERTAIN";
}

export function pendingRecovery(err: unknown): HandoffResult {
  return handoffFail("handoff_pending_recovery", `交接结果待恢复：${err instanceof Error ? err.message : String(err)}`, {
    failure_class: "handoff_pending_recovery",
    claim_restored: false,
    next_action: "停下，把 error 原文报告给创作者；重启 AutoCrew 后由它核定这次交接是否已提交，核定前不要重试或改稿。",
  });
}

/** 失败的码：有具体原因用具体码，没有就用类别本身 */
export function failureCode(err: unknown, fallback: HandoffFailureClass): HandoffCode {
  if (err instanceof HandoffEvidenceError) return err.code;
  const code = (err as { code?: string } | null)?.code;
  if (code === "handoff_file_exists") return code;
  if (err instanceof Error && err.message.startsWith("handoff_too_large")) return "handoff_too_large";
  return fallback;
}

/**
 * 提交前 / 确认未提交的失败：认领恢复成调用前那一份（`heldToken` 是这次交接此刻手上的那枚）。
 * 恢复后调用方原来的令牌照旧可用，所以回执不带令牌（调用前的认领可能不是调用方的，不外泄）。
 */
export async function withClaimRestored(
  failure: HandoffResult,
  failureClass: Exclude<HandoffFailureClass, "handoff_pending_recovery">,
  claim: { contentId: string; prior?: ContentClaim; heldToken?: string; dataDir: string },
): Promise<HandoffResult> {
  const restored = claim.heldToken
    ? await restoreClaim(claim.contentId, claim.prior, claim.heldToken, "交接未完成", claim.dataDir)
    : true;
  return {
    ...failure,
    failure_class: failureClass,
    claim_restored: restored,
  };
}
