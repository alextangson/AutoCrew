/**
 * 去向计划落盘 / 改勾选不改老主题 / 标不出 / 重拍（管线重规划 §8-4、§8-6）。全部在临时资料库里跑，不碰真实资料库。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { mutateProduction } from "../production/service.js";
import { fact, SHA } from "../production/derive-fixtures.js";
import { founderApprove, makeEnv, videoContent, type Env } from "../production/testkit.js";
import { reshoot, setDestination } from "./actions.js";
import { readPlanFile } from "./plan.js";
import { pipelineData, themeIndex } from "./pipeline-data.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); await initProfile(env.dir); await updateProfile({ platforms: ["douyin", "bilibili", "wechat_mp"] }, env.dir); });
afterEach(async () => env.cleanup());

const NOW = new Date().toISOString();
async function approvedVideo(title: string) {
  const c = await videoContent(env, title);
  await founderApprove(env, c.id);
  return c;
}
const themeOf = async (id: string) => (await pipelineData(env.dir)).themes.find((t) => t.id === id)!;

describe("去向计划", () => {
  it("没落盘时按当前勾选给默认、读时不写；改勾选前老主题按改之前的勾选落盘，新主题按新勾选", async () => {
    const old = await approvedVideo("老主题");
    expect(await readPlanFile(old.id, env.dir)).toBeNull();
    expect((await themeOf(old.id)).plan).toMatchObject({ required: ["douyin", "bilibili", "wechat_mp"], persisted: false });
    expect(await readPlanFile(old.id, env.dir)).toBeNull();
    await updateProfile({ platforms: ["douyin", "youtube"] }, env.dir);
    expect(Object.keys((await readPlanFile(old.id, env.dir))!.destinations)).toEqual(["douyin", "bilibili", "wechat_mp"]);
    const fresh = await approvedVideo("新主题");
    expect((await themeOf(fresh.id)).plan.required).toEqual(["douyin", "youtube"]);
    // 再改一次勾选：老主题的计划不动
    await updateProfile({ platforms: ["xiaohongshu"] }, env.dir);
    expect((await themeOf(old.id)).plan.required).toEqual(["douyin", "bilibili", "wechat_mp"]);
    expect((await themeOf(fresh.id)).plan.required).toEqual(["douyin", "youtube"]);
  });
  it("标不出要原话，记谁定的；恢复要发也记原话；派生稿的 id 不收", async () => {
    const c = await approvedVideo("标不出");
    expect(await setDestination(c.id, "bilibili", true, "  ", { via: "board" }, env.dir)).toMatchObject({ ok: false, code: "founder_words_required" });
    expect(await setDestination(c.id, "tiktok", true, "不发", { via: "board" }, env.dir)).toMatchObject({ ok: false, code: "bad_platform" });
    expect(await setDestination(c.id, "bilibili", true, "B站这条不发", { via: "chat", host: "claude" }, env.dir)).toMatchObject({ ok: true, required: false });
    const t = await themeOf(c.id);
    expect(t.plan.required).toEqual(["douyin", "wechat_mp"]);
    expect(t.plan.skipped).toMatchObject([{ platform: "bilibili", founder_words: "B站这条不发", by: "对话里" }]);
    expect((await readPlanFile(c.id, env.dir))!.destinations.bilibili).toMatchObject({ by: "founder", via: "chat", host: "claude" });
    await setDestination(c.id, "bilibili", false, "还是发吧", { via: "board" }, env.dir);
    expect((await themeOf(c.id)).plan.required).toEqual(["douyin", "bilibili", "wechat_mp"]);
  });
});

describe("重拍", () => {
  it("仿 dovnpj：成片、封面都被打回「这条我觉得拍的不好 应该会重新拍」→ 重拍落到录制，新一轮沿用原稿认稿", async () => {
    const c = await approvedVideo("拍得不好的那条");
    await mutateProduction(c.id, env.dir, (d) => {
      d.facts.push(fact("cut", SHA.cut, { round: d.round, at: NOW }));
      d.decisions.push({ id: "dec-cut-reject", type: "cut_reject", round: d.round, at: NOW, source: "founder", sha256: SHA.cut, note: "这条我觉得拍的不好 应该会重新拍" });
      d.decisions.push({ id: "dec-cover-reject", type: "cover_reject", round: d.round, at: NOW, source: "founder", note: "这条我觉得拍的不好 应该会重新拍" });
      return { value: null, events: [] };
    });
    expect((await themeOf(c.id)).column).toBe("剪辑");
    expect(await reshoot(c.id, "", 1, { via: "board" }, env.dir)).toMatchObject({ ok: false, code: "founder_words_required" });
    const r = await reshoot(c.id, "这条我觉得拍的不好 应该会重新拍", 1, { via: "board" }, env.dir);
    expect(r).toMatchObject({ ok: true, round: 2, published: [], to_cancel: [] });
    const t = await themeOf(c.id);
    expect(t.column).toBe("录制");
    expect(t.reshoot).toMatchObject({ round_ended: 1, round: 2, founder_words: "这条我觉得拍的不好 应该会重新拍" });
    const doc = await readProductionDoc(c.id, env.dir);
    expect(doc!.decisions.filter((d) => d.round === 2 && d.type === "script_approval")).toHaveLength(1);
    // 双击 / 旧页面重放：不再结束新的一轮，不重复记
    expect(await reshoot(c.id, "这条我觉得拍的不好 应该会重新拍", 1, { via: "board" }, env.dir)).toMatchObject({ ok: true, round: 2 });
    expect((await readProductionDoc(c.id, env.dir))!.round).toBe(2);
    expect((await readPlanFile(c.id, env.dir))!.reshoots).toHaveLength(1);
    // 新一轮又有了素材 → 可以再重拍一次；同一轮重放仍然幂等
    await mutateProduction(c.id, env.dir, (d) => { d.facts.push(fact("cut", SHA.cut2, { round: d.round, at: NOW })); return { value: null, events: [] }; });
    expect((await themeOf(c.id)).column).toBe("剪辑");
    expect(await reshoot(c.id, "还是不行，再拍", 2, { via: "board" }, env.dir)).toMatchObject({ ok: true, round: 3 });
    expect(await reshoot(c.id, "还是不行，再拍", 2, { via: "board" }, env.dir)).toMatchObject({ ok: true, round: 3 });
    expect((await readPlanFile(c.id, env.dir))!.reshoots.map((x) => x.round_ended)).toEqual([1, 2]);
    expect((await themeOf(c.id)).column).toBe("录制");
  });
  it("已经发了一部分：已发的保留，已定时的列出来要你去撤，不自动撤", async () => {
    const c = await approvedVideo("发了一半要重拍");
    await mutateProduction(c.id, env.dir, (d) => {
      d.facts.push(fact("publish", undefined, { round: d.round, platform: "douyin", pub_state: "public", obs_source: "plan", verified: true, seen_at: NOW, evidence: "发布计划里的记录" }));
      d.facts.push(fact("publish", undefined, { round: d.round, platform: "bilibili", pub_state: "scheduled", obs_source: "plan", verified: true, seen_at: NOW, evidence: "发布计划里的记录" }));
      return { value: null, events: [] };
    });
    expect((await themeOf(c.id)).column).toBe("发布中");
    const r = await reshoot(c.id, "重拍", 1, { via: "chat", host: "claude" }, env.dir);
    expect(r).toMatchObject({ ok: true, published: [{ platform: "douyin" }], to_cancel: [{ platform: "bilibili" }] });
    const t = await themeOf(c.id);
    expect(t.column).toBe("录制");
    // 新一轮看不到上一轮的发布槽：抖音照样显示已发（上一轮），不给发布动作
    expect(t.destinations.find((d) => d.platform === "douyin")).toMatchObject({ state: "已发", detail: "已发 · 上一轮" });
  });
  it("还没开拍的不让重拍；轮次对不上的拒；派生稿 id 不收", async () => {
    const c = await approvedVideo("还没拍");
    expect(await reshoot(c.id, "重拍", 1, { via: "board" }, env.dir)).toMatchObject({ ok: false, code: "not_shot_yet" });
    expect(await reshoot(c.id, "重拍", 3, { via: "board" }, env.dir)).toMatchObject({ ok: false, code: "stale" });
  });
});

describe("要你做的按主题分组", () => {
  it("派生稿归到源视频的主题；父不在 = 自己", () => {
    const idx = themeIndex([
      { id: "v", title: "源视频" },
      { id: "w", title: "源视频（公众号）", derivedFrom: { contentId: "v", kind: "wechat_article", sourceCutHash: "h", at: "" } },
      { id: "o", title: "孤儿", derivedFrom: { contentId: "gone", kind: "en_edition", sourceCutHash: "h", at: "" } },
    ]);
    expect(idx.get("w")).toEqual({ id: "v", title: "源视频" });
    expect(idx.get("o")).toEqual({ id: "o", title: "孤儿" });
  });
});
