import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeEnv, setContent, videoContent, type Env } from "../production/testkit.js";
import { explainContent } from "../production/read.js";
import { writePublishState, type ArticlePublishState } from "./publish-state.js";
import { articleBoardStage } from "./board-stage.js";

const NOW = new Date("2026-10-25T12:00:00+08:00");
const state = (phase: ArticlePublishState["phase"], scheduledAt: string, published: boolean): ArticlePublishState =>
  ({ phase, receipt: { scheduledAt, founderWords: "扫了", published, at: NOW.toISOString() }, superseded: [], attempts: [] });

describe("公众号文章的看板列跟它自己的发布状态走", () => {
  it("record_scheduled published:true → 已发布", () => {
    expect(articleBoardStage(state("published", "2026-10-24T21:00:00+08:00", true), NOW)).toMatchObject({ column: "已发布", badge: "公众号 已发表" });
  });
  it("定时还没到 → 待发布，原因说定时时间；过了点没核到 → 待发布，原因说要核", () => {
    expect(articleBoardStage(state("scheduled", "2026-10-26T21:00:00+08:00", false), NOW)).toMatchObject({ column: "待发布", reason: expect.stringContaining("已定时 10-26 21:00") });
    expect(articleBoardStage(state("scheduled", "2026-10-24T21:00:00+08:00", false), NOW)).toMatchObject({ column: "待发布", reason: expect.stringContaining("已过，还没核到已发表") });
  });
  it("推送失败 / 结果不明照实标出来", () => {
    const failed = articleBoardStage({ phase: "failed", superseded: [], attempts: [{ at: NOW.toISOString(), action: "push_draft", ok: false, raw: "IP 不在白名单\n更多" }] }, NOW);
    expect(failed).toMatchObject({ column: "待发布", badge: "公众号 没发成", reason: expect.stringContaining("IP 不在白名单") });
    expect(articleBoardStage({ phase: "unknown", superseded: [], attempts: [] }, NOW)).toMatchObject({ badge: "公众号 结果不明" });
  });
  it("还没定时 / 只推了草稿 → 不改列", () => {
    expect(articleBoardStage({ phase: "pushed_draft", superseded: [], attempts: [] }, NOW)).toBeNull();
    expect(articleBoardStage({ superseded: [], attempts: [] }, NOW)).toBeNull();
  });
});

describe("explainContent 读公众号发布状态", () => {
  let env: Env;
  beforeEach(async () => { env = await makeEnv(); });
  afterEach(async () => { await env.cleanup(); });

  it("认过稿的公众号文章：发表了上已发布，没记过就留待发布", async () => {
    const c = await videoContent(env, "公众号长文", "approved");
    await setContent(env, c.id, { platform: "wechat_mp" });
    const art = { ...c, platform: "wechat_mp" as const };
    expect((await explainContent(art, env.dir)).column).toBe("待发布");
    await writePublishState(c.id, state("published", "2026-10-24T21:00:00+08:00", true), env.dir);
    const e = await explainContent(art, env.dir);
    expect(e.column).toBe("已发布");
    expect(e.badges).toContain("公众号 已发表");
    expect(e.published_at).toBe("2026-10-24T21:00:00+08:00");
  });

  it("视频稿不读公众号状态", async () => {
    const c = await videoContent(env, "视频", "approved");
    await writePublishState(c.id, state("published", "2026-10-24T21:00:00+08:00", true), env.dir);
    expect((await explainContent(c, env.dir)).column).not.toBe("已发布");
  });
});
