/**
 * `autocrew_video revoke`（或 `handoff{revoke:true}`）：撤回当前交接代次（P6 spec §3.1 / §3.4）。
 *
 * - 只撤**当前**代次；撤过的清单哈希进 `video.revoked[]`，此后带它的 `register` 一律 `stale_handoff`，
 *   交接包文件留着但永久作废（codex #7：撤回不可复活）。
 * - 状态 editing → draft_ready 与 revoked[] 同一次落盘。
 * - 认领：交接的那个宿主来撤 → 认领转回它的写手桌并回新令牌；剪辑工位自己撤 → 认领清掉，
 *   交接方下一次写自动认领（它手上没有别人的令牌，转过去等于把它锁在门外 30 分钟）。
 * - 重复撤回 = 重放，返回同一个结论。
 */
import { transferClaim } from "../../../storage/claims.js";
import { CONTENT_STATUS_LABEL, getContent, transitionStatus, updateContent, withHandoff } from "../../../storage/local-store.js";
import type { Grant, HandoffContext } from "./handoff.js";
import { serializeVideoLine } from "./lock.js";
import { pullDeps } from "./pull-deps.js";
import { moveArollBack, readJournal } from "./aroll-move.js";
import { bumpRevokeEpoch, releaseArollLock, withGlobalHandoffLock } from "./pull-store.js";
import { handoffFail, type HandoffResult, type VideoHandoffRecord } from "./types.js";

export interface RevokeInput {
  contentId: string;
  host: string;
  /** 可选：指明要撤哪一代（不是当前代次就拒） */
  manifestHash?: string;
  claimToken?: string;
}

function revokedResult(record: VideoHandoffRecord, contentStatus: string, extra: Record<string, unknown> = {}): HandoffResult {
  return {
    ok: true,
    status: "revoked",
    content_id: record.content_id,
    generation: record.generation,
    manifest_hash: record.hash,
    content_status: contentStatus,
    note: `第 ${record.generation} 代交接已作废：Codex 用它登记会被拒（stale_handoff）。改完稿重新 handoff 会是新代次。`,
    ...extra,
  };
}

async function returnClaim(record: VideoHandoffRecord, input: RevokeInput, grant: Grant, dataDir: string): Promise<Grant> {
  const note = `撤回交接 g${record.generation}`;
  if (input.host === record.by) {
    const back = await transferClaim(record.content_id, {
      token: grant.claim_token ?? input.claimToken,
      host: input.host,
      toEmployee: "writer",
      toHost: input.host,
      note,
    }, dataDir);
    return back.ok ? { claim_token: back.claim.token } : {};
  }
  const current = await getContent(record.content_id, dataDir);
  if (current) {
    const handoffs = withHandoff(current, { from: "editor", to: "writer", by: input.host, note: `${note}（认领释放）` });
    await updateContent(record.content_id, { claim: undefined, handoffs }, dataDir);
  }
  return {};
}

/** 撤回把原片挪回原路径（被占就回 Downloads 加后缀），校验后才释放原片锁（§13.4-F） */
async function returnAroll(record: VideoHandoffRecord, contentId: string, dataDir: string): Promise<Record<string, unknown>> {
  const journal = await readJournal(dataDir, record.aroll_sha256);
  if (!journal || journal.content_id !== contentId) {
    await releaseArollLock(dataDir, record.aroll_sha256, contentId);
    return {};
  }
  try {
    return { aroll_restored_to: await moveArollBack(dataDir, journal, pullDeps().downloadsDir) };
  } catch (err) {
    return { aroll_restore_failed: `${err instanceof Error ? err.message : String(err)}；原片锁保留，重启 AutoCrew 后自动再试` };
  }
}

export async function revokeHandoff(input: RevokeInput, ctx: HandoffContext): Promise<HandoffResult> {
  return withGlobalHandoffLock(() => serializeVideoLine(input.contentId, () => revokeLocked(input, ctx)));
}

async function revokeLocked(input: RevokeInput, ctx: HandoffContext): Promise<HandoffResult> {
  const content = await getContent(input.contentId, ctx.dataDir);
  if (!content) return handoffFail("invalid_params", `稿件不存在：${input.contentId}`);
  const record = content.video?.handoff;
  if (!record) return handoffFail("nothing_to_revoke", "这篇还没交接过剪辑，没有可撤回的代次");
  if (input.manifestHash && input.manifestHash !== record.hash) {
    return handoffFail("stale_handoff", `只能撤当前代次（第 ${record.generation} 代）`, {
      current_generation: record.generation,
      expected_manifest_hash: record.hash,
    });
  }
  if ((content.video?.revoked ?? []).includes(record.hash)) {
    return revokedResult(record, content.status, { replayed: true });
  }
  if (content.status !== "editing") {
    const label = CONTENT_STATUS_LABEL[content.status] ?? content.status;
    return handoffFail("not_editing", `稿件现在是「${label}」，只有剪辑中的交接能撤回（已登记的成片不撤）`);
  }
  const gate = await ctx.gate();
  if ("denied" in gate) return gate.denied;
  const moved = await transitionStatus(content.id, "draft_ready", {
    expectedStatus: "editing",
    host: input.host,
    patch: (current) => ({ video: { ...current.video, revoked: [...(current.video?.revoked ?? []), record.hash] } }),
  }, ctx.dataDir);
  if (!moved.ok) return { ...handoffFail("handoff_failed", `撤回没落盘：${moved.error ?? "未知原因"}`), ...gate.grant };
  // 之前签发的认稿回执一律作废；原片锁随撤回释放（认错稿撤回后，这段原片可以交给对的那条）
  await bumpRevokeEpoch(ctx.dataDir, new Date(pullDeps().now()).toISOString());
  const aroll = await returnAroll(record, content.id, ctx.dataDir);
  return revokedResult(record, "draft_ready", { ...aroll, ...(await returnClaim(record, input, gate.grant, ctx.dataDir)) });
}
