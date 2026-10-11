/**
 * AI 发布回执直接认（创始人 2026-10-11：「AI 发了还要我再确认一次」）：带本平台链接 / 报了定时的直接算已投出，
 * 定时过一天没核到公开再问一次；「发了吗」只在待发布满一天、这个平台什么都没收到时问。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../storage/local-store.js";
import { planEntry, planOf, registeredVideo, type Reg } from "../publish/review-gate/testkit.js";
import { founderDecision } from "./decisions.js";
import { readInbox } from "./inbox-read.js";
import { explainContent } from "./read.js";
import { importObservations, observationFact, slotOf, type Observation } from "./receipts.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { decideItem } from "./inbox-decide.js";
import { isWorkUrl } from "./chat-approval/post-publish-view.js";
import { mutateProduction } from "./service.js";
import { makeEnv, record, type Env } from "./testkit.js";
import { chatRevoke } from "./chat-approval/decide.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { vi.useRealTimers(); await env.cleanup(); });

const H = 3600_000;
const later = (hours: number) => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + hours * H });
const items = async (id: string) => (await readInbox(env.dir, { contentId: id, withDrafts: true })).items;
const ofType = async (id: string, type: string) => (await items(id)).filter((i) => i.type === type);
const stage = async (id: string) => (await explainContent((await getContent(id, env.dir))!, env.dir));
let rid = 0;
const claim = (r: Reg, extra: Record<string, unknown>) => record(env, { content_id: r.id, kind: "publish", request_id: `pub-${++rid}`, ...extra }, "codex");
async function planned(r: Reg, platforms: string[]) {
  await fs.mkdir(path.join(r.root, "06-publish"), { recursive: true });
  await fs.writeFile(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify(planOf(r, platforms.map((p) => planEntry(r, p, ["3:4", "4:3"])))));
}
const URLS: Record<string, string> = {
  douyin: "https://www.douyin.com/video/1", xiaohongshu: "https://www.xiaohongshu.com/explore/64a1b2c3d4e5f6a7b8c9d0e1",
  bilibili: "https://www.bilibili.com/video/BV1xx411c7mD",
};

describe("「发了吗」等满一天", () => {
  it("刚进待发布不问；过了一天，每个没有任何回执的计划平台问一次", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin", "bilibili"]);
    expect(await ofType(r.id, "published_ask")).toEqual([]);
    await claim(r, { platform: "douyin", item_id: "7001" });
    later(25);
    const asks = await ofType(r.id, "published_ask");
    expect(asks.map((i) => i.detail.platform)).toEqual(["bilibili"]);
    expect(asks[0].summary).toBe("待发布一天了，还没收到B站的发布回执：发了吗");
    expect(asks[0].actions[0].action).toBe("i_published");
    // 只是时间往后走，代次不变
    const gen = asks[0].gen;
    later(30);
    expect((await ofType(r.id, "published_ask"))[0].gen).toBe(gen);
  });
});

describe("直接认的 AI 回执", () => {
  it("四个平台都带本平台链接：已发布，没有任何发布条目，原因写明谁报的", async () => {
    const r = await registeredVideo(env);
    const ps = ["douyin", "xiaohongshu", "wechat_video", "bilibili"];
    await planned(r, ps);
    // 视频号没有可靠的作品链接形状，只能报定时直接认（Codex 审 P1）
    for (const p of ps) {
      const how = p === "wechat_video" ? { pub_state: "scheduled", scheduled_at: new Date(Date.now() + H).toISOString() } : { url: URLS[p], pub_state: "public" };
      expect(await claim(r, { platform: p, ...how })).toMatchObject({ ok: true, verified: true });
    }
    const exp = await stage(r.id);
    expect(exp.stage).toBe("已发布");
    expect(exp.reason).toContain("Codex 报已公开");
    later(20);
    expect((await items(r.id)).filter((i) => i.type === "publish_claim" || i.type === "published_ask")).toEqual([]);
  });

  it("报定时不带链接：已定时、不问；定时过一天没核到公开问一次；可信观察核到公开后那件没了", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin"]);
    const at = new Date(Date.now() + 2 * H).toISOString();
    expect(await claim(r, { platform: "douyin", pub_state: "scheduled", scheduled_at: at })).toMatchObject({ ok: true, verified: true });
    const exp = await stage(r.id);
    expect(exp.stage).toBe("已发布");
    expect(exp.reason).toContain("抖音 Codex 报已定时");
    expect(await ofType(r.id, "publish_claim")).toEqual([]);
    later(2 + 25);
    const follow = await ofType(r.id, "publish_claim");
    expect(follow).toHaveLength(1);
    expect(follow[0].summary).toBe("抖音定时时间已过一天，还没核到公开，发出去了吗");
    expect(follow[0].actions.map((a) => a.action)).toEqual(["confirm_receipt", "correct_publish"]);
    await mutateProduction(r.id, env.dir, (doc) => ({ value: importObservations(doc, [{ source: "metrics_id", platform: "douyin", item_id: "7001", pub_state: "public", evidence: "数据回流按作品 id 对上了这条" }]), events: [] }));
    expect(await ofType(r.id, "publish_claim")).toEqual([]);
  });

  it("没链接、状态公开（只给作品 id）：仍待核", async () => {
    const r = await registeredVideo(env);
    expect(await claim(r, { platform: "douyin", item_id: "7001", pub_state: "public" })).toMatchObject({ verified: false });
    expect((await ofType(r.id, "publish_claim")).map((i) => i.summary)).toEqual(["Codex说已经发了（抖音）"]);
    expect((await stage(r.id)).stage).toBe("待发布");
  });

  it("链接是别的平台的：仍待核", async () => {
    const r = await registeredVideo(env);
    expect(await claim(r, { platform: "douyin", url: URLS.bilibili, pub_state: "public" })).toMatchObject({ verified: false });
    expect(await ofType(r.id, "publish_claim")).toHaveLength(1);
  });

  it("创始人「没发」纠正直接认的槽：作废，之后的新回执照常算（看板与对话两条路）", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin", "bilibili"]);
    await claim(r, { platform: "douyin", url: URLS.douyin });
    await claim(r, { platform: "bilibili", url: URLS.bilibili });
    expect((await stage(r.id)).stage).toBe("已发布");
    later(1);
    expect(await founderDecision(r.id, "correct_publish", { target_id: "slot:1:douyin" }, env.dir)).toMatchObject({ ok: true });
    expect(await chatRevoke({ item_id: "", gen: "", decision: "", content_id: r.id, platform: "bilibili", founder_words: "B站其实没发", request_id: "unpub-1", host: "claude-code" }, env.dir)).toMatchObject({ ok: true });
    expect((await stage(r.id)).stage).toBe("待发布");
    later(26);
    expect((await ofType(r.id, "published_ask")).map((i) => i.detail.platform).sort()).toEqual(["bilibili", "douyin"]);
    await claim(r, { platform: "douyin", item_id: "7002" });
    expect((await ofType(r.id, "publish_claim")).map((i) => i.detail.platform)).toEqual(["douyin"]);
    await claim(r, { platform: "douyin", url: "https://www.douyin.com/video/2" });
    expect(await ofType(r.id, "publish_claim")).toEqual([]);
  });

  it("没有有效发布前检查：直接认的回执照样标「发布前未把关」", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin"]);
    await claim(r, { platform: "douyin", url: URLS.douyin });
    expect((await stage(r.id)).alerts).toContain("1 个平台发布前未把关");
  });

  it("数据回流按标题猜的仍待核", async () => {
    const r = await registeredVideo(env);
    await mutateProduction(r.id, env.dir, (doc) => ({ value: importObservations(doc, [{ source: "metrics_title", platform: "douyin", item_id: "9", pub_state: "public", evidence: "数据回流按标题猜是这条" }]), events: [] }));
    expect((await ofType(r.id, "publish_claim")).map((i) => i.summary)).toEqual(["数据回流说已经发了（抖音）"]);
    expect((await stage(r.id)).stage).toBe("待发布");
  });
});

const observe = (r: Reg, o: Omit<Observation, "evidence">) =>
  mutateProduction(r.id, env.dir, (doc) => ({ value: importObservations(doc, [{ evidence: "测试", ...o }]), events: [] }));

describe("Codex 审 a22bb235", () => {
  it("P1 主页 / 上传页 / 登录页 / 创作者中心不算作品链接：仍待核", async () => {
    for (const u of ["https://www.douyin.com/", "https://creator.douyin.com/creator-micro/content/upload", "https://www.douyin.com/user/self", "https://www.xiaohongshu.com/login"]) {
      expect(isWorkUrl(u.includes("xiaohongshu") ? "xiaohongshu" : "douyin", u)).toBe(false);
    }
    expect(isWorkUrl("bilibili", "https://member.bilibili.com/platform/upload/video/frame")).toBe(false);
    expect(isWorkUrl("wechat_video", "https://channels.weixin.qq.com/platform/post/list")).toBe(false);
    expect(isWorkUrl("douyin", "https://v.douyin.com/iRNBho6u/")).toBe(true);
    expect(isWorkUrl("bilibili", "https://b23.tv/abc123")).toBe(true);
    expect(isWorkUrl("xiaohongshu", "https://www.xiaohongshu.com/discovery/item/64a1b2c3d4e5f6a7b8c9d0e1")).toBe(true);
    const r = await registeredVideo(env);
    expect(await claim(r, { platform: "douyin", url: "https://creator.douyin.com/creator-micro/content/upload", pub_state: "public" })).toMatchObject({ verified: false });
    expect((await stage(r.id)).stage).toBe("待发布");
  });

  it("P1 发布计划也写了定时、后来变成应已公开：追问照样出；计划报公开才清", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin"]);
    const at = new Date(Date.now() + H).toISOString();
    await claim(r, { platform: "douyin", pub_state: "scheduled", scheduled_at: at });
    await observe(r, { source: "plan", platform: "douyin", pub_state: "scheduled", published_at: at });
    later(1 + 25);
    await observe(r, { source: "plan", platform: "douyin", pub_state: "overdue", published_at: at });
    expect((await ofType(r.id, "publish_claim")).map((i) => i.summary)).toEqual(["抖音定时时间已过一天，还没核到公开，发出去了吗"]);
    await observe(r, { source: "plan", platform: "douyin", pub_state: "public", published_at: at });
    expect(await ofType(r.id, "publish_claim")).toEqual([]);
  });

  it("P2 本次之前写下、没盖把关结论的 AI 回执读出来不升级：仍待核", async () => {
    const r = await registeredVideo(env);
    await mutateProduction(r.id, env.dir, (doc) => {
      doc.facts.push(observationFact(doc, { source: "claim", platform: "douyin", url: URLS.douyin, pub_state: "reviewing", evidence: "codex 说已发布", by: { host: "codex" } }, doc.round));
      return { value: null, events: [] };
    });
    expect((await ofType(r.id, "publish_claim")).map((i) => i.detail.platform)).toEqual(["douyin"]);
    expect((await stage(r.id)).stage).toBe("待发布");
  });

  it("P2 定时追问答「对，发了」记成已公开；之后可信数据照样能更新这个槽", async () => {
    const r = await registeredVideo(env);
    await planned(r, ["douyin"]);
    await claim(r, { platform: "douyin", pub_state: "scheduled", scheduled_at: new Date(Date.now() + H).toISOString() });
    later(26);
    const [it0] = await ofType(r.id, "publish_claim");
    expect(await decideItem({ content_id: r.id, item_id: it0.item_id, gen: it0.gen, action: "confirm_receipt", ...it0.actions[0].params }, env.dir)).toMatchObject({ ok: true });
    let slot = slotOf((await readProductionDoc(r.id, env.dir))!, 1, "douyin")!;
    expect(slot).toMatchObject({ by: "founder", pub_state: "public" });
    expect(await ofType(r.id, "publish_claim")).toEqual([]);
    await observe(r, { source: "metrics_id", platform: "douyin", item_id: "7009", pub_state: "public" });
    slot = slotOf((await readProductionDoc(r.id, env.dir))!, 1, "douyin")!;
    expect(slot).toMatchObject({ by: "trusted", source: "metrics_id" });
  });
});
