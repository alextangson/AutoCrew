/**
 * 待核 →「确认已公开」（复用旧看板的「已经发出去了」= markPublished → i_published 决定）→ 已发；旧看板同一结论。
 * 临时资料库里跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardData } from "../../desktop/board-data.js";
import { markPublished } from "../../desktop/board-actions.js";
import { registeredVideo, type Reg } from "../publish/review-gate/testkit.js";
import { importObservations, type Observation } from "../production/receipts.js";
import { mutateProduction } from "../production/service.js";
import { makeEnv, type Env } from "../production/testkit.js";
import { pipelineData } from "./pipeline-data.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { vi.useRealTimers(); await env.cleanup(); });

const observe = (r: Reg, o: Omit<Observation, "evidence">) =>
  mutateProduction(r.id, env.dir, (doc) => ({ value: importObservations(doc, [{ evidence: "测试", ...o }]), events: [] }));
const past = new Date(Date.now() - 48 * 3600_000).toISOString();

describe("待核 → 确认已公开", () => {
  it("发布计划只报应已公开：待核、卡在发布中；点确认已公开后变已发、可以全部发完；旧看板的平台标签同样已公开", async () => {
    const r = await registeredVideo(env);
    for (const p of ["douyin", "bilibili"]) await observe(r, { source: "plan", platform: p, pub_state: "overdue", published_at: past });
    const theme = async () => (await pipelineData(env.dir)).themes.find((t) => t.id === r.id)!;
    const before = await theme();
    expect(before.destinations.map((d) => [d.platform, d.state])).toEqual([["douyin", "待核"], ["bilibili", "待核"]]);
    expect(before.column).toBe("发布中");

    expect(await markPublished(r.id, "douyin", undefined, env.dir)).toMatchObject({ ok: true });
    const mid = await theme();
    expect(mid.destinations.map((d) => d.state)).toEqual(["已发", "待核"]);
    expect(mid.column).toBe("发布中");

    expect(await markPublished(r.id, "bilibili", undefined, env.dir)).toMatchObject({ ok: true });
    const after = await theme();
    expect(after.destinations.map((d) => d.state)).toEqual(["已发", "已发"]);
    expect(after.column).toBe("全部发完");
    const old = (await boardData(env.dir)).items.find((i) => i.id === r.id)!;
    expect(old.targets.map((t) => [t.platform, t.state])).toEqual([["douyin", "已公开"], ["bilibili", "已公开"]]);
    expect(old.column).toBe("已发布");
  });
  it("可信观察后来报了公开 / 被驳回照样盖过创始人之前的确认（只有应已公开让位）", async () => {
    const r = await registeredVideo(env);
    await observe(r, { source: "plan", platform: "douyin", pub_state: "overdue", published_at: past });
    await markPublished(r.id, "douyin", undefined, env.dir);
    await observe(r, { source: "plan", platform: "douyin", pub_state: "rejected", published_at: past, reason: "封面违规" });
    const t = (await pipelineData(env.dir)).themes.find((x) => x.id === r.id)!;
    expect(t.destinations[0]).toMatchObject({ platform: "douyin", state: "没发成" });
  });
});
