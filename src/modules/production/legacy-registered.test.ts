/**
 * 创始人 09-30：旧流程登记过（video.final.register_hash）的已发布稿不说「未登记就发布」，写「按旧流程登记」（中性）；
 * 登记之后本轮又出了另一版成片 → 「按旧流程登记；发布后成片换过版本」（提醒）。真没登记的照旧「未登记就发布」。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { getContent, updateContent } from "../../storage/local-store.js";
import { boardData } from "../../desktop/board-data.js";
import { itemMeta } from "../../../frontend/src/views/board-columns";
import { founderDecision } from "./decisions.js";
import { UNREGISTERED_PUBLISH } from "./derive.js";
import { LEGACY_REGISTERED, LEGACY_REGISTERED_RECUT } from "./explain.js";
import { cardPanel } from "./panel.js";
import { founderApprove, makeEnv, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const REG_AT = "2026-09-28T10:00:00.000Z";

async function publishedOldFlow(opts: { registered: boolean }) {
  const c = await videoContent(env, "深度思考");
  await founderApprove(env, c.id);
  if (opts.registered) {
    await updateContent(c.id, { video: { final: { path: "/x/final.mp4", asset_filename: "final.mp4", sha256: "a".repeat(64), duration_ms: 1000, register_hash: "reg1", at: REG_AT } } } as never, env.dir);
  }
  await founderDecision(c.id, "i_published", { platform: "xiaohongshu" }, env.dir);
  return c;
}

async function views(id: string) {
  const panel = await cardPanel(id, env.dir) as { stage: string; alerts: string[]; badges: string[] };
  const item = (await boardData(env.dir)).items.find((i) => i.id === id)!;
  return { panel, item };
}

describe("旧流程登记的已发布稿", () => {
  it("真没登记：照旧「未登记就发布」（卡片、面板）", async () => {
    const c = await publishedOldFlow({ registered: false });
    const { panel, item } = await views(c.id);
    expect(panel.stage).toBe("已发布");
    expect(panel.alerts).toContain(UNREGISTERED_PUBLISH);
    expect(item.alerts).toContain(UNREGISTERED_PUBLISH);
  });

  it("旧流程登记过、之后没换成片：面板中性说明「按旧流程登记」，卡片信息行也有，不标红", async () => {
    const c = await publishedOldFlow({ registered: true });
    const { panel, item } = await views(c.id);
    expect(panel.alerts).not.toContain(UNREGISTERED_PUBLISH);
    expect(panel.badges).toContain(LEGACY_REGISTERED);
    expect(item.alerts ?? []).toEqual(expect.not.arrayContaining([UNREGISTERED_PUBLISH, LEGACY_REGISTERED_RECUT]));
    expect(itemMeta(item as never, null)).toContain(LEGACY_REGISTERED);
  });

  it("旧流程登记过、发布后本轮又导出了另一版成片：提醒「按旧流程登记；发布后成片换过版本」（卡片、面板）", async () => {
    const c = await publishedOldFlow({ registered: true });
    await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "深度思考-配乐重做v008.mp4"), "recut-v8"), request_id: "v8" });
    expect((await getContent(c.id, env.dir))!.video?.final?.register_hash).toBe("reg1");
    const { panel, item } = await views(c.id);
    expect(panel.alerts).toContain(LEGACY_REGISTERED_RECUT);
    expect(panel.alerts).not.toContain(UNREGISTERED_PUBLISH);
    expect(item.alerts).toContain(LEGACY_REGISTERED_RECUT);
  });
});
