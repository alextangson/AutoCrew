/**
 * 派生稿发布前的唯一一道核对（Codex 审 Phase 1 P1）：源视频成片换版 / 撤批 / 文件变了之后，按旧成片做的
 * 英文版、公众号文章一律不出包、不进草稿箱、不给复制——所有发布出口都调这一个函数，不各抄一份。
 * 读不出来源状态也拒（宁可拦下问一句，不放过期稿出去）。
 */
import { getContent, type Content } from "../../storage/local-store.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { staleReason } from "./lineage.js";

export type DerivedRefusal = { code: "derived_stale" | "derived_source_unreadable"; error: string };

export async function derivedPublishRefusal(content: Pick<Content, "derivedFrom">, dataDir: string): Promise<DerivedRefusal | null> {
  if (!content.derivedFrom) return null;
  try {
    const reason = await staleReason(content, dataDir, { fresh: true });
    return reason ? { code: "derived_stale", error: `这条派生稿过期了，不能发：${reason}` } : null;
  } catch (e) {
    return { code: "derived_source_unreadable", error: `来源状态读不出来，先不发：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 按 id 核；稿件不存在交给各出口自己报（它们有现成的「不存在」说法） */
export async function derivedPublishRefusalById(contentId: unknown, dataDir: string): Promise<DerivedRefusal | null> {
  if (typeof contentId !== "string" || !contentId.trim()) return null;
  const content = await getContent(contentId.trim(), dataDir).catch(missingAsNull);
  return content ? derivedPublishRefusal(content, dataDir) : null;
}
