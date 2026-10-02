/** 立意 pass 要的选题会上下文（选题会 spec §7）：会议位摘要 + 形式表现摘要（带 n，只当参考） */
import { getTopic } from "../../storage/local-store.js";
import type { MeetingAngleSlot } from "../research/angle-meeting.js";
import { buildMeetingBrief } from "./meeting-brief.js";
import { readMeeting } from "./meeting-store.js";
import type { GroupRow } from "./meeting-works.js";

const METRIC_LABEL: Record<string, string> = { views: "播放", completion5s: "5秒完播率" };

function groupLine(g: GroupRow): string {
  const head = `${g.platform} D+${g.day} ${METRIC_LABEL[g.metric] ?? g.metric}｜${g.key}`;
  return g.stat.status === "ok"
    ? `${head}：中位 ${g.stat.median}（n=${g.stat.n}）`
    : `${head}：n=${g.stat.n} 不足 5，只列数 ${g.stat.values.join("、")}`;
}

export function formatSummaryOf(groups: GroupRow[]): string {
  const lines = groups.filter((g) => g.dimension === "format" && g.key !== "未标").map(groupLine);
  return lines.length ? lines.join("\n") : "暂无按形式的同龄数据（冷启动或作品未标形式），不作依据。";
}

async function slotOf(topicId: string, dataDir: string): Promise<MeetingAngleSlot | undefined> {
  const pointer = (await getTopic(topicId, dataDir))?.meetingSlot;
  if (!pointer) return undefined;
  const record = await readMeeting(pointer.meetingDate, dataDir);
  const slot = record?.slots.find((s) => s.slotId === pointer.slotId);
  if (!slot) throw new Error(`选题标着会议位 ${pointer.meetingDate} ${pointer.slotId}，但会议记录里找不到这一位`);
  return { meetingDate: pointer.meetingDate, slotId: slot.slotId, persona: slot.persona, payoff: slot.payoff, format: slot.format, bet: slot.bet };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * 两块分开读、分开失败：读不到的原因放进 problems，由调用方写进简报 gaps——
 * 让人看见这轮立意没吃到会议位 / 形式摘要，而不是静默照旧。
 */
export async function meetingAngleContext(topicId: string, dataDir: string): Promise<{ meetingSlot?: MeetingAngleSlot; formatSummary?: string; problems: string[] }> {
  const problems: string[] = [];
  const meetingSlot = await slotOf(topicId, dataDir).catch((err) => { problems.push(`会议位读取失败：${errText(err)}`); return undefined; });
  const formatSummary = await buildMeetingBrief(dataDir).then((b) => formatSummaryOf(b.groups))
    .catch((err) => { problems.push(`形式表现摘要读取失败：${errText(err)}`); return undefined; });
  return { ...(meetingSlot ? { meetingSlot } : {}), ...(formatSummary ? { formatSummary } : {}), problems };
}
