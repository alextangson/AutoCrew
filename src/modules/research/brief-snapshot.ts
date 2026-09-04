/**
 * 单一简报快照（P1 spec §3.0）——「当前有效简报」的**唯一入口**。
 *
 * 为什么必须有这个文件：改动前系统里有两套「最新简报」。写稿的研究注入认
 * `job.briefRevision`（指针），而角度解析、聊天角度闸口、选卡 IPC、调研回报、灵感回收
 * 豁免全都认 `loadLatestBrief` = **磁盘上版本号最大的那份**。两者在重跑刚落盘、指针还没
 * CAS 推进（或那一轮结算失败根本不推进）的窗口里就是两个值：同一次生成会把 brief v1 的
 * 事实块注进 prompt，却拿 v2 的角度卡去约束全稿——材料和立意来自两份不同的简报，成稿
 * 的归因（`usedBriefRevision`）也就此说谎。
 *
 * 所以这里**只认 `job.briefRevision`**，并且**禁止回落磁盘最新版**：
 * - 没有 job / 指针为空 = 没有生效简报（返回 null），不是「去磁盘上找一份来顶」。
 *   重跑失败时不推进指针正是设计意图（研究 runner §2）；用磁盘最大版兜底，等于把一份
 *   **没被采纳**的简报偷偷塞进稿子，而且看板上还会显示成「已生效」。
 * - 指针指向的那份坏了 = 没有生效简报（loadBrief 已 warn），同样不回落上一版——
 *   「最新版损坏」是要修的故障，悄悄拿旧版顶上会让人以为重跑生效了。
 *
 * `loadLatestBrief` 从此**只留给 UI 列历史版本**，任何「这稿用哪份简报」的判断都不许再调它。
 *
 * 一次生成只读一次快照：注入、选卡校验、归因共用同一个对象，这样「快照内一致」由类型
 * 保证，而不是靠每个调用点各自记得多读一次。
 */
import { createHash } from "node:crypto";
import { loadBrief, type ResearchBrief } from "./brief-store.js";
import { getJob } from "./research-job-store.js";

export interface BriefSnapshot {
  brief: ResearchBrief;
  /** 生效版本号（= `job.briefRevision`，与 `brief.revision` 由 saveBrief 保证同值） */
  revision: number;
  /** 内容指纹：canonical JSON 的 sha256 前 16 位。归因落盘用，回溯时能证明「就是这份」 */
  hash: string;
}

/** 键序无关的 canonical JSON：同一份简报无论字段怎么排，指纹恒定 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** 内容指纹：canonical JSON 的 sha256 前 16。简报、角度卡共用同一把尺 */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf-8").digest("hex").slice(0, 16);
}

export function briefHash(brief: ResearchBrief): string {
  return contentHash(brief);
}

/**
 * 当前有效简报快照。**永不抛**：读盘/台账故障一律降级成「没有简报」并 warn——
 * 写稿宁可少一块材料，也不该因为一次读盘失败整条链断掉。
 */
export async function resolveEffectiveBrief(
  topicId: string,
  dataDir: string,
  warn?: (message: string) => void,
): Promise<BriefSnapshot | null> {
  try {
    const job = await getJob(topicId, dataDir);
    // 没有指针就是没有简报——绝不用磁盘最新版兜底（见文件头）
    if (!job || job.briefRevision === undefined) return null;
    const brief = await loadBrief(topicId, job.briefRevision, dataDir, warn);
    if (!brief) return null; // 坏文件 / 未知 schemaVersion：loadBrief 已经 warn 过
    if (brief.revision !== job.briefRevision) {
      // saveBrief 用 brief.revision 定文件名，两者对不上说明盘上这份被人手改过
      warn?.(
        `简报内容与文件名版本不符（${topicId}：指针 v${job.briefRevision}，文件内记 v${brief.revision}）——按「无简报」处理`,
      );
      return null;
    }
    return { brief, revision: brief.revision, hash: briefHash(brief) };
  } catch (err) {
    warn?.(
      `当前有效简报读取失败（${topicId}）：${err instanceof Error ? err.message : String(err)}——按「无简报」处理`,
    );
    return null;
  }
}
