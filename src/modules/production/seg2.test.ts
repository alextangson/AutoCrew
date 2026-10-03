/**
 * Segment ②：创始人决定（§2.4）、批准即登记（§5）、发布出口、发布回执（§6）、工作台适配（§8）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../storage/local-store.js";
import { readProductionDoc, readTimeline } from "../../storage/production-store.js";
import { executePublish } from "../../tools/publish.js";
import { founderProjectReview } from "../video/handoff/founder-review.js";
import { prepareEgoLitePublish } from "../publish/ego-lite.js";
import { founderDecision } from "./decisions.js";
import { registeredPackage } from "./publish-gate.js";
import { reconcileAll } from "./reconcile.js";
import { reopenScript } from "./reopen.js";
import { exists, founderApprove, makeEnv, png, projectRoot, put, record, SRT, videoContent, type Env, waiveSliverCheck } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

const TITLE = "AI 又忘了怎么办";

/** 认过稿、报齐原片 / 成片 / 封面（字幕可选）的一条稿；返回各事实 id 与 sha */
async function edited(opts: { srt?: boolean; coverText?: string } = {}) {
  const c = await videoContent(env, TITLE);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
  const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "AI又忘了怎么办.mp4"), "cut-v1"), request_id: "c", review: true });
  if (opts.srt !== false) await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), SRT), for_cut: cut.fact_id, request_id: "s" });
  const c34 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c34.png"), png(900, 1200)), ...(opts.coverText ? { cover_text: opts.coverText } : {}), request_id: "p1" });
  const c43 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c43.png"), png(1200, 900)), version: 1, request_id: "p2" });
  const doc = (await readProductionDoc(c.id, env.dir))!;
  const sha = (id: unknown) => doc.facts.find((f) => f.id === id)!.sha256!;
  return { c, cut: { fact_id: cut.fact_id, sha256: sha(cut.fact_id) }, c34: { fact_id: c34.fact_id, sha: sha(c34.fact_id) }, c43: { fact_id: c43.fact_id, sha: sha(c43.fact_id) } };
}

/** 与抽帧无关的用例：批成片前先整条放行抽帧检查（临时库没有 ChatCut 工程，检查必然没跑成） */
const decide = async (id: string, action: string, p: Record<string, unknown> = {}) => {
  if (action === "approve_cut" && typeof p.sha256 === "string") await waiveSliverCheck(env, id, p.sha256);
  return founderDecision(id, action, p, env.dir);
};
const pick = (s: Awaited<ReturnType<typeof edited>>, text?: string) => decide(s.c.id, "pick_cover", {
  cover_3x4_fact_id: s.c34.fact_id, cover_3x4_sha: s.c34.sha, cover_4x3_fact_id: s.c43.fact_id, cover_4x3_sha: s.c43.sha, ...(text ? { cover_text: text } : {}),
});

describe("创始人决定（§2.4）", () => {
  it("模型调用一律拒；决定不带 expectedStatus，幂等键 = (类型, 指纹)", async () => {
    const s = await edited();
    expect(await founderDecision(s.c.id, "approve_cut", { ...s.cut, _host: "codex" }, env.dir)).toMatchObject({ ok: false, code: "founder_only" });
    const a = await decide(s.c.id, "approve_cut", s.cut);
    const b = await decide(s.c.id, "approve_cut", s.cut);
    expect(a).toMatchObject({ ok: true });
    expect((b.decision as { id: string }).id).toBe((a.decision as { id: string }).id);
    expect((await readProductionDoc(s.c.id, env.dir))!.decisions.filter((d) => d.type === "cut_approval")).toHaveLength(1);
  });

  it("封面：两个比例都要（E10）；封面字当场要有（E9），报上来的默认字可用", async () => {
    const s = await edited();
    expect(await decide(s.c.id, "pick_cover", { cover_3x4_fact_id: s.c34.fact_id, cover_3x4_sha: s.c34.sha })).toMatchObject({ ok: false, code: "both_ratios_required" });
    expect(await pick(s)).toMatchObject({ ok: false, code: "cover_text_required" });
    expect(await pick(s, "AI 又忘了？")).toMatchObject({ ok: true });
    const withDefault = await edited({ coverText: "默认字" });
    expect(await pick(withDefault)).toMatchObject({ ok: true, decision: { cover_text: "默认字" } });
  });

  it("打回要写原话，写进时间线（E15）", async () => {
    const s = await edited();
    expect(await decide(s.c.id, "reject_cut", s.cut)).toMatchObject({ ok: false, code: "note_required" });
    expect(await decide(s.c.id, "reject_cut", { ...s.cut, note: "开头太慢" })).toMatchObject({ ok: true });
    expect((await readTimeline(s.c.id, env.dir)).some((e) => e.type === "cut_rejected" && e.detail.note === "开头太慢")).toBe(true);
  });

  it("确认候选：库外原片挪进项目并 accepted；「不是这条」按条记住，再报也不收（E8）", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    const outside = await put(path.join(env.outside, "录的.mov"), "raw");
    const cand = await record(env, { content_id: c.id, kind: "aroll", path: outside, request_id: "r1" });
    const r = await decide(c.id, "confirm_candidate", { fact_id: cand.fact_id, sha256: (await readProductionDoc(c.id, env.dir))!.facts[0].sha256 });
    expect(r).toMatchObject({ ok: true, state: "accepted", path: "02-aroll/AI 又忘了怎么办-原片.mov" });
    expect(await exists(outside)).toBe(false);
    const other = await put(path.join(env.outside, "别的.mp4"), "not-this");
    const cand2 = await record(env, { content_id: c.id, kind: "cut", path: other, request_id: "r2" });
    await decide(c.id, "reject_candidate", { fact_id: cand2.fact_id, sha256: (await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.id === cand2.fact_id)!.sha256 });
    expect(await record(env, { content_id: c.id, kind: "cut", path: other, request_id: "r3" })).toMatchObject({ ok: false, code: "rejected_before" });
  });
});

describe("批准即登记（§5）", () => {
  it("两个批准齐 → 自动登记：不可变登记记录、登记成片 / 封面副本、video.final、实拍版口播；进待发布", async () => {
    const s = await edited();
    await decide(s.c.id, "approve_cut", s.cut);
    const r = await pick(s, "AI 又忘了？");
    expect(r).toMatchObject({ ok: true, stage: "待发布" });
    const doc = (await readProductionDoc(s.c.id, env.dir))!;
    expect(doc.registrations).toMatchObject([{ source: "commit", cut_sha: s.cut.sha256, cover_text: "AI 又忘了？", srt_for_cut: s.cut.sha256 }]);
    const content = (await getContent(s.c.id, env.dir))!;
    expect(content.status).toBe("publish_ready");
    expect(content.video?.final).toMatchObject({ register_hash: doc.registrations[0].id, sha256: s.cut.sha256 });
    expect(content.videoDone).toBeTruthy();
    const root = projectRoot(env, s.c.id);
    expect(await fs.readFile(path.join(root, "05-cover/封面-3x4.png"))).toEqual(png(900, 1200));
    expect((await fs.readdir(path.join(root, "07-delivery/registered")))[0]).toMatch(/^final-r1-/);
    expect(await exists(path.join(root, "01-script/spoken/g0001-spoken.md"))).toBe(true);
    expect(await exists(path.join(root, "01-script/spoken/g0001-checklist.json"))).toBe(true);
  });

  it("缺这版成片的字幕：批准照存、D3 写原因（E22）；字幕后到时 record 自动补完登记", async () => {
    const s = await edited({ srt: false });
    await decide(s.c.id, "approve_cut", s.cut);
    const r = await pick(s, "字");
    expect(r).toMatchObject({ ok: true, stage: "剪辑中", missing: ["缺这版成片的字幕"] });
    expect((await readProductionDoc(s.c.id, env.dir))!.registrations).toEqual([]);
    const srt = await record(env, { content_id: s.c.id, kind: "srt", path: await put(path.join(env.chatcut, "late.srt"), SRT), for_cut: s.cut.fact_id, request_id: "late" });
    expect(srt).toMatchObject({ ok: true });
    expect(srt.registration).toBeTruthy();
    expect((await getContent(s.c.id, env.dir))!.status).toBe("publish_ready");
  });

  it("新一版成片的字幕和上一版字节相同：照样绑上新版，批新版后登记成功，旧版绑定不动", async () => {
    const s = await edited();
    const v2 = await record(env, { content_id: s.c.id, kind: "cut", path: await put(path.join(env.chatcut, "cut-v002.mp4"), "cut-v2"), request_id: "c2", review: true });
    const srt = await record(env, { content_id: s.c.id, kind: "srt", path: await put(path.join(env.chatcut, "cut-v002.srt"), SRT), for_cut: v2.fact_id, request_id: "s2" });
    expect(srt).toMatchObject({ ok: true, state: "accepted" });
    const before = (await readProductionDoc(s.c.id, env.dir))!;
    const v2sha = before.facts.find((f) => f.id === v2.fact_id)!.sha256!;
    expect(await decide(s.c.id, "approve_cut", { fact_id: v2.fact_id, sha256: v2sha })).toMatchObject({ ok: true });
    const r = await pick(s, "字");
    expect(r.missing ?? []).not.toContain("缺这版成片的字幕");
    const doc = (await readProductionDoc(s.c.id, env.dir))!;
    expect(doc.registrations).toMatchObject([{ source: "commit", cut_sha: v2sha, srt_for_cut: v2sha }]);
    const srts = doc.facts.filter((f) => f.kind === "srt");
    expect(srts.map((f) => f.for_cut).sort()).toEqual([s.cut.sha256, v2sha].sort());
    expect((await getContent(s.c.id, env.dir))!.status).toBe("publish_ready");
  });

  it("登记记录写不进去（提交点之前失败）：拷进项目的副本撤回，旧封面放回", async () => {
    const s = await edited();
    const root = projectRoot(env, s.c.id);
    await put(path.join(root, "05-cover/封面-3x4.png"), "old-cover");
    await decide(s.c.id, "approve_cut", s.cut);
    const store = await import("../../storage/production-store.js");
    const real = store.writeProductionDoc;
    vi.spyOn(store, "writeProductionDoc").mockImplementation(async (id, dir, doc, rev) => {
      if (doc.registrations.length) throw new Error("磁盘满了");
      return real(id, dir, doc, rev);
    });
    const r = await pick(s, "字");
    expect(r.registration_failed ?? "").toContain("登记记录没写上");
    vi.restoreAllMocks();
    expect(await fs.readFile(path.join(root, "05-cover/封面-3x4.png"), "utf8")).toBe("old-cover");
    expect(await fs.readdir(path.join(root, "07-delivery/registered")).catch(() => [])).toEqual([]);
  });
});

describe("发布出口（§5，E13 / E37）", () => {
  async function registered() {
    const s = await edited();
    await decide(s.c.id, "approve_cut", s.cut);
    await pick(s, "字");
    return s;
  }

  it("只取当前登记的成片与封面；ego-lite 发布包用它们", async () => {
    const s = await registered();
    const gate = await registeredPackage((await getContent(s.c.id, env.dir))!, env.dir);
    expect(gate).toMatchObject({ ok: true });
    const pkg = await prepareEgoLitePublish(s.c.id, env.dir);
    expect(pkg.videoPath).toBe(path.join(projectRoot(env, s.c.id), "04-edit/AI又忘了怎么办.mp4"));
    expect(pkg.coverPath).toBe(path.join(projectRoot(env, s.c.id), "05-cover/v001/封面-3x4.png"));
  });

  it("撤批后旧包立即不可发", async () => {
    const s = await registered();
    const approval = (await readProductionDoc(s.c.id, env.dir))!.decisions.find((d) => d.type === "cut_approval")!;
    await decide(s.c.id, "revoke_approval", { decision_id: approval.id });
    expect(await registeredPackage((await getContent(s.c.id, env.dir))!, env.dir)).toMatchObject({ ok: false, code: "no_registration" });
    await expect(prepareEgoLitePublish(s.c.id, env.dir)).rejects.toThrow(/没有当前有效的登记/);
  });

  it("新版已批准但登记没完成（缺字幕）→ 阻止发布旧包（E37）", async () => {
    const s = await registered();
    const v2 = await record(env, { content_id: s.c.id, kind: "cut", path: await put(path.join(env.chatcut, "AI又忘了怎么办-v2.mp4"), "cut-v2"), request_id: "c2" });
    const sha = (await readProductionDoc(s.c.id, env.dir))!.facts.find((f) => f.id === v2.fact_id)!.sha256;
    await decide(s.c.id, "approve_cut", { fact_id: v2.fact_id, sha256: sha });
    expect(await registeredPackage((await getContent(s.c.id, env.dir))!, env.dir)).toMatchObject({ ok: false, code: "registration_pending" });
  });

  it("所批成片在项目里被原地覆盖 → 批准失效，不可发（E13）", async () => {
    const s = await registered();
    await put(path.join(projectRoot(env, s.c.id), "04-edit/AI又忘了怎么办.mp4"), "overwritten");
    await reconcileAll(env.dir);
    const gate = await registeredPackage((await getContent(s.c.id, env.dir))!, env.dir);
    expect(gate?.ok).toBe(false);
    expect((await getContent(s.c.id, env.dir))!.status).toBe("editing");
  });
});

describe("发布回执（§6）", () => {
  async function registered() {
    const s = await edited();
    await decide(s.c.id, "approve_cut", s.cut);
    await pick(s, "字");
    return s;
  }
  const writePlan = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    put(path.join(projectRoot(env, id), "06-publish/publish-plan.json"), JSON.stringify({ platforms: [{ platform: "douyin", publication: { status, ...extra } }] }));

  it("发布器记录：审核中 → 已发布（badge 审核中）；被驳回 → 回待发布并标原因（E35）", async () => {
    const s = await registered();
    await writePlan(s.c.id, "rejected", { reason: "封面违规" });
    await reconcileAll(env.dir);
    expect((await getContent(s.c.id, env.dir))!.status).toBe("publish_ready");
    await writePlan(s.c.id, "reviewing");
    await reconcileAll(env.dir);
    const c = (await getContent(s.c.id, env.dir))!;
    expect(c.status).toBe("published");
    expect(c.publishedAt).toBeTruthy();
  });

  it("模型说发了（record kind=publish / 模型调 confirm_published）→ 待核，不动阶段；创始人确认后已发布", async () => {
    const s = await registered();
    await executePublish({ _dataDir: env.dir, _host: "codex", action: "confirm_published", content_id: s.c.id, publish_url: "https://v.douyin.com/x" });
    expect((await getContent(s.c.id, env.dir))!.status).toBe("publish_ready");
    const doc = (await readProductionDoc(s.c.id, env.dir))!;
    const claim = doc.facts.find((f) => f.kind === "publish")!;
    expect(claim).toMatchObject({ verified: false });
    expect(await decide(s.c.id, "confirm_receipt", { fact_id: claim.id })).toMatchObject({ ok: true, stage: "已发布" });
  });

  it("「我发了」可纠正；回执绑在轮次上，重开之后旧回执不算（Codex P2）", async () => {
    const s = await registered();
    const r = await decide(s.c.id, "i_published", { platform: "douyin" });
    expect(r).toMatchObject({ ok: true, stage: "已发布" });
    expect(await decide(s.c.id, "correct_publish", { target_id: (r.decision as { id: string }).id })).toMatchObject({ ok: true, stage: "待发布" });
    await writePlan(s.c.id, "public");
    await reconcileAll(env.dir);
    expect((await getContent(s.c.id, env.dir))!.status).toBe("published");
    // 创始人 09-30：已发布的也能重开（原地重做）；旧回执留作历史，不算新一轮
    await reopenScript(s.c.id, env.dir);
    await founderApprove(env, s.c.id);
    await reconcileAll(env.dir);
    expect((await getContent(s.c.id, env.dir))!.status).not.toBe("published");
  });
});

describe("工作台适配（§8）", () => {
  it("工作台的成片批准 / 封面选用写成创始人决定，不要交接代次", async () => {
    const s = await edited();
    await put(path.join(projectRoot(env, s.c.id), "00-project/autocrew/decisions.json"), JSON.stringify({ cover_text: "工作台封面字" }));
    const view = await founderProjectReview(s.c.id, env.dir);
    expect(view).toMatchObject({ ok: true, ontology: true, handoff_valid: true });
    await waiveSliverCheck(env, s.c.id, s.cut.sha256);
    await founderProjectReview(s.c.id, env.dir, { action: "approve", which: "final_cut", files: [{ path: "04-edit/AI又忘了怎么办.mp4", sha256: s.cut.sha256 }] });
    const after = await founderProjectReview(s.c.id, env.dir, { action: "approve", which: "covers", files: [{ sha256: s.c34.sha }, { sha256: s.c43.sha }] });
    expect((after.gates as Record<string, { status: string }>).gate3.status).toBe("approved");
    expect((after.gates as Record<string, { status: string }>).gate4.status).toBe("approved");
    expect((await readProductionDoc(s.c.id, env.dir))!.registrations).toMatchObject([{ cover_text: "工作台封面字" }]);
  });
});
