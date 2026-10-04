import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { listHypotheses } from "../retro/hypotheses.js";
import { executeInsights } from "../../tools/insights.js";
import { latestMeetingDate, readMeeting } from "./meeting-store.js";
import { renderMeetingMinutes } from "./meeting-render.js";
import { dropFixture, makeFixture, makeTopic, type Fixture } from "./meeting-fixture.test-helper.js";

let f: Fixture;
beforeEach(async () => { f = await makeFixture(); });
afterEach(async () => { await dropFixture(f); });

const slot = (topicId: string, over: Record<string, unknown> = {}) => ({
  topic_id: topicId, persona: { key: "core", name: "小林" }, payoff: "看完能判断自己该不该给团队买 AI 助手",
  format: "观点", why_now: "今天的热点", data_basis: "无数据依据，纯判断", bet: "D+3 播放高于抖音同龄中位数",
  watch: { platform: "douyin", metric: "views", day: 3 }, probability: 40, premortem: "热度过得太快", ...over,
});
const save = (date: string, meeting: Record<string, unknown>) =>
  executeInsights({ action: "meeting_save", date, meeting, _dataDir: f.data });
/** 当前片单 = 最近一场会议记录的 slots（排期会不拦写稿，这里只核片单本身） */
async function onSlate(topicId: string): Promise<boolean> {
  const date = await latestMeetingDate(f.data);
  return Boolean(date && (await readMeeting(date, f.data))?.slots.some((s) => s.topicId === topicId));
}

describe("排期会追加一条：meeting_save append", () => {
  it("同日追加一个位：当日原片单、原下注原样保留，新题进片单，只多一条下注", async () => {
    const [a, hot] = await Promise.all([makeTopic(f.data, "周会题"), makeTopic(f.data, "热点")]);
    await save("2026-10-04", { expected_revision: 0, slots: [slot(a.id)] });
    expect(await onSlate(hot.id)).toBe(false);
    const res = await save("2026-10-04", { expected_revision: 1, slots: [slot(hot.id)], append: true });
    expect(res).toMatchObject({ ok: true, record: { revision: 2, slots: [{ topicId: a.id, slotId: "s1" }, { topicId: hot.id, slotId: "s2" }] } });
    expect(await onSlate(hot.id)).toBe(true);
    expect(await onSlate(a.id)).toBe(true);
    const bets = await listHypotheses(f.data);
    expect(bets.map((h) => h.id).sort()).toEqual(["hyp-meeting-2026-10-04-s1", "hyp-meeting-2026-10-04-s2"]);
    expect(bets.every((h) => h.status === "open")).toBe(true);
  });

  it("周一 3 个位，周三单题会追加 → 4 条都在片单上；追加进最近那场会，纪要标出追加日期", async () => {
    const ts = await Promise.all(["A", "B", "C", "热点"].map((t) => makeTopic(f.data, t)));
    await save("2026-09-28", { expected_revision: 0, slots: ts.slice(0, 3).map((t) => slot(t.id)) });
    const res = await save("2026-09-30", { expected_revision: 1, slots: [slot(ts[3].id)], append: true });
    expect(res).toMatchObject({ ok: true, record: { date: "2026-09-28", revision: 2 } });
    expect(await fs.readdir(path.join(f.data, "meetings")).then((n) => n.filter((x) => x.endsWith(".json")))).toEqual(["2026-09-28.json"]);
    for (const t of ts) expect(await onSlate(t.id), t.title).toBe(true);
    const rec = (await readMeeting("2026-09-28", f.data))!;
    expect(rec.slots[3]).toMatchObject({ topicId: ts[3].id, addedOn: "2026-09-30", hypothesisId: "hyp-meeting-2026-09-28-s4" });
    expect(renderMeetingMinutes(rec)).toContain("热点（2026-09-30 单题会追加）");
    // 周四开整场新会、没选这些题 → 全部不在片单上
    const thu = await makeTopic(f.data, "周四题");
    await save("2026-10-01", { expected_revision: 0, slots: [slot(thu.id)] });
    for (const t of ts) expect(await onSlate(t.id), t.title).toBe(false);
    expect(await onSlate(thu.id)).toBe(true);
  });

  it("从没开过会时单题会新建一场只含这一条的会", async () => {
    const hot = await makeTopic(f.data, "热点");
    expect(await save("2026-10-04", { expected_revision: 0, slots: [slot(hot.id)], append: true })).toMatchObject({ ok: true, record: { date: "2026-10-04", revision: 1, slots: [{ topicId: hot.id }] } });
    expect(await onSlate(hot.id)).toBe(true);
  });

  it("跨天追加带旧 revision → conflict，不覆盖", async () => {
    const [a, hot] = await Promise.all([makeTopic(f.data, "周会题"), makeTopic(f.data, "热点")]);
    await save("2026-09-28", { expected_revision: 0, slots: [slot(a.id)] });
    expect(await save("2026-09-30", { expected_revision: 0, slots: [slot(hot.id)], append: true })).toMatchObject({ ok: false, conflict: true, current_revision: 1 });
    expect((await readMeeting("2026-09-28", f.data))?.slots.map((s) => s.topicId)).toEqual([a.id]);
  });

  it("append 也走 CAS：带旧 revision 报 conflict，不静默覆盖", async () => {
    const [a, hot] = await Promise.all([makeTopic(f.data, "周会题"), makeTopic(f.data, "热点")]);
    await save("2026-10-04", { expected_revision: 0, slots: [slot(a.id)] });
    const late = await save("2026-10-04", { expected_revision: 0, slots: [slot(hot.id)], append: true });
    expect(late).toMatchObject({ ok: false, conflict: true, current_revision: 1 });
    expect((await readMeeting("2026-10-04", f.data))?.slots.map((s) => s.topicId)).toEqual([a.id]);
    expect(await onSlate(hot.id)).toBe(false);
  });

  it("单题会照样要下注字段；空 append、重复追加都打回", async () => {
    const hot = await makeTopic(f.data, "热点");
    expect(await save("2026-10-04", { expected_revision: 0, slots: [slot(hot.id, { probability: undefined })], append: true })).toMatchObject({ ok: false, error: expect.stringContaining("probability") });
    expect(await save("2026-10-04", { expected_revision: 0, slots: [], append: true })).toMatchObject({ ok: false });
    expect(await save("2026-10-04", { expected_revision: 0, slots: [slot(hot.id)], append: true })).toMatchObject({ ok: true, record: { revision: 1 } });
    expect(await save("2026-10-04", { expected_revision: 1, slots: [slot(hot.id)], append: true })).toMatchObject({ ok: false, error: expect.stringContaining("已在") });
  });
});

