/**
 * 交接的阶段门（P6 spec §3.1 / §3.4；codex 评审 #4）。
 *
 * 能交剪辑的只有两种稿：
 * - 最近一次审稿结论 = accepted（`review.status` 为 passed / revised，且没因改稿失效）；
 * - accepted_with_issues（`review.status = failed`：自动修订到顶仍有阻断）**并且**创作者对**这一版**
 *   明确点了 `adopted`（editorial feedback 记的 `adoption.draftHash` 等于当前稿指纹）。
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

function adoptedCurrent(content: Content, hash: string): boolean {
  return content.adoption?.verdict === "adopted" && content.adoption.draftHash === hash;
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
    if (adoptedCurrent(content, hash)) return null;
    const blockers = content.review.issues.filter((i) => i.severity === "blocker").length;
    return handoffFail("not_accepted", `审稿还有 ${blockers} 条阻断，创作者确认采纳这一版后才能交剪辑`, {
      review_status: "accepted_with_issues",
      next_action: {
        tool: "autocrew_editorial",
        params: { action: "inspect", content_id: content.id },
        message: "把阻断问题逐条摆给创作者；他明确说采纳这一版，才用 feedback{verdict:\"adopted\", user_confirmed:true} 记下，再来交接。不能替他点。",
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
