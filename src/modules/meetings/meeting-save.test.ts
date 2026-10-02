import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getTopic, updateTopic } from "../../storage/local-store.js";
import { listHypotheses } from "../retro/hypotheses.js";
import { executeInsights } from "../../tools/insights.js";
import { readMeeting, saveMeetingCas } from "./meeting-store.js";
import { renderMeetingMinutes } from "./meeting-render.js";
import { dropFixture, makeContent, makeFixture, makeTopic, type Fixture } from "./meeting-fixture.test-helper.js";

let f: Fixture;
beforeEach(async () => { f = await makeFixture(); });
afterEach(async () => { await dropFixture(f); });

const slot = (topicId: string, over: Record<string, unknown> = {}) => ({
  topic_id: topicId, persona: { key: "core", name: "小林" }, payoff: "看完能判断自己该不该给团队买 AI 助手",
  format: "观点", why_now: "上周爆款的续集", data_basis: "无数据依据，纯判断", bet: "D+7 播放高于抖音同龄中位数",
  watch: { platform: "douyin", metric: "views", day: 7 }, probability: 55, premortem: "开头太慢", ...over,
});
const save = (meeting: Record<string, unknown>) =>
  executeInsights({ action: "meeting_save", date: "2026-10-02", meeting, _dataDir: f.data });

describe("meeting_save 落库", () => {
  it("片单落成会议记录 + 假设新行 + 选题会议位；数组以 JSON 字符串到达也照收", async () => {
    const t = await makeTopic(f.data, "AI 助手值不值");
    const res = await save({ expected_revision: "0", slots: JSON.stringify([slot(t.id)]), rejected: '[{"title":"凑数题","reason":"没新东西"}]' });
    expect(res).toMatchObject({ ok: true, record: { revision: 1, slots: [{ slotId: "s1", hypothesisId: "hyp-meeting-2026-10-02-s1", title: "AI 助手值不值" }] } });
    expect((await getTopic(t.id, f.data))?.meetingSlot).toEqual({ meetingDate: "2026-10-02", slotId: "s1" });
    const [h] = await listHypotheses(f.data);
    expect(h).toMatchObject({ topicId: t.id, meetingDate: "2026-10-02", slotId: "s1", probability: 55, premortem: "开头太慢", watchDay: 7, metricFocus: "views", scope: { platform: "douyin" } });
    const md = renderMeetingMinutes((await readMeeting("2026-10-02", f.data))!);
    expect(md).toContain("凑数题：没新东西");
    expect(md).toContain("概率 55%");
  });

  it("一个都不选也照样落记录（边界 5）", async () => {
    const res = await save({ expected_revision: 0, slots: [], rejected: [{ title: "A", reason: "太泛" }] });
    expect(res).toMatchObject({ ok: true, record: { slots: [], rejected: [{ title: "A", reason: "太泛" }] } });
  });

  it("同日两个会话：后写者带旧 revision 报冲突，不覆盖（边界 11）", async () => {
    const t = await makeTopic(f.data, "题");
    expect(await save({ expected_revision: 0, slots: [slot(t.id)] })).toMatchObject({ ok: true });
    const late = await save({ expected_revision: 0, slots: [] });
    expect(late).toMatchObject({ ok: false, conflict: true, current_revision: 1 });
    expect((await readMeeting("2026-10-02", f.data))?.slots).toHaveLength(1);
    await expect(Promise.all([
      saveMeetingCas({ date: "2026-10-03", slots: [], rejected: [], reviews: [] }, 0, f.data),
      saveMeetingCas({ date: "2026-10-03", slots: [], rejected: [], reviews: [] }, 0, f.data),
    ])).rejects.toThrow(/revision/);
  });

  it("回归 P2a：[A,B] 重存成 [B]：B 保住原位号，A 的下注撤回，对账只剩 B", async () => {
    const [a, b] = await Promise.all([makeTopic(f.data, "A"), makeTopic(f.data, "B")]);
    await save({ expected_revision: 0, slots: [slot(a.id), slot(b.id)] });
    const res = await save({ expected_revision: 1, slots: [slot(b.id)] });
    expect(res).toMatchObject({ ok: true, record: { slots: [{ topicId: b.id, slotId: "s2", hypothesisId: "hyp-meeting-2026-10-02-s2" }] } });
    const byId = Object.fromEntries((await listHypotheses(f.data)).map((h) => [h.id, h]));
    expect(byId["hyp-meeting-2026-10-02-s1"]).toMatchObject({ topicId: a.id, status: "withdrawn" });
    expect(byId["hyp-meeting-2026-10-02-s2"]).toMatchObject({ topicId: b.id, status: "open" });
    const { buildMeetingBrief } = await import("./meeting-brief.js");
    const pending = (await buildMeetingBrief(f.data, new Date("2026-10-09T04:00:00Z"))).pendingBets.bets;
    expect(pending.map((p) => p.hypothesisId)).toEqual(["hyp-meeting-2026-10-02-s2"]);
  });

  it("回归 P2c：不合法的日期在碰任何路径之前就被拒", async () => {
    const res = await executeInsights({ action: "meeting_save", date: "/../../x", meeting: { expected_revision: 0, slots: [] }, _dataDir: f.data });
    expect(res).toMatchObject({ ok: false });
    expect(String(res.error)).toContain("YYYY-MM-DD");
    expect(await fs.readdir(f.data)).not.toContain("meetings");
    await expect(saveMeetingCas({ date: "../escape", slots: [], rejected: [], reviews: [] }, 0, f.data)).rejects.toThrow(/YYYY-MM-DD/);
    expect(await fs.readdir(f.data)).not.toContain("meetings");
  });

  it("同日重存把拿掉的题清出片单", async () => {
    const [a, b] = await Promise.all([makeTopic(f.data, "A"), makeTopic(f.data, "B")]);
    await save({ expected_revision: 0, slots: [slot(a.id), slot(b.id, { slot_id: "s2" })] });
    expect(await save({ expected_revision: 1, slots: [slot(a.id)] })).toMatchObject({ ok: true });
    expect((await getTopic(b.id, f.data))?.meetingSlot).toBeUndefined();
    expect((await getTopic(a.id, f.data))?.meetingSlot).toBeDefined();
  });

  it("空话收获、不在可回流表的指标、D+1、缺概率都拒收，且什么都不写", async () => {
    const t = await makeTopic(f.data, "题");
    const res = await save({ expected_revision: 0, slots: [slot(t.id, {
      payoff: "用一个历史类比看懂 FDE 热潮的局限", watch: { platform: "douyin", metric: "follows", day: 1 }, probability: undefined,
    })] });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/看懂 X/);
    expect(String(res.error)).toMatch(/follows」不在 douyin 可回流表/);
    expect(String(res.error)).toMatch(/day 只能是 3 或 7/);
    expect(String(res.error)).toMatch(/probability/);
    expect(await readMeeting("2026-10-02", f.data)).toBeNull();
    expect(await listHypotheses(f.data)).toEqual([]);
  });

  it("已在写/被认领的题：只标记并报状态，不建稿（边界 6）", async () => {
    const t = await makeTopic(f.data, "在写的题");
    const c = await makeContent(f.data, "在写的稿", { topicId: t.id }, "drafting");
    const res = await save({ expected_revision: 0, slots: [slot(t.id)] });
    expect(res.ok).toBe(true);
    expect((res.topicStatus as Record<string, string>)[t.id]).toContain(`${c.id}（drafting`);
    const [h] = await listHypotheses(f.data);
    expect(h.contentIds).toEqual([c.id]);
  });

  it("已有选中角度：先问重跑还是接受偏离，给了决定才收（边界 7）", async () => {
    const t = await makeTopic(f.data, "有角度的题");
    await updateTopic(t.id, { selectedAngle: { angleId: "angle-1" } as never }, f.data);
    const first = await save({ expected_revision: 0, slots: [slot(t.id)] });
    expect(first.ok).toBe(false);
    expect(String(first.error)).toContain("重跑立意");
    const second = await save({ expected_revision: 0, slots: [slot(t.id, { angle_decision: "accept_deviation" })] });
    expect(second).toMatchObject({ ok: true, record: { slots: [{ angleDecision: "accept_deviation" }] } });
  });

  it("会议目录在资料库迁移清单里", async () => {
    const src = await fs.readFile(path.join(process.cwd(), "src/storage/library-manager.ts"), "utf8");
    expect(src).toMatch(/DATA_DIRS = new Set\(\[[\s\S]*"meetings"/);
  });
});
