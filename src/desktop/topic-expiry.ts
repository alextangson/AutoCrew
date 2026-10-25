/**
 * 灵感库过期清理（IA v5 · 创始人 2026-07-08 灵感库习惯裁决；2026-10-25 管线重规划 §6 Q5 改 7 天）——
 * 灵感默认保留 7 天（口径见 modules/radar/topic-aging.ts：≥3 星 / 捞回过的不老化，旧选题从上线日起算）:到期仍未进入下一阶段(没有任何稿件以它为血缘,即没被选上)
 * 的灵感自动移入回收站。软删不硬删:可恢复,且回收站参与查重——被清理的灵感
 * 不会被雷达/侦查第二天原样还魂(除非用户手动捞回,那是显式意愿)。
 *
 * 被选上的灵感(存在 content.topicId 指向它)永不自动清理:它是归因链的锚。
 * 与 orphan-reconcile 同节奏:server 启动时全工作区扫一遍。
 */
import { listWorkspaces } from "./workspace-store.js";
import { listTopics, listContents, softDeleteTopic, getTopic, type Topic } from "../storage/local-store.js";
import { TOPIC_TTL_MS, agingAnchor, agingExempt, ensureAgingStart } from "../modules/radar/topic-aging.js";
import { resolveEffectiveBrief } from "../modules/research/brief-snapshot.js";
import { angleCardsOf } from "../modules/research/angle-cards.js";
import { emitEngineEvent } from "./event-hub.js";
import { inCurrentSlate, latestMeetingDate } from "../modules/meetings/meeting-store.js";

export { TOPIC_TTL_MS };

/**
 * 等选角豁免（角度卡 spec §1.7）：调研跑完、角度卡摆在那儿等创始人挑，这条选题
 * 不该因为「入库超过 7 天」被当成没人要的灵感清走——那是**正在办的事**，不是烂尾。
 * 简报 `generatedAt` 当续期锚：从调研落定那一刻重新计时（不新增状态字段）。
 *
 * 已经选过角度的照常计时——选完还不写，那就是真放下了。
 * 简报读不动一律按「没有简报」处理：豁免是加保护，加不上不该反过来阻断清理
 * （`resolveEffectiveBrief` 自己吞异常并降级，这里不需要再 catch）。
 */
async function expiryAnchor(topic: Topic, dataDir: string, agingStart: number): Promise<number> {
  const base = agingAnchor(topic, agingStart);
  if (topic.selectedAngle) return base;
  // 认生效简报（P1 §3.0）：磁盘上最大版可能是一份从未被采纳的重跑残留，
  // 拿它续期等于给一条其实没结果的选题白续期
  const snap = await resolveEffectiveBrief(topic.id, dataDir);
  if (!snap || angleCardsOf(snap.brief).length === 0) return base;
  const generatedAt = new Date(snap.brief.generatedAt).getTime();
  // 坏时间戳不许把锚点污染成 NaN——那会让这条选题从此永不回收
  return Number.isFinite(generatedAt) ? Math.max(base, generatedAt) : base;
}

async function reportMeetingReadFailure(err: unknown, dataDir: string): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[topic-expiry] 会议记录读不出，本轮不清理片单选题：${message}`);
  await emitEngineEvent({ role: "scout", kind: "work", label: `灵感库清理：会议记录读不出（${message}），本轮跳过带会议位的选题` }, dataDir);
}

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
      const meeting = await latestMeetingDate(ws.dataDir).then((date) => ({ ok: true as const, date }), (err: unknown) => ({ ok: false as const, err }));
      if (!meeting.ok) await reportMeetingReadFailure(meeting.err, ws.dataDir);
      const agingStart = await ensureAgingStart(ws.dataDir, now);
      for (const t of topics) {
        if (agingExempt(t)) continue; // ≥3 星 / 捞回过的不老化
        // 会议位豁免（选题会 spec 边界 8）：只豁免到下次开会；下次没再选中就恢复正常过期。
        // 会议记录读不出时，这一轮带会议位的一律不清（宁可晚清，也不把片单当灵感清走）
        if (t.meetingSlot && (!meeting.ok || inCurrentSlate(t, meeting.date))) continue;
        // 续期锚：有动作(如启动深调研)就从那一刻重新计时,没有才回落 createdAt
        if (!(now - agingAnchor(t, agingStart) > ttlMs)) continue; // 未到期(坏时间戳 NaN 同理不误删)
        // 到期了才去读简报：sweep 是启动全量扫,没到期的那批一次盘都不该多读
        const age = now - (await expiryAnchor(t, ws.dataDir, agingStart));
        if (!(age > ttlMs)) continue; // 等选角豁免命中
        if (usedTopicIds.has(t.id)) {
          protectedByLineage += 1;
          continue;
        }
        // 清理和打星并发：列表是一轮开头读的，删之前重读一次，刚打上 ≥3 星 / 刚续期的不清
        const fresh = await getTopic(t.id, ws.dataDir);
        if (!fresh || fresh.deletedAt || agingExempt(fresh) || fresh.renewedAt !== t.renewedAt) continue;
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
          label: `灵感库清理:${expired} 条超过 7 天没打星也没选用的灵感已移入回收站(可恢复)`,
        },
        ws.dataDir,
      );
    }
  }

  return { expiredByWorkspace, total, protectedByLineage };
}
