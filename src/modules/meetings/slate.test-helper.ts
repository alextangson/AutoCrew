/** 测试用：把选题直接写进一场会议的片单（绕开 meeting_save 的字段校验，只为让闸口放行） */
import { readMeeting, saveMeetingCas, type MeetingSlot } from "./meeting-store.js";

export const TEST_MEETING_DATE = "2026-01-05";

export async function putOnSlate(dataDir: string, topicIds: string | string[], date = TEST_MEETING_DATE): Promise<void> {
  const ids = Array.isArray(topicIds) ? topicIds : [topicIds];
  const prev = await readMeeting(date, dataDir);
  const slots = [...(prev?.slots ?? [])];
  for (const topicId of ids) {
    if (slots.some((s) => s.topicId === topicId)) continue;
    slots.push({ slotId: `s${slots.length + 1}`, topicId, title: topicId } as MeetingSlot);
  }
  await saveMeetingCas({ date, slots, rejected: prev?.rejected ?? [], reviews: prev?.reviews ?? [] }, prev?.revision ?? 0, dataDir);
}
