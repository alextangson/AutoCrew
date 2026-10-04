/**
 * 片单闸口（创始人 2026-10-04 规则）：没进当前选题会片单的选题，不能开新稿。
 *
 * 「新稿」= 这次调用会为一个还没有任何未归档稿件的选题开出第一篇稿。改已有稿、补证、
 * 平台改写、手动导入都不经过这里。所有开写入口（workflow prepare / write、writer pack、
 * generate、看板「开始写」、桌面后台写稿）共用 `newDraftSlateRefusal` 一个判定。
 *
 * 「当前片单」= 最近一场会议记录的 slots（单题会无论哪天开都追加进这份记录）。上一场选中、
 * 这一场没再选中 → 拦。会议记录读不出 → 报读失败，既不放行也不冒充「没开过会」。
 */
import { isPlaceholderBody, listContentsStrict, type Content } from "../../storage/local-store.js";
import { latestMeetingDate, readMeeting } from "./meeting-store.js";

/** 用户可见文案集中在这里（创始人过目） */
export const SLATE_GATE_COPY = {
  notOnSlate: "这条还不在本周片单上。先开个选题会（只放这一条也行），定下来再开写。",
  noMeeting: "还没开过选题会，片单是空的。先开个选题会（只放这一条也行），定下来再开写。",
  noTopic: "开新稿要先有选题，并且进了本周片单。先建选题、开个选题会（只放这一条也行），再开写。",
  readFailed: "片单读不出来，没法确认这条在不在本周片单上，先不开写。",
} as const;

export interface SlateRefusal {
  ok: false;
  code: "not_on_slate" | "slate_read_failed";
  error: string;
  next_action: Record<string, unknown>;
  [key: string]: unknown;
}

const MEETING_NEXT = {
  skill: "topic-meeting",
  tool: "autocrew_insights",
  params: { action: "meeting_brief" },
  note: "按 topic-meeting 技能开会（临时蹭热点就开单题会：meeting_save 的 meeting 里带 append:true，这一条追加进最近一场会），存好片单后再回来开写。不要自己绕过。",
} as const;

/**
 * 真稿 = 未删、未归档、存下来的正文（当前 body 或任一版本）不是占位。
 * 不看 status：status 能被 transition/update 改，靠它判断等于把闸口交给一次状态改写；
 * 而占位正文（空白 / create_variant 垫的选题描述）在 MCP 上不能绕开 writer submit 填实。
 */
function isRealDraft(c: Content): boolean {
  if (c.deletedAt || c.status === "archived") return false;
  return !isPlaceholderBody(c.body) || (c.versions ?? []).some((v) => !isPlaceholderBody(v.body));
}

/** 该选题是否已有真稿（有 = 不是新稿）。严格读：任何一条稿件记录读不出就抛 */
export async function topicHasDraft(topicId: string, dataDir?: string): Promise<boolean> {
  return (await listContentsStrict(dataDir)).some((c) => c.topicId === topicId && isRealDraft(c));
}

/** 选题是否在当前有效片单里；读失败直接抛（调用方转成 slate_read_failed） */
export async function slateStatus(topicId: string, dataDir?: string): Promise<{ onSlate: boolean; meetingDate: string | null }> {
  const date = await latestMeetingDate(dataDir);
  if (!date) return { onSlate: false, meetingDate: null };
  const record = await readMeeting(date, dataDir);
  if (!record) throw new Error(`会议记录 meetings/${date}.json 刚才还在、现在读不到`);
  return { onSlate: record.slots.some((s) => s.topicId === topicId), meetingDate: date };
}

function refusal(code: SlateRefusal["code"], error: string, extra: Record<string, unknown> = {}): SlateRefusal {
  return { ok: false, code, error, next_action: { ...MEETING_NEXT }, ...extra };
}

/**
 * 开新稿前的唯一判定。返回 null = 放行；否则返回结构化拒绝（不抛异常）。
 * topicId 为空 = 没有选题的新稿，必然不在片单上。
 */
export async function newDraftSlateRefusal(topicId: string | undefined, dataDir?: string): Promise<SlateRefusal | null> {
  const id = topicId?.trim();
  if (!id) return refusal("not_on_slate", SLATE_GATE_COPY.noTopic);
  try {
    if (await topicHasDraft(id, dataDir)) return null;
    const { onSlate, meetingDate } = await slateStatus(id, dataDir);
    if (onSlate) return null;
    return refusal("not_on_slate", meetingDate ? SLATE_GATE_COPY.notOnSlate : SLATE_GATE_COPY.noMeeting, { topic_id: id, current_meeting: meetingDate });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return refusal("slate_read_failed", `${SLATE_GATE_COPY.readFailed}（${raw}）`, {
      topic_id: id, next_action: { note: "把原始错误告诉创作者，修好 meetings/ 下的会议记录再试；不要绕过。" },
    });
  }
}
