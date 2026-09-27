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
import { matchAroll } from "../modules/video/handoff/match.js";
import { confirmHandoff } from "../modules/video/handoff/confirm.js";

async function guarded(action: string, fn: () => Promise<VideoToolResult>): Promise<VideoToolResult> {
  try {
    return await fn();
  } catch (err) {
    const storage = storageFailure(err);
    if (storage) return { ...storage };
    return videoFail(`${action} 执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** report 的故障都带码：内部抛出的「code: 说明」取前缀，其余（磁盘等）归 report_failed，Codex 按码决定重试还是停 */
function reportFailure(err: unknown): VideoToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = /^([a-z][a-z_]+)(?::|$)/.exec(message)?.[1] ?? "report_failed";
  return videoFail(`report 没有落盘：${message}`, { code });
}

export const HANDOFF_ACTIONS = ["handoff", "revoke", "register", "report", "citations", "match", "confirm"] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

export function isHandoffAction(action: string): action is HandoffAction {
  return (HANDOFF_ACTIONS as readonly string[]).includes(action);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function executeVideoHandoff(action: HandoffAction, params: Record<string, unknown>): Promise<VideoToolResult> {
  const dataDir = getDataDir(typeof params._dataDir === "string" ? params._dataDir : undefined);
  // 认稿不针对某一篇：content_id 正是它要找出来的东西
  if (action === "match") return guarded(action, () => matchAroll({ arollPath: str(params.aroll_path), requestId: str(params.request_id) }, dataDir));
  if (action === "confirm") {
    return guarded(action, () => confirmHandoff({
      receiptId: str(params.receipt_id), contentId: str(params.content_id) || undefined, coverText: str(params.cover_text),
      targetSeconds: Number(params.target_seconds), requestId: str(params.request_id),
    }, dataDir));
  }
  const contentId = str(params.content_id);
  if (!isContentId(contentId)) return videoFail("需要合法 content_id");
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
      await saveCoverage(content, params.coverage as CitationCoverage, dataDir);
      // §12.4-A：出处交齐后写稿侧显式放手，Codex 认稿自接才不会被一个闲着的写稿认领挡成 claim_held
      return { ok: true, ...allowed.grant, next_action: { tool: "autocrew_desk", params: { action: "release", content_id: contentId }, message: "出处已交齐：带上 claim_token 调 autocrew_desk release 释放写稿认领，录好的原片由 Codex 认稿后自接。还要改稿就先别释放。" } };
    }
    if (action === "revoke" || (action === "handoff" && (params.revoke === true || params.revoke === "true"))) {
      const manifestHash = str(params.manifest_hash) || undefined;
      return await revokeHandoff({ contentId, host, manifestHash, claimToken }, { dataDir, gate: gate("writer") });
    }
    if (action === "handoff") {
      const arollPath = str(params.aroll_path);
      if (!arollPath && !str(params.confirmation_id)) return handoffFail("invalid_params", "handoff 需要 aroll_path（口播原片的绝对路径）");
      const session = str(params._session) || undefined;
      const confirmationId = str(params.confirmation_id) || undefined;
      const input = { contentId, arollPath, projectRoot: str(params.project_root) || undefined, notes: str(params.notes), host, session, claimToken,
        ...(confirmationId ? { confirmationId, requestId: str(params.request_id) } : {}) };
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
    if (action === "report") return reportFailure(err);
    return videoFail(`${action} 执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
