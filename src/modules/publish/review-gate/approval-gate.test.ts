/**
 * 批准 / 登记 / 文件身份类拦截不能破例（发布链路诊断 2026-10-15 第一步）：check 与出包同一结论。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../../storage/local-store.js";
import { readProductionDoc } from "../../../storage/production-store.js";
import { executePublish } from "../../../tools/publish.js";
import { executePrePublishTool } from "../../../tools/pre-publish.js";
import { founderDecision } from "../../production/decisions.js";
import { decideItem } from "../../production/inbox-decide.js";
import { readInbox } from "../../production/inbox-read.js";
import { registeredPackage } from "../../production/publish-gate.js";
import { reopenScript } from "../../production/reopen.js";
import { founderApprove, makeEnv, png, put, record, videoContent, waiveSliverCheck, type Env } from "../../production/testkit.js";
import { contentRoot } from "../../../storage/content-project.js";
import { executePublishCheck } from "./check.js";
import { readCheckRecord, writeCheckRecord } from "./check-store.js";
import { fakeJev, planEntry, planOf, registeredVideo, type Reg } from "./testkit.js";
import type { CheckItem } from "./types.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const PLAN = "06-publish/publish-plan.json";
type PlatformOut = { platform: string; check_id: string; verdict: string; items: CheckItem[] };
type CheckOut = { next_action: string; platforms: PlatformOut[] };
const writePlan = (root: string, plan: unknown) => put(path.join(root, PLAN), JSON.stringify(plan));
async function check(id: string, extra: Record<string, unknown> = {}) {
  const res = await executePublishCheck({ _dataDir: env.dir, content_id: id, plan: PLAN, ...extra }, { jev: fakeJev().caller }) as unknown as CheckOut;
  return { res, douyin: res.platforms.find((p) => p.platform === "douyin")! };
}
type PrepOut = { ok: boolean; code?: string; refused?: Array<{ code: string }>; data?: { packages: Array<{ videoPath: string }> } };
const prepare = (id: string, checkIds: string[]) => executePublish({ _dataDir: env.dir, action: "ego_lite_prepare", content_id: id, check_ids: checkIds }) as Promise<PrepOut>;
const blocksOf = (p: PlatformOut, rule: string) => p.items.filter((i) => i.result === "block" && i.rule === rule);
const override = (rule: string) => ({ founder_quotes: ["这次破例"], overrides: [{ platform: "douyin", rule, founder_quote: "这次破例" }] });

/** 没批完的视频稿：成片 / 封面文件在项目里，计划指着它们 */
async function unapproved(approveScript: boolean) {
  const c = await videoContent(env, "还没批的稿");
  if (approveScript) await founderApprove(env, c.id);
  const root = contentRoot(c.id, env.dir);
  await put(path.join(root, "04-edit/cut.mp4"), "cut");
  await put(path.join(root, "05-cover/c34.png"), png(900, 1200));
  await put(path.join(root, "05-cover/c43.png"), png(1200, 900));
  const r: Reg = { id: c.id, root, video: "04-edit/cut.mp4", c34: "05-cover/c34.png", c43: "05-cover/c43.png" };
  await writePlan(root, planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]));
  return r;
}

describe("批准缺失不能破例", () => {
  it("从没认稿：approval_missing，带 cut/cover/approval_missing 例外照拦，依据指向 review_inbox", async () => {
    const r = await unapproved(false);
    for (const rule of ["cut_registered", "cover_registered", "approval_missing"]) {
      const { res, douyin } = await check(r.id, override(rule));
      expect(douyin.verdict).toBe("block");
      const hits = blocksOf(douyin, "approval_missing");
      expect(hits.map((i) => i.check).sort()).toEqual(["登记封面", "登记成片"]);
      expect(hits.every((i) => i.overridable === false && i.basis.includes("autocrew_review_inbox list") && i.basis.includes("还没认稿"))).toBe(true);
      expect(douyin.items.find((i) => i.check === "例外")?.basis).toContain("破例修不了");
      expect(res.next_action).toContain("autocrew_review_inbox list");
    }
  });

  it("认了稿但成片 / 封面没批：registration_missing，说清缺哪项、指向 review_inbox，例外照拦", async () => {
    const r = await unapproved(true);
    const { douyin } = await check(r.id, override("cut_registered"));
    expect(douyin.verdict).toBe("block");
    const hit = blocksOf(douyin, "registration_missing")[0];
    expect(hit.overridable).toBe(false);
    expect(hit.basis).toContain("成片和封面还没批");
    expect(hit.basis).toContain("autocrew_review_inbox list");
  });

  it("只剩不能破例的拦截：next_action 不提破例；收件箱不给破例按钮，硬点破例被拒", async () => {
    const r = await unapproved(true);
    const { res } = await check(r.id);
    expect(res.next_action).not.toContain("overrides[");
    const item = (await readInbox(env.dir, { contentId: r.id, withDrafts: true })).items.find((i) => i.type === "publish_check")!;
    expect(item.actions.map((a) => a.action)).not.toContain("publish_check_override");
    const out = await decideItem({ content_id: r.id, item_id: item.item_id, gen: item.gen, action: "publish_check_override", note: "我破例" }, env.dir, { jev: fakeJev().caller });
    expect(out).toMatchObject({ ok: false });
    // 条目上没这个按钮：decideItem 先按「按钮不在」拒（bad_request），到不了 publishOverride
    expect(out).toMatchObject({ ok: false, code: "bad_request" });
  });
});

describe("登记没提交 / 文件被换", () => {
  it("新版成片已批、登记没提交：registration_pending，不能例外，依据说按原因补齐（这里是缺字幕）", async () => {
    const r = await registeredVideo(env);
    const v2 = await record(env, { content_id: r.id, kind: "cut", path: await put(path.join(env.chatcut, "v2.mp4"), "cut-v2"), request_id: "c2" });
    const sha = (await readProductionDoc(r.id, env.dir))!.facts.find((f) => f.id === v2.fact_id)!.sha256;
    await waiveSliverCheck(env, r.id, sha!);
    await founderDecision(r.id, "approve_cut", { fact_id: v2.fact_id, sha256: sha }, env.dir);
    expect(await registeredPackage((await getContent(r.id, env.dir))!, env.dir)).toMatchObject({ code: "registration_pending" });
    await writePlan(r.root, planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]));
    const { douyin } = await check(r.id, override("registration_pending"));
    expect(douyin.verdict).toBe("block");
    const hit = blocksOf(douyin, "registration_pending")[0];
    expect(hit.overridable).toBe(false);
    expect(hit.basis).toContain("缺这版成片的字幕");
    expect(hit.basis).toContain("不是破例");
  });

  it.each(["video", "c34"] as const)("登记后 %s 文件被换：registered_file_changed，不能例外", async (which) => {
    const r = await registeredVideo(env);
    await writePlan(r.root, planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]));
    await fs.writeFile(path.join(r.root, r[which]), which === "video" ? "tampered" : png(901, 1200));
    const { douyin } = await check(r.id, override("registered_file_changed"));
    expect(douyin.verdict).toBe("block");
    const hit = blocksOf(douyin, "registered_file_changed")[0];
    expect(hit.overridable).toBe(false);
    expect(hit.basis).toContain("重新通过这一版");
  });
});

describe("登记有效时按字节认", () => {
  it("计划换进一张没登记的封面 + cover_registered 例外：check 拦，出包拒", async () => {
    const r = await registeredVideo(env);
    await put(path.join(r.root, "05-cover/other34.png"), png(901, 1200));
    const e = planEntry(r, "douyin", ["3:4", "4:3"]);
    e.covers[0].path = "05-cover/other34.png";
    await writePlan(r.root, planOf(r, [e]));
    const { douyin } = await check(r.id, override("cover_registered"));
    expect(douyin.verdict).toBe("block");
    expect(blocksOf(douyin, "cover_registered")[0].basis).toContain("cover_pick");
    expect(await prepare(r.id, [douyin.check_id])).toMatchObject({ ok: false, refused: [{ code: "check_blocked" }] });
  });

  it("成片在别的路径、字节相同：check 通过，包里用登记成片路径", async () => {
    const r = await registeredVideo(env);
    await fs.mkdir(path.join(r.root, "07-delivery"), { recursive: true });
    await fs.copyFile(path.join(r.root, r.video), path.join(r.root, "07-delivery/copy.mp4"));
    await writePlan(r.root, { ...planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]), final_video: { path: "07-delivery/copy.mp4" } });
    const { douyin } = await check(r.id);
    expect(douyin.verdict).not.toBe("block");
    expect(douyin.items.some((i) => i.result === "override")).toBe(false);
    const out = await prepare(r.id, [douyin.check_id]);
    expect(out.ok).toBe(true);
    expect(out.data!.packages[0].videoPath).toBe(path.join(r.root, r.video));
  });

  it("全部批准并登记：不带例外 check 通过，出包成功", async () => {
    const r = await registeredVideo(env);
    await writePlan(r.root, planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]));
    const { douyin } = await check(r.id);
    expect(["pass", "warn"]).toContain(douyin.verdict);
    expect((await prepare(r.id, [douyin.check_id])).ok).toBe(true);
  });

  it("旧留档里 cut_registered 被例外过（当时可例外）：按新规则重判，出包拒", async () => {
    const r = await registeredVideo(env);
    await put(path.join(r.root, "07-delivery/other.mp4"), "other-cut");
    await writePlan(r.root, { ...planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]), final_video: { path: "07-delivery/other.mp4" } });
    const { douyin } = await check(r.id, override("cut_registered"));
    const rec = (await readCheckRecord(r.id, douyin.check_id, env.dir))!;
    const items = (rec.items as CheckItem[]).map((i) => (i.rule === "cut_registered" ? { ...i, result: "override" as const, overridable: true, override_quote: "这次破例" } : i));
    await writeCheckRecord(r.id, douyin.check_id, { ...rec, items, verdict: "override" }, env.dir);
    expect(await prepare(r.id, [douyin.check_id])).toMatchObject({ ok: false, refused: [{ code: "check_blocked" }] });
  });

  it("旧留档里 cut_registered 还标着可例外：收件箱不给破例按钮", async () => {
    const r = await registeredVideo(env);
    await put(path.join(r.root, "07-delivery/other.mp4"), "other-cut");
    await writePlan(r.root, { ...planOf(r, [planEntry(r, "douyin", ["3:4", "4:3"])]), final_video: { path: "07-delivery/other.mp4" } });
    const { douyin } = await check(r.id);
    const rec = (await readCheckRecord(r.id, douyin.check_id, env.dir))!;
    const items = (rec.items as CheckItem[]).map((i) => (i.rule === "cut_registered" ? { ...i, overridable: true } : i));
    await writeCheckRecord(r.id, douyin.check_id, { ...rec, items }, env.dir);
    const item = (await readInbox(env.dir, { contentId: r.id, withDrafts: true })).items.find((i) => i.type === "publish_check")!;
    expect(item.actions.map((a) => a.action)).not.toContain("publish_check_override");
  });
});

describe("认稿缺失分两种", () => {
  it("从没认稿 → script_not_approved；认过后正文改了 → script_approval_stale，话不一样", async () => {
    const c = await videoContent(env, "分两种");
    const never = await registeredPackage((await getContent(c.id, env.dir))!, env.dir);
    expect(never).toMatchObject({ ok: false, code: "script_not_approved" });
    await founderApprove(env, c.id);
    const content = (await getContent(c.id, env.dir))!;
    const stale = await registeredPackage({ ...content, body: `${content.body}改了一句` }, env.dir);
    expect(stale).toMatchObject({ ok: false, code: "script_approval_stale" });
    expect((never as { error: string }).error).not.toBe((stale as { error: string }).error);
  });

  it("认稿后重开文稿（reopen 记在上一轮）：新一轮报 script_approval_stale，不是从没认稿", async () => {
    const c = await videoContent(env, "重开");
    await founderApprove(env, c.id);
    expect(await reopenScript(c.id, env.dir)).toMatchObject({ ok: true });
    expect(await registeredPackage((await getContent(c.id, env.dir))!, env.dir)).toMatchObject({ ok: false, code: "script_approval_stale" });
  });
});

describe("video_kit 不再要成片戳（本体稿）", () => {
  it("本体视频稿还没登记：发布包照存；出包仍被登记出口拦", async () => {
    const r = await unapproved(true);
    const kit = { post_title: "不写代码也能用的AI", caption: "这期讲清楚普通人怎么把重复活交给 AI，看完就能上手。", cover_text: "别再手搬了", title_method: "identity-call",
      title_candidates: [{ title: "不写代码也能用的AI", method: "identity-call", reason: "点名不写代码的人" }, { title: "AI 都会用，为什么还天天加班", method: "name-the-need", reason: "说中隐性困扰" }, { title: "把重复活交给 AI 之后", method: "before-after", reason: "前后变化" }] };
    const saved = await executePrePublishTool({ action: "video_kit", content_id: r.id, platform: "douyin", kit, _dataDir: env.dir });
    expect(saved).not.toMatchObject({ code: "video_not_done" });
    expect(saved).toMatchObject({ ok: true, status: "kit_saved" });
    const { douyin } = await check(r.id);
    expect(douyin.verdict).toBe("block");
    expect(await prepare(r.id, [douyin.check_id])).toMatchObject({ ok: false });
  });
});
