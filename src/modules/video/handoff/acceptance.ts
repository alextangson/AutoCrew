/**
 * 交接的阶段门（P6 spec §3.1 / §3.4；codex 评审 #4）。
 *
 * 能交剪辑的只有两种稿：
 * - 最近一次审稿结论 = accepted（`review.status` 为 passed / revised，且没因改稿失效）；
 * - accepted_with_issues（`review.status = failed`：自动修订到顶仍有阻断）**不放行**——没有模型可填的采纳通道。
 * 未审、审稿作废（改过稿）、宿主自己说「差不多」都不算——带 blocker 的稿送去剪是最贵的返工。
 */
import { draftHash } from "../../../storage/draft-hash.js";
import { isVideoPlatform } from "../../../storage/stage-guard.js";
import { CONTENT_STATUS_LABEL, type Content, type ContentStatus } from "../../../storage/local-store.js";
import { handoffFail, type HandoffResult } from "./types.js";

export const HANDOFF_FROM: ReadonlySet<ContentStatus> = new Set<ContentStatus>(["draft_ready", "approved"]);

function reviewValid(content: Content, hash: string): boolean {
  const review = content.review;
  if (!review || (review.status !== "passed" && review.status !== "revised")) return false;
  return !review.source?.draftHash || review.source.draftHash === hash;
}


function statusBlock(content: Content): HandoffResult | null {
  if (!isVideoPlatform(content.platform)) {
    return handoffFail("not_handoffable", `剪辑只属于视频平台稿件，这篇是 ${content.platform || "未设平台"}`);
  }
  if (HANDOFF_FROM.has(content.status)) return null;
  const label = CONTENT_STATUS_LABEL[content.status] ?? content.status;
  const editing = content.status === "editing";
  return handoffFail("not_handoffable",
    editing
      ? "这篇已经交给剪辑工位了：要换 A-roll / 改稿，先 autocrew_video revoke 撤回当前代次再交"
      : `稿件现在是「${label}」，只有草稿就绪 / 已过审的稿能交剪辑`,
    editing ? { next_action: { tool: "autocrew_video", params: { action: "revoke", content_id: content.id } } } : {});
}

/** null = 放行；否则是可原样回给宿主的拒绝（带 next_action） */
export function acceptanceBlock(content: Content): HandoffResult | null {
  const blocked = statusBlock(content);
  if (blocked) return blocked;
  const hash = draftHash(content);
  if (reviewValid(content, hash)) return null;
  if (content.review?.status === "failed") {
    // P6-e 行为 eval（handoff-blocks-issues 0/3）证明：「创作者点了采纳」这个 flag 由模型自填，
    // 3/3 都在用户没看到阻断前就替他点了。所以这里不再有采纳通道：改掉阻断、审到 accepted 才交。
    const blockers = content.review.issues.filter((i) => i.severity === "blocker");
    return handoffFail("not_accepted", `审稿还有 ${blockers.length} 条阻断：改掉并重新审到 accepted 才能交剪辑。没有「就用这一版」的采纳通道（模型不能替创作者点）；创作者坚持用这一版，就把这 ${blockers.length} 条按核实结果处理后重新审稿——审稿如实标 host_self_review`, {
      review_status: "accepted_with_issues",
      blockers,
      next_action: {
        tool: "autocrew_writer",
        params: { action: "submit", content_id: content.id, revision_of: hash },
        message: "把阻断逐条摆给创作者；按问题范围修订，用 submit{revision_of} 重交并重新审稿，审到 accepted 再来交接。别建议他去工作台点采纳——交接不看采纳。",
      },
    });
  }
  const why = content.review?.status === "stale" ? "审稿之后稿子改过，那次结论作废了" : "这一版还没有通过审稿";
  return handoffFail("not_accepted", `${why}：审稿结论为 accepted 的稿才能交剪辑`, {
    review_status: content.review?.status ?? "none",
    next_action: {
      tool: "autocrew_review_desk",
      params: { action: "pack", content_id: content.id },
      message: "先把当前稿审完（结论 accepted），再交剪辑。",
    },
  });
}
