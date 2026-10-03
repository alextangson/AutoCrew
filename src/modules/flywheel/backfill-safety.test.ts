/**
 * 回填安全性（Codex 评审 2026-10-03：4 个 P1 + 5 个 P2）的回归测试。每条对应一个评审项。
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindWorkManually, createHistoryRecord, deleteHistoryRecord } from "./work-binding.js";
import { appendOutcomes, listOutcomes } from "./outcome-store.js";
import { importPerformanceRows } from "./row-import.js";
import { commitBindings } from "./platform-items.js";
import type { PerformanceOutcome } from "./outcome-schema.js";
import { saveContent, updateContent, getContent, listContents } from "../../storage/local-store.js";
import { executeContentSave } from "../../tools/content-save.js";
import { executeInsights } from "../../tools/insights.js";
import { trustedObservations } from "../production/receipts.js";
import { reconcileAll, reconcileContent } from "../production/reconcile.js";
import { readInbox } from "../production/inbox-read.js";
import { makeEnv, type Env } from "../production/testkit.js";
import { planBackfill } from "../../../scripts/backfill-bindings-20261003.mjs";

const DY = "7686140658221976866";
const SPH = "export/abc";
const PUB = "2026-09-16T14:31:37.000Z";

let tmp: string | null = null;
let env: Env | null = null;
async function plainDir(): Promise<string> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-backfill-safety-"));
  return tmp;
}
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  if (env) await env.cleanup();
  tmp = null; env = null;
});

const row = (over: Partial<PerformanceOutcome> = {}): PerformanceOutcome => ({
  contentId: null, platform: "wechat_video", platformTitle: "视频号标题", publishedAt: PUB, metricDate: "2026-10-03",
  platformItemId: SPH, metrics: { views: 100 }, source: "auto", recordedAt: "2026-10-03T08:00:00.000Z", needsReview: false, reviewReasons: [], ...over,
});

async function history(dir: string, items = [{ platform: "wechat_video", item_id: SPH }]) {
  const r = await createHistoryRecord({ title: "AI给自己造了个身体", published_date: "2026-09-16", items }, dir);
  if (!r.ok) throw new Error(r.error);
  return r.contentId;
}

describe("P1-1 本体启用时，对账 / 投影 / 收件箱都不碰历史记录", () => {
  it("reconcileAll + reconcileContent 后仍是已发布，「等你拍板」里没有它", async () => {
    env = await makeEnv({ enabled: true });
    const id = await history(env.dir, [{ platform: "douyin", item_id: DY }]);
    await reconcileAll(env.dir, { write: true });
    await reconcileContent(id, env.dir);
    expect((await getContent(id, env.dir))?.status).toBe("published");
    expect((await readInbox(env.dir)).items.filter((i) => (i as { content_id?: string }).content_id === id)).toEqual([]);
    expect((await readInbox(env.dir, { contentId: id })).items).toEqual([]);
  });
});

describe("P1-2 删历史记录不丢绑定之后才入账的快照", () => {
  it("绑定后入账的新快照，删记录后以未归属形态留在 listOutcomes", async () => {
    const dir = await plainDir();
    const id = await history(dir);
    await importPerformanceRows("wechat_video", [{ title: "视频号标题", publishedAt: PUB, platformItemId: SPH, metrics: { views: 555 } }], { source: "auto", metricDate: "2026-10-04", dataDir: dir });
    expect((await listOutcomes(dir)).map((o) => o.contentId)).toEqual([id]);
    await deleteHistoryRecord(id, dir);
    const visible = await listOutcomes(dir);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ contentId: null, metricDate: "2026-10-04", metrics: { views: 555 } });
  });
});

describe("P1-3 回填脚本：同日同题多条一律停；09-16 抖音只认公开重发那条", () => {
  async function seed(dir: string, douyinRows: PerformanceOutcome[]) {
    await appendOutcomes(douyinRows, dir);
  }
  it("09-16 抖音私密 10:00 + 公开 22:31 两条：计划只挂 22:31 那条，不报歧义", async () => {
    const dir = await plainDir();
    const title = "AI给自己造了个身体，接管了我家的全屋智能";
    await seed(dir, [
      row({ platform: "douyin", platformTitle: title, publishedAt: "2026-09-16T10:00:00.000Z", platformItemId: "7685292405297286406", metrics: { views: 0 } }),
      row({ platform: "douyin", platformTitle: title, publishedAt: "2026-09-16T14:31:37.000Z", platformItemId: DY, metrics: { views: 7629 } }),
    ]);
    const plan = await planBackfill(dir);
    const h = plan.history.find((x) => x.date === "2026-09-16")!;
    expect(h.items.filter((i) => i.spec.platform === "douyin").map((i) => i.itemId)).toEqual([DY]);
    expect(plan.problems.filter((x) => x.startsWith("douyin 2026-09-16"))).toEqual([]);
  });
  it("别的表项命中多条 → 报歧义，不猜", async () => {
    const dir = await plainDir();
    const title = "刚付Typeless年费，腾讯出了免费版";
    await seed(dir, [
      row({ platform: "douyin", platformTitle: title, publishedAt: "2026-09-26T10:00:00.000Z", platformItemId: "7689126573382847787" }),
      row({ platform: "douyin", platformTitle: title, publishedAt: "2026-09-26T11:00:00.000Z", platformItemId: "7689126573382847788" }),
    ]);
    const problems = (await planBackfill(dir)).problems.filter((x) => x.startsWith("douyin 2026-09-26"));
    expect(problems).toEqual([expect.stringContaining("命中多条")]);
  });
});

describe("P1-4 绑定表读不出时，人工写入与回填计划都停下", () => {
  it("坏 JSON：work_bind 拒绝且不覆盖文件；planBackfill 报错", async () => {
    const dir = await plainDir();
    const c = await saveContent({ title: "稿", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    await fs.writeFile(path.join(dir, "platform-items.json"), "{oops");
    const r = await bindWorkManually(c.id, "wechat_video", SPH, dir);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("platform-items.json") });
    expect(await fs.readFile(path.join(dir, "platform-items.json"), "utf8")).toBe("{oops");
    await expect(planBackfill(dir)).rejects.toThrow("platform-items.json");
  });
  it("版本不认也一样", async () => {
    const dir = await plainDir();
    const c = await saveContent({ title: "稿", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    await fs.writeFile(path.join(dir, "platform-items.json"), JSON.stringify({ schemaVersion: 99, items: {} }));
    expect(await bindWorkManually(c.id, "wechat_video", SPH, dir)).toMatchObject({ ok: false });
  });
});

describe("P2-1 改绑后不双计", () => {
  it("快照原本模糊归到 A，人工绑到 B 后只剩 B 的那份", async () => {
    const dir = await plainDir();
    const a = await saveContent({ title: "A", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    const b = await saveContent({ title: "B", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    await appendOutcomes([row({ contentId: a.id })], dir);
    expect(await bindWorkManually(b.id, "wechat_video", SPH, dir)).toMatchObject({ ok: true });
    expect((await listOutcomes(dir)).map((o) => o.contentId)).toEqual([b.id]);
  });
});

describe("P2-2 autocrew_content 的写动作不受理历史记录", () => {
  it("update / record publish / delete 都拒绝；删除只走 history_delete", async () => {
    const dir = await plainDir();
    const id = await history(dir);
    for (const p of [
      { action: "update", id, body: "正文" },
      { action: "record", content_id: id, kind: "publish", platform: "douyin" },
      { action: "delete", id },
    ]) {
      expect(await executeContentSave({ _dataDir: dir, ...p })).toMatchObject({ ok: false, error: expect.stringContaining("imported_history") });
    }
    expect((await getContent(id, dir))?.body).toBe("");
    expect((await getContent(id, dir))?.deletedAt).toBeFalsy();
  });
});

describe("P2-3 人工绑定在发布回执里算按 id 对上", () => {
  it("via=manual → metrics_id", async () => {
    const dir = await plainDir();
    const c = await saveContent({ title: "稿", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    await commitBindings([{ platform: "douyin", itemId: DY, contentId: c.id, via: "manual" }], dir);
    const obs = await trustedObservations(c, dir);
    expect(obs.find((o) => o.item_id === DY)?.source).toBe("metrics_id");
  });
});

describe("P2-4 并发建同一条历史记录不留孤儿", () => {
  it("两个同样的 history_create 同时跑 → 只有一条记录", async () => {
    const dir = await plainDir();
    const input = { title: "开源的agent新媒体团队", published_date: "2026-09-29", items: [{ platform: "wechat_video", item_id: SPH }] };
    const [x, y] = await Promise.all([createHistoryRecord(input, dir), createHistoryRecord(input, dir)]);
    expect(x.ok && y.ok).toBe(true);
    expect((await listContents(dir)).filter((c) => c.source === "imported_history")).toHaveLength(1);
  });
});

describe("P2-5 多步写入中途失败时如实报已写了什么", () => {
  it("绑定已落盘、补归属读账本失败 → 说清绑定已写入与怎么恢复，不说「没有写入」", async () => {
    const dir = await plainDir();
    const c = await saveContent({ title: "稿", body: "b", platform: "douyin", status: "published", tags: [] }, dir);
    await updateContent(c.id, {}, dir);
    await fs.mkdir(path.join(dir, "outcomes.jsonl")); // 读账本必失败
    const r = await executeInsights({ action: "work_bind", work: { content_id: c.id, platform: "wechat_video", item_id: SPH }, _dataDir: dir }) as Record<string, unknown>;
    expect(r.ok).toBe(false);
    expect(String(r.next_action)).not.toContain("都没有写入");
    expect(r).toMatchObject({ partial: true, written: [expect.stringContaining(`wechat_video:${SPH}`)] });
    expect(String(r.next_action)).toContain("重跑");
  });
});
