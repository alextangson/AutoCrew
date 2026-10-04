/**
 * 选题会落库（选题会 spec §2.6 / §4 / 边界 5、6、7、10、11）。
 *
 * 一次保存 = 会议记录（CAS）+ 每个选中位一条 hypothesis + 选题上的 meetingSlot 指针。
 * 选中≠开工：这里不建稿、不碰认领、不开写稿窗口（§0.3）。
 */
import { getTopic, listContents, updateTopic, type Content } from "../../storage/local-store.js";
import { resolveEffectiveBrief } from "../research/brief-snapshot.js";
import { angleCardsOf } from "../research/angle-cards.js";
import { appendHypotheses, listHypotheses, type Hypothesis, type MetricFocus } from "../retro/hypotheses.js";
import { applyJudgement } from "../retro/hypothesis-judge.js";
import { shanghaiDate } from "../flywheel/outcome-schema.js";
import { listArg, readRejected, readReviews, readSlot } from "./meeting-args.js";
import { assertMeetingDate, latestMeetingDate, readMeeting, saveMeetingCas, type MeetingRecord, type MeetingSlot } from "./meeting-store.js";
import { buildMeetingBrief } from "./meeting-brief.js";

export interface SaveMeetingArgs {
  date?: unknown; expected_revision?: unknown; slots?: unknown; rejected?: unknown; reviews?: unknown; notes?: unknown;
  /** 单题会：只追加这几个位到当日会议，已存的位、下注、毙题原样保留（仍走 CAS） */
  append?: unknown;
}

/** 选题现状：已在写/被认领 → 只标记、不重复建、不抢认领（边界 6） */
function topicStatus(topicId: string, contents: Content[]): string | null {
  const live = contents.filter((c) => c.topicId === topicId && c.status !== "archived");
  if (!live.length) return null;
  return live.map((c) => `${c.id}（${c.status}${c.claim ? "，已被认领" : ""}）`).join("、");
}

/** 已有立意卡或选中角度：会议位注入不进去，必须由创始人定重跑还是接受偏离（边界 7） */
async function angleConflict(topicId: string, dataDir?: string): Promise<string | null> {
  const topic = await getTopic(topicId, dataDir);
  if (topic?.selectedAngle) return "已选中立意卡";
  const snap = await resolveEffectiveBrief(topicId, dataDir ?? "");
  return snap && angleCardsOf(snap.brief).length ? "已有立意卡" : null;
}

async function readSlots(raw: unknown, date: string, dataDir?: string) {
  const slots: MeetingSlot[] = [];
  const errors: string[] = [];
  for (const [i, o] of listArg(raw, "slots").entries()) {
    const { slot, errors: e } = readSlot(o, i, date);
    errors.push(...e);
    if (!slot) continue;
    const topic = await getTopic(slot.topicId, dataDir);
    if (!topic || topic.deletedAt) { errors.push(`slots[${i}].topic_id ${slot.topicId} 不存在或在回收站`); continue; }
    const conflict = await angleConflict(slot.topicId, dataDir);
    if (conflict && !slot.angleDecision) {
      errors.push(`slots[${i}]「${topic.title}」${conflict}——会议位注入不进去，先问创始人：重跑立意（angle_decision:"rerun"）还是接受偏离（"accept_deviation"）`);
    }
    slots.push({ ...slot, title: topic.title });
  }
  const ids = slots.map((s) => s.slotId);
  if (new Set(ids).size !== ids.length) errors.push("slot_id 重复");
  return { slots, errors };
}

/**
 * 同日重存时 slotId 跟着选题走，不跟着顺序走：[A,B] 重存成 [B]，B 仍是原来的位，
 * 不会把 A 的下注改写成 B、也不会留下一条指向 B 的孤儿下注。新题取一个没用过的位号。
 */
function stabilizeSlotIds(slots: MeetingSlot[], previous: MeetingRecord | null, date: string): MeetingSlot[] {
  const byTopic = new Map((previous?.slots ?? []).map((s) => [s.topicId, s.slotId]));
  const taken = new Set(byTopic.values());
  let n = 0;
  const nextFree = () => { do n += 1; while (taken.has(`s${n}`)); taken.add(`s${n}`); return `s${n}`; };
  const out = slots.map((s) => ({ s, id: byTopic.get(s.topicId) }));
  for (const o of out) if (!o.id) o.id = taken.has(o.s.slotId) ? nextFree() : (taken.add(o.s.slotId), o.s.slotId);
  return out.map(({ s, id }) => ({ ...s, slotId: id!, hypothesisId: `hyp-meeting-${date}-${id}` }));
}

/** 上一版片单里有、这一版拿掉的位：下注标 withdrawn，不再对账 */
async function withdrawnBets(previous: MeetingRecord | null, slots: MeetingSlot[], dataDir?: string): Promise<Hypothesis[]> {
  const kept = new Set(slots.map((s) => s.hypothesisId));
  const gone = new Set((previous?.slots ?? []).map((s) => s.hypothesisId).filter((id) => !kept.has(id)));
  if (!gone.size) return [];
  return (await listHypotheses(dataDir)).filter((h) => gone.has(h.id) && h.status === "open").map((h) => ({ ...h, status: "withdrawn" as const }));
}

function betOf(slot: MeetingSlot, date: string, contents: Content[], now: string): Hypothesis {
  return {
    id: slot.hypothesisId, statement: slot.bet, metricFocus: slot.watch.metric as MetricFocus, direction: "up",
    scope: { platform: slot.watch.platform }, contentIds: contents.filter((c) => c.topicId === slot.topicId && c.status !== "archived").map((c) => c.id),
    proposedAt: now, retroRunId: `meeting-${date}`, status: "open", topicId: slot.topicId, meetingDate: date,
    slotId: slot.slotId, probability: slot.probability, premortem: slot.premortem, watchDay: slot.watch.day,
  };
}

/** 对账回答：判定以当下简报为准（judge 结论盖回假设），附上创始人「还会这么选吗」的原话 */
async function reviewRows(raw: unknown, dataDir: string | undefined, now: Date) {
  const reviews = readReviews(listArg(raw, "reviews"));
  if (!reviews.length) return { rows: [] as MeetingRecord["reviews"], updates: [] as Hypothesis[] };
  const pending = (await buildMeetingBrief(dataDir, now)).pendingBets.bets;
  const all = await listHypotheses(dataDir);
  const rows: MeetingRecord["reviews"] = [];
  const updates: Hypothesis[] = [];
  for (const r of reviews) {
    const bet = pending.find((b) => b.hypothesisId === r.hypothesisId);
    const h = all.find((x) => x.id === r.hypothesisId);
    if (!bet || !h) throw new Error(`reviews 里的 ${r.hypothesisId} 不是上次会议的下注——先看 meeting_brief 的 pendingBets`);
    rows.push({ hypothesisId: r.hypothesisId, verdict: bet.verdict, wouldRepeat: r.wouldRepeat });
    const judged = bet.judge ? applyJudgement({ ...h, contentIds: bet.contentIds }, bet.judge, now.toISOString()) : h;
    updates.push({ ...judged, wouldRepeat: r.wouldRepeat });
  }
  return { rows, updates };
}

function expectedRevision(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isInteger(n) || n < 0) throw new Error("expected_revision 必须是读到的 revision（新会传 0）");
  return n;
}

/** 选题指针：新片单标上，上一版片单里被拿掉的清掉 */
async function syncTopicSlots(record: MeetingRecord, previous: MeetingRecord | null, dataDir?: string): Promise<string[]> {
  const failed: string[] = [];
  for (const s of record.slots) {
    const ok = await updateTopic(s.topicId, { meetingSlot: { meetingDate: record.date, slotId: s.slotId } }, dataDir).catch(() => null);
    if (!ok) failed.push(s.topicId);
  }
  const kept = new Set(record.slots.map((s) => s.topicId));
  for (const s of previous?.slots ?? []) {
    if (kept.has(s.topicId)) continue;
    const t = await getTopic(s.topicId, dataDir);
    if (t?.meetingSlot?.meetingDate === record.date) await updateTopic(s.topicId, { meetingSlot: undefined }, dataDir);
  }
  return failed;
}

/** 单题会只加不改：位不能空、选题不能已在当日片单上；revision 对不上交给 CAS 报 conflict */
function appendErrors(slots: MeetingSlot[], onDisk: MeetingRecord | null, expected: number): string[] {
  if (!slots.length) return ["append 至少要有一个新会议位"];
  if ((onDisk?.revision ?? 0) !== expected) return [];
  const existing = new Set((onDisk?.slots ?? []).map((s) => s.topicId));
  return slots.filter((s) => existing.has(s.topicId)).map((s) => `「${s.title}」已在 ${onDisk!.date} 片单上，不用再追加`);
}

function mergeAppend(onDisk: MeetingRecord | null, slots: MeetingSlot[], rejected: MeetingRecord["rejected"], reviews: MeetingRecord["reviews"], notes: { notes?: string }) {
  const prevNotes = onDisk?.notes ? [onDisk.notes] : [];
  const joined = [...prevNotes, ...(notes.notes ? [notes.notes] : [])].join("\n");
  return {
    slots: [...(onDisk?.slots ?? []), ...slots], rejected: [...(onDisk?.rejected ?? []), ...rejected],
    reviews: [...(onDisk?.reviews ?? []), ...reviews], ...(joined ? { notes: joined } : {}),
  };
}

export async function saveMeeting(args: SaveMeetingArgs, dataDir?: string, now = new Date()) {
  // 日期先过校验再碰任何路径或 id
  const today = args.date === undefined || args.date === "" ? shanghaiDate(now.toISOString()) : assertMeetingDate(args.date);
  const expected = expectedRevision(args.expected_revision);
  const append = args.append === true || args.append === "true";
  // 单题会追加到最近一场会（哪天开都一样），上一场片单因此继续有效；还没开过会才新建当天的记录
  const date = append ? (await latestMeetingDate(dataDir)) ?? today : today;
  const read = await readSlots(args.slots, date, dataDir);
  const errors = read.errors;
  const onDisk = await readMeeting(date, dataDir);
  const slots = stabilizeSlotIds(read.slots, onDisk, date).map((s) => (append ? { ...s, addedOn: today } : s));
  const rejected = readRejected(listArg(args.rejected, "rejected"));
  if (append) errors.push(...appendErrors(slots, onDisk, expected));
  if (errors.length) return { ok: false as const, error: errors.join("；"), next_action: "按错误逐条问创始人补齐后重新 meeting_save；什么都还没写入" };
  const reviews = await reviewRows(args.reviews, dataDir, now);
  const notes = typeof args.notes === "string" && args.notes.trim() ? { notes: args.notes.trim() } : {};
  const merged = append ? mergeAppend(onDisk, slots, rejected, reviews.rows, notes) : { date, slots, rejected, reviews: reviews.rows, ...notes };
  const { record, previous } = await saveMeetingCas({ ...merged, date }, expected, dataDir);
  const contents = await listContents(dataDir);
  const withdrawn = await withdrawnBets(previous, record.slots, dataDir);
  await appendHypotheses([...slots.map((s) => betOf(s, date, contents, now.toISOString())), ...withdrawn, ...reviews.updates], dataDir);
  const failedTopics = await syncTopicSlots(record, previous, dataDir);
  return {
    ok: failedTopics.length === 0, record,
    topicStatus: Object.fromEntries(slots.map((s) => [s.topicId, topicStatus(s.topicId, contents) ?? "未开工（选中≠开工，开写走 video-session 一条一个会话）"])),
    ...(failedTopics.length ? { error: `会议记录与下注已保存，但这些选题没标上本周片单：${failedTopics.join("、")}`, next_action: `带 expected_revision:${record.revision} 原样重存一次` } : {}),
  };
}

export async function getMeeting(date: string | undefined, dataDir?: string, now = new Date()) {
  const day = date ? assertMeetingDate(date) : shanghaiDate(now.toISOString());
  const record = await readMeeting(day, dataDir);
  // 单题会追加到最近一场会：给出它的日期和 revision，append 时 expected_revision 用这个
  const latestDate = await latestMeetingDate(dataDir);
  const latest = latestDate ? await readMeeting(latestDate, dataDir) : null;
  const latest_meeting = latest ? { date: latest.date, revision: latest.revision } : null;
  return record ? { ok: true as const, record, latest_meeting } : { ok: true as const, record: null, expected_revision: 0, latest_meeting, note: `${day} 还没开过会；新会 expected_revision 传 0；单题会（append）用 latest_meeting.revision，还没开过会就传 0` };
}
