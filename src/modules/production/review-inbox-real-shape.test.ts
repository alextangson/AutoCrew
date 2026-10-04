/**
 * 2a 真实资料库验收（:4322，2026-10-01）：62 件里大多是已发布稿的迁移残留。用同形状的合成夹具锁住：
 * 已发布稿只剩发布相关的事；§6.2 迁移出来的封面、正式文件夹以外的封面图不进列表；说法是人话。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { readProductionDoc, writeProductionDoc } from "../../storage/production-store.js";
import { executeContentSave } from "../../tools/content-save.js";
import { registeredVideo } from "../publish/review-gate/testkit.js";
import { founderDecision } from "./decisions.js";
import { readInbox } from "./inbox-read.js";
import { scopedId } from "./inbox.js";
import { cardPanel } from "./panel.js";
import { reconcileAll } from "./reconcile.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, type Env } from "./testkit.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const items = async (id?: string) => (await readInbox(env.dir, id ? { contentId: id } : {})).items;

/** 客户问的形状：已发布；05-cover/exports/vNNN/qa 下一堆缩略图与质检图，一部分还是旧对账收成 accepted 的 */
async function publishedWithLeftovers() {
  const r = await registeredVideo(env);
  expect(await founderDecision(r.id, "i_published", { platform: "douyin" }, env.dir)).toMatchObject({ ok: true, stage: "已发布" });
  for (let i = 0; i < 20; i++) await put(path.join(r.root, `05-cover/exports/v001/qa/3x4-${i}.png`), png(900, 1200, `qa-${i}`));
  for (let i = 0; i < 6; i++) await put(path.join(r.root, `05-cover/exports/v002/4x3-${i}.png`), png(1200, 900, `ex-${i}`));
  // 旧对账收成 accepted 的 exports 图（迁移前的样子）
  const d = (await readProductionDoc(r.id, env.dir))!;
  const legacy = d.facts.find((f) => f.kind === "cover")!;
  const stale = { ...legacy, id: "fact-legacy-x", path: "05-cover/exports/v001/qa/3x4-0.png", sha256: "f".repeat(64), source: "reconcile" as const };
  delete (d as { cover_schema?: 1 }).cover_schema;
  await writeProductionDoc(r.id, env.dir, { ...d, facts: [...d.facts, stale] }, d.revision);
  // 发布之后又导出了一版
  await put(path.join(env.chatcut, "AI又忘了怎么办-新版.mp4"), "post-publish");
  await put(path.join(env.chatcut, "AI又忘了怎么办-再一版.mp4"), "post-publish-2");
  await reconcileAll(env.dir);
  return r;
}

describe("已发布的稿：只剩发布相关的事", () => {
  it("客户问形状：已发布、exports 下几十张图、发布后又导出两版 → 列表里 0 件", async () => {
    const r = await publishedWithLeftovers();
    expect(await items(r.id)).toEqual([]);
  });

  it("已发布之后又交了一组封面 / 标了一版成片：也不出「挑一张」「看一遍」", async () => {
    const r = await registeredVideo(env);
    await founderDecision(r.id, "i_published", { platform: "douyin" }, env.dir);
    await record(env, { content_id: r.id, kind: "cover", paths: [await put(path.join(env.chatcut, "n1.png"), png(900, 1200, "n1")), await put(path.join(env.chatcut, "n2.png"), png(1200, 900, "n2"))], request_id: "late" });
    expect((await items(r.id)).filter((i) => i.type !== "publish_claim" && i.type !== "published_ask")).toEqual([]);
  });

  it("已发布的稿，另一个计划平台还没发：只出「发了吗」", async () => {
    const r = await registeredVideo(env);
    await put(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify({ final_video: { path: r.video }, platforms: [{ platform: "douyin" }, { platform: "bilibili" }] }));
    await founderDecision(r.id, "i_published", { platform: "douyin" }, env.dir);
    expect((await items(r.id)).map((i) => i.item_id)).toEqual([scopedId(r.id, "published:r1:bilibili")]);
  });
});

describe("制作中的稿：迁移残留只在卡片上收成一行", () => {
  it("正式封面文件夹以外的封面图不进列表；卡片「以前的封面文件 N 张」+「都不要」", async () => {
    const c = await videoContent(env, "制作中的稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "制作中的稿-原片.mov"), "raw"), request_id: "a" });
    const root = projectRoot(env, c.id);
    for (let i = 0; i < 4; i++) await put(path.join(root, `05-cover/exports/qa/${i}.png`), png(900, 1200, `s${i}`));
    await reconcileAll(env.dir);
    expect((await items(c.id)).filter((i) => i.type === "candidate" && i.detail.kind === "cover")).toEqual([]);
    expect(await cardPanel(c.id, env.dir)).toMatchObject({ stray_covers: { count: 4 } });
    expect(await founderDecision(c.id, "reject_stray_covers", {}, env.dir)).toMatchObject({ ok: true, rejected: 4 });
    expect((await cardPanel(c.id, env.dir)).stray_covers).toBeNull();
  });
});

describe("说法是人话（量词、原因、没有路径与开发者用词）", () => {
  it("每一件的标题、说明、详情文字：没有 /、版本目录名、05-cover、迁移、准入", async () => {
    const c = await videoContent(env, "人话检查");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "人话检查-原片.mov"), "raw"), request_id: "a" });
    await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "人话检查.mp4"), "cut"), request_id: "c", review: true });
    await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, "a.png"), png(900, 1200, "a")), await put(path.join(env.chatcut, "b.png"), png(1200, 900, "b"))], cover_text: "字", request_id: "g" });
    await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.outside, "外面.png"), png(900, 1200, "o")), request_id: "o" });
    await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.outside, "外面.mp4"), "oc"), request_id: "oc" });
    const f = await put(path.join(projectRoot(env, c.id), "04-edit/看看.png"), png(10, 10));
    await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "codex", action: "ask", content_id: c.id, request_id: "q", kind: "粗剪", question: "行吗", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }], attachments: [f] });
    await put(path.join(env.inbox, "IMG_0001.mov"), "unmatched");
    await reconcileAll(env.dir);
    const list = await items();
    expect(list.length).toBeGreaterThan(4);
    const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
    for (const i of list) {
      const texts = [i.title, i.summary, ...strings(i.detail)].filter((t) => !/^(fact|ask|cg|chk|slv|content)-|^[a-f0-9]{16,}$/.test(t));
      for (const t of texts) {
        expect(t, `${i.type}: ${t}`).not.toMatch(/\/|\bv\d{3}\b|05-cover|迁移|准入|原依据/);
      }
    }
    const covers = list.filter((i) => i.type === "candidate" && i.detail.kind === "cover");
    expect(covers.map((i) => i.summary)).toEqual(["找到一张封面，是这条的吗"]);
    expect(list.find((i) => i.type === "candidate" && i.detail.kind === "cut")!.summary).toBe("找到一段成片，是这条的吗");
    expect(covers[0].detail.reason).toBe("放在 AutoCrew 不会自动收的文件夹里，要你确认");
  });
});
