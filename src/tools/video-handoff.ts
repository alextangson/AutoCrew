import { reportExecution } from "../modules/video/handoff/project-execution.js";
import { saveCoverage, type CitationCoverage } from "../modules/video/handoff/project-evidence.js";
import { getContent } from "../storage/local-store.js";
/**
 * `autocrew_video` 的交接—登记三个动作（P6 spec §3.4）：handoff / revoke / register。
 *
 * 与内置剪辑线并存互不触发：这三个动作**不需要**视频服务在跑（它们不碰 runner、不跑转写），
 * 所以在取服务之前就分流出来——Codex 剪辑工位只装了 ChatCut / 剪映那一套，内置服务没起也得能登记。
 *
 * 写门（P6 §3.8）在各动作内部、重放之后才过：交接出去之后认领已转给 codex，
 * 交接方重发同一份 handoff 不该因为手上没有剪辑师的令牌被拒成 claim_held。
 */
import { gateClaimWrite } from "../storage/claims.js";
import { isContentId } from "../storage/entity-id.js";
import { getDataDir, type ClaimEmployee } from "../storage/local-store.js";
import { handoffVideo } from "../modules/video/handoff/handoff.js";
import { revokeHandoff } from "../modules/video/handoff/revoke.js";
import { isRegisterInput, parseRegisterInput, registerVideo } from "../modules/video/handoff/register.js";
import { handoffFail } from "../modules/video/handoff/types.js";
import { hostOf, videoFail, type VideoToolResult } from "./video-gates.js";
import { storageFailure } from "../storage/storage-error.js";

export const HANDOFF_ACTIONS = ["handoff", "revoke", "register", "report", "citations"] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

export function isHandoffAction(action: string): action is HandoffAction {
  return (HANDOFF_ACTIONS as readonly string[]).includes(action);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function executeVideoHandoff(action: HandoffAction, params: Record<string, unknown>): Promise<VideoToolResult> {
  const contentId = str(params.content_id);
  if (!isContentId(contentId)) return videoFail("需要合法 content_id");
  const dataDir = getDataDir(typeof params._dataDir === "string" ? params._dataDir : undefined);
  const host = hostOf(params);
  const claimToken = str(params.claim_token) || undefined;
  // 交接/撤回是写手那一侧的写；登记是剪辑师的写
  const gate = (employee: ClaimEmployee) => () =>
    gateClaimWrite(contentId, { host, employee, ...(claimToken ? { token: claimToken } : {}) }, dataDir);
  try {
    if (action === "report") return await reportExecution(contentId, params.report, { dataDir, gate: gate("editor") }, host, str(params._session) || undefined);
    if (action === "citations") {
      const allowed = await gate("writer")(); if ("denied" in allowed) return allowed.denied;
      const content = await getContent(contentId, dataDir); if (!content) return videoFail("稿件不存在");
      await saveCoverage(content, params.coverage as CitationCoverage, dataDir); return { ok: true, ...allowed.grant };
    }
    if (action === "revoke" || (action === "handoff" && (params.revoke === true || params.revoke === "true"))) {
      const manifestHash = str(params.manifest_hash) || undefined;
      return await revokeHandoff({ contentId, host, manifestHash, claimToken }, { dataDir, gate: gate("writer") });
    }
    if (action === "handoff") {
      const arollPath = str(params.aroll_path);
      if (!arollPath) return handoffFail("invalid_params", "handoff 需要 aroll_path（口播原片的绝对路径）");
      const session = str(params._session) || undefined;
      const input = { contentId, arollPath, projectRoot: str(params.project_root) || undefined, notes: str(params.notes), host, session, claimToken };
      return await handoffVideo(input, { dataDir, gate: gate("writer") });
    }
    const parsed = parseRegisterInput(params, contentId, host);
    if (!isRegisterInput(parsed)) return parsed;
    return await registerVideo(parsed, { dataDir, gate: gate("editor") });
  } catch (err) {
    const storage = storageFailure(err);
    if (storage) return { ...storage };
    // 交接在写门之后的故障都在交接内部分类收口；漏到这里的只可能发生在认领写入之前
    if (action === "handoff") return handoffFail("handoff_rejected", `handoff 没有执行：${err instanceof Error ? err.message : String(err)}`, { failure_class: "handoff_rejected" });
    return videoFail(`${action} 执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
