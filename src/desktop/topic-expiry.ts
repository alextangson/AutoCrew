/**
 * 灵感库过期清理（IA v5 · 创始人 2026-07-08 灵感库习惯裁决）——
 * 灵感默认保留 3 天:到期仍未进入下一阶段(没有任何稿件以它为血缘,即没被选上)
 * 的灵感自动移入回收站。软删不硬删:可恢复,且回收站参与查重——被清理的灵感
 * 不会被雷达/侦查第二天原样还魂(除非用户手动捞回,那是显式意愿)。
 *
 * 被选上的灵感(存在 content.topicId 指向它)永不自动清理:它是归因链的锚。
 * 与 orphan-reconcile 同节奏:server 启动时全工作区扫一遍。
 */
import { listWorkspaces } from "./workspace-store.js";
import { listTopics, listContents, softDeleteTopic } from "../storage/local-store.js";
import { emitEngineEvent } from "./event-hub.js";

export const TOPIC_TTL_MS = 3 * 24 * 3600_000;

export interface TopicExpiryResult {
  /** 各工作区清理数(仅含 >0 的) */
  expiredByWorkspace: Record<string, number>;
  total: number;
  /** 因血缘被保护的到期灵感数(全工作区合计) */
  protectedByLineage: number;
}

export async function expireStaleTopics(
  opts?: { ttlMs?: number; now?: number },
): Promise<TopicExpiryResult> {
  const ttlMs = opts?.ttlMs ?? TOPIC_TTL_MS;
  const now = opts?.now ?? Date.now();
  const { workspaces } = await listWorkspaces();
  const expiredByWorkspace: Record<string, number> = {};
  let total = 0;
  let protectedByLineage = 0;

  for (const ws of workspaces) {
    let expired = 0;
    try {
      const [topics, contents] = await Promise.all([listTopics(ws.dataDir), listContents(ws.dataDir)]);
      const usedTopicIds = new Set(contents.map((c) => c.topicId).filter((id): id is string => Boolean(id)));
      for (const t of topics) {
        // 续期锚：有动作(如启动深调研)就从那一刻重新计时,没有才回落 createdAt
        const age = now - new Date(t.renewedAt ?? t.createdAt).getTime();
        if (!(age > ttlMs)) continue; // 未到期(含坏时间戳 NaN:比较为 false,不误删)
        if (usedTopicIds.has(t.id)) {
          protectedByLineage += 1;
          continue;
        }
        const deleted = await softDeleteTopic(t.id, ws.dataDir);
        if (deleted) expired += 1;
      }
    } catch {
      continue; // 单工作区坏数据不阻断其余清理
    }
    if (expired > 0) {
      expiredByWorkspace[ws.id] = expired;
      total += expired;
      await emitEngineEvent(
        {
          role: "scout",
          kind: "work",
          label: `灵感库清理:${expired} 条超过 3 天未选用的灵感已移入回收站(可恢复)`,
        },
        ws.dataDir,
      );
    }
  }

  return { expiredByWorkspace, total, protectedByLineage };
}
