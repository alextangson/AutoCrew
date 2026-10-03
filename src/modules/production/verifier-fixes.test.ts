/**
 * 验收修复（2026-09-29 verifier）里 verifier-findings.test.ts 之外补的回归。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "../../runtime/context.js";
import { EventBus } from "../../runtime/events.js";
import { ToolRunner } from "../../runtime/tool-runner.js";
import { executePublish, publishSchema } from "../../tools/publish.js";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { writeEnabledVersion } from "../../storage/production-store.js";
import { founderDecision } from "./decisions.js";
import { enableOntology } from "./enable.js";
import fs from "node:fs/promises";
import { reconcileContent } from "./reconcile.js";
import { registeredVideo } from "../publish/review-gate/testkit.js";
import { makeEnv, png, put, videoContent, type Env } from "./testkit.js";

const enable = () => writeEnabledVersion(env.dir);

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: false }); });
afterEach(async () => { await env.cleanup(); });

describe("P1-2 旧预检", () => {
  it("未启用的资料库旧预检照跑，但报错不建议 force", async () => {
    const c = await videoContent(env, "AI 又忘了怎么办");
    const runner = new ToolRunner({ ctx: createContext({ data_dir: env.dir }), eventBus: new EventBus() });
    runner.register({ name: "autocrew_publish", label: "publish", description: "", parameters: publishSchema, execute: executePublish });
    const res = await runner.execute("autocrew_publish", { action: "ego_lite_prepare", content_id: c.id, _host: "claude-code" }) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: false, error: "pre_publish_check_failed" });
    expect(JSON.stringify(res)).not.toContain("force");
  });
});

describe("P2-3 / P3 回执与决定", () => {
  it("[P2-3] 封面被覆盖（没改回）：选它回 cover_replaced，不回成功", async () => {
    await enable();
    const r = await registeredVideo(env);
    const doc = (await readProductionDoc(r.id, env.dir))!;
    const c34 = doc.facts.find((f) => f.kind === "cover" && f.ratio === "3:4" && f.state === "accepted")!;
    const c43 = doc.facts.find((f) => f.kind === "cover" && f.ratio === "4:3" && f.state === "accepted")!;
    await put(path.join(r.root, c34.path!), png(900, 1200, "overwritten"));
    await reconcileContent(r.id, env.dir);
    const res = await founderDecision(r.id, "pick_cover", { cover_3x4_fact_id: c34.id, cover_3x4_sha: c34.sha256, cover_4x3_fact_id: c43.id, cover_4x3_sha: c43.sha256, cover_text: "字" }, env.dir);
    expect(res).toMatchObject({ ok: false, code: "cover_replaced" });
  });

  it("[P3 #16] 模型反复 confirm_published 同一链接：只记一条待核", async () => {
    await enable();
    const r = await registeredVideo(env);
    for (let i = 0; i < 3; i++) await executePublish({ _dataDir: env.dir, action: "confirm_published", content_id: r.id, publish_url: "https://v.douyin.com/abc", _host: "codex" });
    const doc = (await readProductionDoc(r.id, env.dir))!;
    expect(doc.facts.filter((f) => f.kind === "publish" && f.obs_source === "claim")).toHaveLength(1);
  });

  it("[P3 #17] 「我发了」不收 javascript: 链接", async () => {
    await enable();
    const r = await registeredVideo(env);
    expect(await founderDecision(r.id, "i_published", { platform: "douyin", url: "javascript:alert(1)" }, env.dir)).toMatchObject({ ok: false, code: "bad_url" });
  });
});

describe("P3 #11 原片收件箱", () => {
  it("启用后建好收件箱（不存在就建）", async () => {
    await fs.rm(env.inbox, { recursive: true, force: true });
    expect((await enableOntology(env.dir)).ok).toBe(true);
    expect((await fs.stat(env.inbox)).isDirectory()).toBe(true);
  });

});

describe("P2-7 启用后不再指向旧交接流程", () => {
  it("手动切剪辑中 / codex handoff / codex 越权 / 写稿页提示都指向 record 与 summary；summary 的阶段来自推导", async () => {
    await enable();
    const { executeContentSave } = await import("../../tools/content-save.js");
    const { hostPolicy } = await import("../../../mcp/host-policy.js");
    const c = await videoContent(env, "AI 又忘了怎么办");
    const t = await executeContentSave({ _dataDir: env.dir, action: "transition", id: c.id, target_status: "editing" }) as { error?: string };
    expect(t.error).toContain("record kind=aroll");
    expect(t.error).not.toContain("剪这条");
    const { executeVideo } = await import("../../tools/video.js");
    // 旧交接入口由工具自己关，对每个宿主都一样（2026-10-02 起 codex 不再单独限权）
    for (const host of ["claude-code", "codex"]) {
      expect(await executeVideo({ _dataDir: env.dir, action: "handoff", content_id: c.id, aroll_path: "/x.mov", _host: host })).toMatchObject({ ok: false, code: "entry_closed" });
      expect(hostPolicy(host, "autocrew_writer", { action: "pack" }).ok).toBe(true);
    }
    const { createElement } = await import("../../../frontend/node_modules/react/index.js") as typeof import("react");
    const { renderToStaticMarkup } = await import("../../../frontend/node_modules/react-dom/server.node.js") as typeof import("react-dom/server");
    const { SharedProjectPanel } = await import("../../../frontend/src/views/SharedProjectPanel");
    expect(renderToStaticMarkup(createElement(SharedProjectPanel, { status: "approved", isVideo: true, ontology: true }))).toContain("0 原片放这里");
  });

  it("summary：本体稿制作段的 stage / next 来自 explain()", async () => {
    await enable();
    const { executeContentSave } = await import("../../tools/content-save.js");
    const r = await registeredVideo(env);
    const s = await executeContentSave({ _dataDir: env.dir, action: "summary", id: r.id }) as Record<string, unknown>;
    expect(s.stage).toBe("待发布");
    expect(String(s.next)).toContain("check_ids");
  });
});

describe("P3 #14 / #15 与创始人决定 1、3", () => {
  it("[#14] 冻结后改正文被拒，且不留写稿认领", async () => {
    await enable();
    const { executeContentSave } = await import("../../tools/content-save.js");
    const { getContent } = await import("../../storage/local-store.js");
    const { record } = await import("./testkit.js");
    const { founderApprove } = await import("./testkit.js");
    const c = await videoContent(env, "AI 又忘了怎么办");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
    const before = (await getContent(c.id, env.dir))!.claim;
    const res = await executeContentSave({ _dataDir: env.dir, action: "update", id: c.id, body: "改一个字", _host: "claude-code" });
    expect(res).toMatchObject({ ok: false, code: "script_frozen" });
    expect((await getContent(c.id, env.dir))!.claim).toEqual(before);
  });

  it("[#15] 相对路径不按服务工作目录解析，报错不带服务路径", async () => {
    await enable();
    const { record, founderApprove } = await import("./testkit.js");
    const c = await videoContent(env, "AI 又忘了怎么办");
    await founderApprove(env, c.id);
    const res = await record(env, { content_id: c.id, kind: "aroll", path: "package.json", request_id: "rel" });
    expect(res).toMatchObject({ ok: false, code: "path_relative" });
    expect(JSON.stringify(res)).not.toContain(process.cwd());
  });

  it("[决定 1 改为 09-30] 已发布也能重开：新一轮发布槽是空的，上一轮的回执留作历史；确认框说明白", async () => {
    await enable();
    const r = await registeredVideo(env);
    await founderDecision(r.id, "i_published", { platform: "douyin", url: "https://v.douyin.com/old" }, env.dir);
    const { reopenScript } = await import("./reopen.js");
    const { cardPanel } = await import("./panel.js");
    const before = await cardPanel(r.id, env.dir);
    expect(before).toMatchObject({ stage: "已发布", can_reopen: true, published_now: true });
    expect(await reopenScript(r.id, env.dir)).toMatchObject({ ok: true, round: 2 });
    const after = await cardPanel(r.id, env.dir) as { stage: string; published: unknown[]; published_now: boolean; past_receipts: Array<{ round: number; platform: string; url: string | null }> };
    expect(after.stage).not.toBe("已发布");
    expect(after.published).toEqual([]);
    expect(after.published_now).toBe(false);
    expect(after.past_receipts).toEqual([expect.objectContaining({ round: 1, platform: "douyin", url: "https://v.douyin.com/old" })]);
    const { UNDO } = await import("../../../frontend/src/views/board-columns");
    expect(UNDO.reopen_published.body).toBe("这条已发布，重开后会移出已发布栏、回到写稿中；这次的发布记录留作历史");
  });


  it("[决定 3 / seg9] 重开后上一轮的原片仍归原稿：别条稿 record 不能占；创始人改挂 = 持久转移", async () => {
    await enable();
    const { record, founderApprove } = await import("./testkit.js");
    const { reopenScript } = await import("./reopen.js");
    const a = await videoContent(env, "AI 又忘了怎么办");
    await founderApprove(env, a.id);
    const raw = await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw-shared");
    await record(env, { content_id: a.id, kind: "aroll", path: raw, request_id: "a1" });
    expect(await reopenScript(a.id, env.dir)).toMatchObject({ ok: true });
    const doc = (await readProductionDoc(a.id, env.dir))!;
    const moved = doc.facts.find((f) => f.kind === "aroll")!;
    const b = await videoContent(env, "另一条稿");
    await founderApprove(env, b.id);
    const abs = path.join((await import("./testkit.js")).projectRoot(env, a.id), moved.path!);
    expect(await record(env, { content_id: b.id, kind: "aroll", path: abs, request_id: "b1" })).toMatchObject({ ok: false, code: "aroll_conflict" });
    const attach = await founderDecision(b.id, "attach_aroll", { path: abs, confirm_other: true }, env.dir);
    // 卡片据此弹「改挂到这条？」：说清现在归谁、能不能改挂
    expect(attach).toMatchObject({ ok: false, code: "aroll_conflict", owner_id: a.id, owner_title: "AI 又忘了怎么办", reassignable: true });
    expect(await founderDecision(b.id, "attach_aroll", { path: abs, confirm_other: true, reassign: true }, env.dir)).toMatchObject({ ok: true });
    // seg9 P2：改挂是持久的归属转移——原稿那条标成已改挂，之后 B 再报同一原片不再冲突
    const aDoc = (await readProductionDoc(a.id, env.dir))!;
    expect(aDoc.facts.find((f) => f.id === moved.id)?.released_to).toBe(b.id);
    const bDoc = (await readProductionDoc(b.id, env.dir))!;
    const bAroll = bDoc.facts.find((f) => f.kind === "aroll" && f.state === "accepted")!;
    const inB = path.join((await import("./testkit.js")).projectRoot(env, b.id), bAroll.path!);
    expect(await record(env, { content_id: b.id, kind: "aroll", path: path.isAbsolute(bAroll.path!) ? bAroll.path! : inB, request_id: "b2" })).toMatchObject({ ok: true });
  });
});

describe("seg9", () => {
  it("[P2 tool-runner] 启用后出包：旧预检里闸门没覆盖的项照拦（无标签、字数），只有旧封面审核跳过", async () => {
    await enable();
    const r = await registeredVideo(env);
    const runner = new ToolRunner({ ctx: createContext({ data_dir: env.dir }), eventBus: new EventBus() });
    runner.register({ name: "autocrew_publish", label: "publish", description: "", parameters: publishSchema, execute: executePublish });
    const res = await runner.execute("autocrew_publish", { action: "ego_lite_prepare", content_id: r.id, check_ids: ["chk-x"], _host: "claude-code" }) as { ok: boolean; checks?: Array<{ name: string; status: string }> };
    expect(res.ok).toBe(false);
    const by = Object.fromEntries((res.checks ?? []).map((c) => [c.name, c.status]));
    expect(by["Hashtags"]).toBe("fail");
    expect(by["封面审核"]).toBe("skip");
    expect(JSON.stringify(res)).not.toContain("force");
  });

  it("[P2 receipts] 历史纠正存的是中文平台名槽（slot:1:视频号）：归一后照样作废那条回执", async () => {
    const { emptyProductionDoc } = await import("../../storage/production-types.js");
    const { slotOf } = await import("./receipts.js");
    const doc = emptyProductionDoc();
    doc.facts.push({ id: "f1", kind: "publish", round: 1, state: "accepted", availability: "present", source: "reconcile", at: "2026-09-01T00:00:00Z",
      seen_at: "2026-09-01T00:00:00Z", obs_source: "plan", platform: "视频号", pub_state: "public", verified: true, evidence: "计划" });
    expect(slotOf(doc, 1, "wechat_video")).not.toBeNull();
    doc.decisions.push({ id: "c1", type: "publish_correction", target_id: "slot:1:视频号", round: 1, at: "2026-09-02T00:00:00Z", source: "founder" });
    expect(slotOf(doc, 1, "wechat_video")).toBeNull();
  });
});

describe("seg9 小项", () => {
  it("入口关闭的报错指向 summary 真有的字段 next", async () => {
    const { ENTRY_CLOSED } = await import("./closed.js");
    const { contentSummary } = await import("../../tools/content-summary.js");
    await enable();
    const c = await videoContent(env, "AI 又忘了怎么办");
    const s = await contentSummary(c.id, env.dir);
    expect(ENTRY_CLOSED).toContain("next 字段");
    expect(s).toHaveProperty("next");
    expect(s).not.toHaveProperty("next_action");
  });
});

describe("seg10", () => {
  it("[P1 reopen] 已定时投出（公开时间晚于重开）后重开：旧计划记录钉在第 1 轮，新一轮不算已发布", async () => {
    await enable();
    const { founderApprove } = await import("./testkit.js");
    const { reopenScript } = await import("./reopen.js");
    const { reconcileAll } = await import("./reconcile.js");
    const { cardPanel } = await import("./panel.js");
    const r = await registeredVideo(env);
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const plan = (pub: Record<string, unknown>) => put(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify({ platforms: [{ platform: "douyin", publication: pub }] }));
    await plan({ status: "scheduled", scheduled_at: future, submitted_at: new Date().toISOString() });
    await reconcileAll(env.dir);
    expect((await cardPanel(r.id, env.dir)).stage).toBe("已发布");
    expect(await reopenScript(r.id, env.dir)).toMatchObject({ ok: true, round: 2 });
    await founderApprove(env, r.id);
    await reconcileAll(env.dir);
    await plan({ status: "public", published_at: future, submitted_at: new Date(Date.now() - 60_000).toISOString() });
    await reconcileAll(env.dir);
    const p = await cardPanel(r.id, env.dir) as { stage: string; published: unknown[] };
    expect(p.stage).not.toBe("已发布");
    expect(p.published).toEqual([]);
    const doc = (await readProductionDoc(r.id, env.dir))!;
    expect(doc.facts.filter((f) => f.kind === "publish").every((f) => f.round === 1)).toBe(true);
  });

  it("[P2 pre-publish] 非视频平台（xhs）带内部跳过参数：封面审核照拦", async () => {
    await enable();
    const { saveContent } = await import("../../storage/local-store.js");
    const { executePrePublish } = await import("../../tools/pre-publish.js");
    const c = await saveContent({ title: "小红书图文", body: "正文".repeat(80), platform: "xhs", status: "approved", tags: [] } as never, env.dir);
    const res = await executePrePublish({ _dataDir: env.dir, content_id: c.id, _ontologyGated: true, _readOnly: true }) as { checks?: Array<{ name: string; status: string }> };
    expect(res.checks?.find((x) => x.name === "封面审核")?.status).toBe("fail");
  });

  it("[P2 record] 改挂接收失败（目标目录不安全）：原稿照旧独占；提交后崩在释放前，启动恢复补做释放", async () => {
    await enable();
    const { record, founderApprove, projectRoot } = await import("./testkit.js");
    const { reopenScript } = await import("./reopen.js");
    const { arollOwnerElsewhere, forgetShaIndex } = await import("./sha-index.js");
    const a = await videoContent(env, "AI 又忘了怎么办");
    await founderApprove(env, a.id);
    await record(env, { content_id: a.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw-shared"), request_id: "a1" });
    await reopenScript(a.id, env.dir);
    const moved = (await readProductionDoc(a.id, env.dir))!.facts.find((f) => f.kind === "aroll")!;
    const abs = path.join(projectRoot(env, a.id), moved.path!);
    const b = await videoContent(env, "另一条稿");
    await founderApprove(env, b.id);
    // 目标稿的 02-aroll 换成符号链接 → target_unsafe
    const bRoot = projectRoot(env, b.id);
    await fs.rm(path.join(bRoot, "02-aroll"), { recursive: true, force: true });
    await fs.mkdir(env.outside, { recursive: true });
    await fs.symlink(env.outside, path.join(bRoot, "02-aroll"));
    const res = await founderDecision(b.id, "attach_aroll", { path: abs, confirm_other: true, reassign: true }, env.dir);
    expect(res.ok).toBe(false);
    forgetShaIndex(env.dir);
    expect(await arollOwnerElsewhere(env.dir, moved.sha256!, b.id)).toBe(a.id);
    expect((await readProductionDoc(a.id, env.dir))!.facts.find((f) => f.id === moved.id)?.released_to).toBeUndefined();
    // 恢复：接收方已提交（production.json 里有事务 id）而释放没做 → 启动时补做
    const { saveTxn, recoverTxns } = await import("./txn.js");
    const { mutateProduction } = await import("./service.js");
    await mutateProduction(b.id, env.dir, (d) => { d.txns = [...(d.txns ?? []), "txn-rel-1"]; return { value: null, events: [] }; });
    await saveTxn(env.dir, { id: "txn-rel-1", kind: "record", content_id: b.id, round: 0, ops: [], at: new Date().toISOString(), release: { owner: a.id, sha256: moved.sha256!, to: b.id } });
    expect(await recoverTxns(env.dir)).toEqual([expect.objectContaining({ id: "txn-rel-1", outcome: "committed" })]);
    expect((await readProductionDoc(a.id, env.dir))!.facts.find((f) => f.id === moved.id)?.released_to).toBe(b.id);
  });
});

describe("seg11", () => {
  it("[seg12 / 09-30 保守规则] 重开后新作品没写 submitted_at：留在旧轮（已知代价，创始人点「我发了」）；带晚于重开的 submitted_at 才算新一轮", async () => {
    const { emptyProductionDoc } = await import("../../storage/production-types.js");
    const { importObservations, slotOf } = await import("./receipts.js");
    const doc = emptyProductionDoc();
    importObservations(doc, [{ source: "plan", platform: "douyin", item_id: "OLD", pub_state: "public", published_at: "2026-09-10T00:00:00Z", evidence: "计划" }]);
    doc.decisions.push({ id: "r1", type: "reopen", round: 1, at: "2026-09-20T00:00:00Z", source: "founder" });
    doc.round = 2;
    importObservations(doc, [{ source: "plan", platform: "douyin", item_id: "NEW", pub_state: "public", published_at: "2026-09-25T00:00:00Z", evidence: "计划" }]);
    expect(slotOf(doc, 2, "douyin")).toBeNull();
    importObservations(doc, [{ source: "plan", platform: "douyin", item_id: "NEW", pub_state: "public", published_at: "2026-09-25T00:00:00Z", submitted_at: "2026-09-24T00:00:00Z", evidence: "计划" }]);
    expect(slotOf(doc, 2, "douyin")).toMatchObject({ item_id: "NEW" });
  });

  it("[seg12 P1] 旧定时帖（没作品 id、提交早于重开）重开后公开时才补上 id、公开时间略有出入：仍留旧轮", async () => {
    const { emptyProductionDoc } = await import("../../storage/production-types.js");
    const { importObservations, slotOf } = await import("./receipts.js");
    const doc = emptyProductionDoc();
    importObservations(doc, [{ source: "plan", platform: "douyin", pub_state: "scheduled", published_at: "2026-10-10T10:00:00Z", submitted_at: "2026-09-10T00:00:00Z", evidence: "计划" }]);
    doc.decisions.push({ id: "r1", type: "reopen", round: 1, at: "2026-09-20T00:00:00Z", source: "founder" });
    doc.round = 2;
    importObservations(doc, [{ source: "plan", platform: "douyin", item_id: "7123", pub_state: "public", published_at: "2026-10-10T10:03:00Z", submitted_at: "2026-09-10T00:00:00Z", evidence: "计划" }]);
    expect(slotOf(doc, 2, "douyin")).toBeNull();
    expect(slotOf(doc, 1, "douyin")).toMatchObject({ pub_state: "public", item_id: "7123" });
  });


  it("[P2 nas-backup] 本体稿重开后再定时：备份按本轮发布时间判到点（publishedAt 还是上一轮的）", async () => {
    await enable();
    const { founderApprove } = await import("./testkit.js");
    const { reopenScript } = await import("./reopen.js");
    const { reconcileAll } = await import("./reconcile.js");
    const { withRoundPublishTime } = await import("../../storage/round-publish-time.js");
    const { backupCandidates } = await import("../../storage/nas-backup.js");
    const { getContent, updateContent } = await import("../../storage/local-store.js");
    const r = await registeredVideo(env);
    await founderDecision(r.id, "i_published", { platform: "douyin" }, env.dir);
    await reopenScript(r.id, env.dir);
    await founderApprove(env, r.id);
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await put(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify({ platforms: [{ platform: "douyin", publication: { status: "scheduled", scheduled_at: future, submitted_at: new Date(Date.now() + 1000).toISOString() } }] }));
    await reconcileAll(env.dir);
    await updateContent(r.id, { status: "published", publishedAt: "2026-09-01T00:00:00Z" } as never, env.dir);
    const c = await withRoundPublishTime((await getContent(r.id, env.dir))!, env.dir);
    expect(c.publishedAt).toBe(future);
    expect(backupCandidates([c], new Date())).toEqual([]);
  });

  it("[P2 my-content-published] 本体稿（record 出来的原片，没有旧交接）：已发布文件里有原片", async () => {
    await enable();
    const { publishedFiles } = await import("../../storage/my-content-published.js");
    const { getContent } = await import("../../storage/local-store.js");
    const r = await registeredVideo(env);
    const files = await publishedFiles((await getContent(r.id, env.dir))!, r.root, env.dir);
    expect(files.map((f) => f.name)).toContain("原片.mov");
  });
});

describe("seg12 归档口径", () => {
  async function publishedWithPlan(title?: string, pub: Record<string, unknown> = { status: "public", published_at: "2026-09-01T00:00:00Z", submitted_at: "2026-09-01T00:00:00Z" }) {
    await enable();
    const r = await registeredVideo(env, title);
    await put(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify({ platforms: [{ platform: "douyin", publication: pub }] }));
    const { reconcileAll } = await import("./reconcile.js");
    await reconcileAll(env.dir);
    return r;
  }

  it("[2] 本轮时间只认可信观察里真实的公开 / 定时时间：只有「我发了」或占位时间 → 定不出，归档列「待确认发布时间」、不归档也不备份", async () => {
    await enable();
    const { roundPublishTime, publishedSet } = await import("../../storage/round-publish-time.js");
    const { archiveCandidates } = await import("../../storage/nas-archive.js");
    const { backupCandidates } = await import("../../storage/nas-backup.js");
    const { getContent } = await import("../../storage/local-store.js");
    const r = await registeredVideo(env);
    await founderDecision(r.id, "i_published", { platform: "douyin" }, env.dir);
    // 旧形状回执：只有 at（排序占位会变成 1970）
    const { mutateProduction } = await import("./service.js");
    await mutateProduction(r.id, env.dir, (d) => { d.facts.push({ id: "legacy-pub", kind: "publish", round: d.round, state: "accepted", availability: "present", source: "reconcile", at: "2026-10-10T00:00:00Z", platform: "bilibili", pub_state: "public", verified: true, evidence: "发布计划里的记录" }); return { value: null, events: [] }; });
    const c = (await getContent(r.id, env.dir))!;
    expect(await roundPublishTime(c, env.dir)).toBeNull();
    const set = await publishedSet([c], env.dir, 0);
    expect(archiveCandidates(set, new Date("2026-12-01T00:00:00Z"))).toMatchObject({ due: [], unknown: [expect.objectContaining({ id: r.id })] });
    expect(backupCandidates(set.published, new Date("2026-12-01T00:00:00Z"))).toEqual([]);
  });

  it("[seg13 P2] 保留名单里定不出发布时间的也列进「待确认」，但仍不归档", async () => {
    await enable();
    const { publishedSet } = await import("../../storage/round-publish-time.js");
    const { archiveCandidates } = await import("../../storage/nas-archive.js");
    const { getContent } = await import("../../storage/local-store.js");
    const r = await registeredVideo(env);
    await founderDecision(r.id, "i_published", { platform: "douyin" }, env.dir);
    const set = await publishedSet([(await getContent(r.id, env.dir))!], env.dir);
    expect(set.keep.has(r.id)).toBe(true);
    const out = archiveCandidates(set, new Date("2026-12-01T00:00:00Z"));
    expect(out.due).toEqual([]);
    expect(out.unknown.map((c) => c.id)).toContain(r.id);
  });

  it("[seg13 P1] 实际提交时间只认 submitted_at：只有授权时间的计划条目不算提交过", async () => {
    const { parsePlatformEntry } = await import("../../storage/publish-record.js");
    const now = Date.parse("2026-10-01T00:00:00Z");
    const onlyAuth = parsePlatformEntry({ platform: "douyin", publication: { status: "public", published_at: "2026-09-30T10:00:00Z", authorized_at: "2026-09-30T09:00:00Z", authorization_at: "2026-09-30T09:00:00Z" } }, now);
    expect(onlyAuth?.submittedAt).toBeNull();
    const real = parsePlatformEntry({ platform: "douyin", publication: { status: "public", published_at: "2026-09-30T10:00:00Z", submitted_at: "2026-09-30T09:30:00Z", authorized_at: "2026-09-30T09:00:00Z" } }, now);
    expect(real?.submittedAt).toBe("2026-09-30T09:30:00Z");
  });

  it("[10-03] 抖音审核中但已定时：本轮发布时间取定时时间，不取提交时间；NAS 目录按定时的月份", async () => {
    const SUBMITTED = "2026-09-30T18:47:22+08:00", SCHEDULED = "2026-10-08T18:00:00+08:00";
    await enable();
    const r = await registeredVideo(env);
    // 修复前写下的错事实：审核中的抖音带着提交时间当发布时间
    const { mutateProduction } = await import("./service.js");
    await mutateProduction(r.id, env.dir, (d) => { d.facts.push({ id: "old-douyin", kind: "publish", round: d.round, state: "accepted", availability: "present", source: "reconcile", at: SUBMITTED, seen_at: "2026-10-01T00:00:00Z", obs_source: "plan", platform: "douyin", pub_state: "reviewing", verified: true, evidence: "发布计划里的记录", published_at: SUBMITTED }); return { value: null, events: [] }; });
    await put(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify({ platforms: [
      { platform: "douyin", publication: { status: "reviewing", submitted_at: SUBMITTED, scheduled_at: SCHEDULED } },
      ...["bilibili", "xiaohongshu", "wechat_video"].map((platform) => ({ platform, publication: { status: "scheduled", submitted_at: SUBMITTED, scheduled_at: SCHEDULED } })),
    ] }));
    const { reconcileAll } = await import("./reconcile.js");
    await reconcileAll(env.dir);
    const { roundPublishTime } = await import("../../storage/round-publish-time.js");
    const { archiveTarget } = await import("../../storage/nas-archive.js");
    const { getContent } = await import("../../storage/local-store.js");
    const c = (await getContent(r.id, env.dir))!;
    const at = await roundPublishTime(c, env.dir);
    expect(at && Date.parse(at)).toBe(Date.parse(SCHEDULED));
    const doc = (await readProductionDoc(r.id, env.dir))!;
    expect(doc.facts.filter((f) => f.kind === "publish" && f.platform === "douyin").at(-1)).toMatchObject({ pub_state: "reviewing", published_at: SCHEDULED });
    expect(archiveTarget("/nas", { ...c, publishedAt: at }, r.root)).toBe(path.join("/nas", "2026", "October", path.basename(r.root)));
  });

  it("[10-03] 审核中、没有定时：提交时间不算公开时间，只有它时本轮发布时间定不出（列「待确认发布时间」），有别的平台公开就取那个", async () => {
    const SUBMITTED = "2026-09-30T18:47:22+08:00";
    const { roundPublishTime } = await import("../../storage/round-publish-time.js");
    const { getContent } = await import("../../storage/local-store.js");
    const alone = await publishedWithPlan("只审核中", { status: "reviewing", submitted_at: SUBMITTED });
    expect(await roundPublishTime((await getContent(alone.id, env.dir))!, env.dir)).toBeNull();
    const r = await registeredVideo(env, "审核中加已公开");
    await put(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify({ platforms: [
      { platform: "douyin", publication: { status: "reviewing", submitted_at: SUBMITTED } },
      { platform: "bilibili", publication: { status: "public", submitted_at: SUBMITTED, published_at: "2026-10-02T09:00:00+08:00" } },
    ] }));
    const { reconcileAll } = await import("./reconcile.js");
    await reconcileAll(env.dir);
    const at = await roundPublishTime((await getContent(r.id, env.dir))!, env.dir);
    expect(at && Date.parse(at)).toBe(Date.parse("2026-10-02T09:00:00+08:00"));
  });

  it("[10-03 Codex P2] 重开后审核中、没定时的新提交：没有公开时间也要进新一轮，不被当成旧记录去重", async () => {
    const { emptyProductionDoc } = await import("../../storage/production-types.js");
    const { importObservations, slotOf } = await import("./receipts.js");
    const doc = emptyProductionDoc();
    importObservations(doc, [{ source: "plan", platform: "douyin", pub_state: "reviewing", submitted_at: "2026-09-10T00:00:00Z", evidence: "发布计划里的记录" }]);
    doc.decisions.push({ id: "r1", type: "reopen", round: 1, at: "2026-09-20T00:00:00Z", source: "founder" });
    doc.round = 2;
    importObservations(doc, [{ source: "plan", platform: "douyin", pub_state: "reviewing", submitted_at: "2026-09-25T00:00:00Z", evidence: "发布计划里的记录" }]);
    expect(slotOf(doc, 2, "douyin")).toMatchObject({ pub_state: "reviewing" });
  });

  it("[10-03 Codex P2] 纠正过的旧形状审核中回执：修复后只是时间变了，纠正照旧有效（提交 / 核实时间、按槽 / 按事实 id 的纠正都算）", async () => {
    const { emptyProductionDoc } = await import("../../storage/production-types.js");
    const { importObservations, slotOf } = await import("./receipts.js");
    const SUBMITTED = "2026-09-30T18:47:22+08:00", SCHEDULED = "2026-10-08T18:00:00+08:00";
    const cases = [
      { evidence: { submitted_at: SUBMITTED }, target: (_id: string) => "slot:1:douyin" },
      { evidence: {}, target: (id: string) => id },
    ];
    for (const { evidence, target } of cases) for (const scheduled of [SCHEDULED, undefined]) {
      const doc = emptyProductionDoc();
      // 旧版写下的事实：发布时间 = 当时的证据时间，没存提交时间
      doc.facts.push({ id: "old", kind: "publish", round: 1, state: "accepted", availability: "present", source: "reconcile", at: SUBMITTED, seen_at: "2026-10-01T00:00:00Z", obs_source: "plan", platform: "douyin", pub_state: "reviewing", verified: true, evidence: "发布计划里的记录", published_at: SUBMITTED });
      doc.decisions.push({ id: "c1", type: "publish_correction", round: 1, target_id: target("old"), at: "2026-10-02T00:00:00Z", source: "founder" });
      expect(slotOf(doc, 1, "douyin")).toBeNull();
      const plan = { source: "plan" as const, platform: "douyin", pub_state: "reviewing" as const, evidence: "发布计划里的记录", evidence_at: SUBMITTED, ...evidence, ...(scheduled ? { published_at: scheduled } : {}) };
      importObservations(doc, [plan]);
      importObservations(doc, [plan]);
      expect(slotOf(doc, 1, "douyin")).toBeNull();
      // 真正的新状态照旧算新证据
      expect(importObservations(doc, [{ ...plan, pub_state: "public", published_at: SCHEDULED }])).toBe(1);
    }
  });

  it("[10-03 Codex P2] 旧形状回执的纯时间迁移不越过后来的其它来源：数据回流的已公开仍是当前状态", async () => {
    const { emptyProductionDoc } = await import("../../storage/production-types.js");
    const { importObservations, slotOf } = await import("./receipts.js");
    const SUBMITTED = "2026-09-30T18:47:22+08:00";
    // 第二组：旧形状没有观察时间（都按 1970 排，只剩写入顺序）
    for (const [planSeen, metricsSeen] of [["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"], [undefined, undefined]]) {
      const doc = emptyProductionDoc();
      doc.facts.push({ id: "old", kind: "publish", round: 1, state: "accepted", availability: "present", source: "reconcile", at: SUBMITTED, ...(planSeen ? { seen_at: planSeen } : {}), obs_source: "plan", platform: "douyin", pub_state: "rejected", verified: true, evidence: "发布计划里的记录", published_at: SUBMITTED });
      doc.facts.push({ id: "metrics", kind: "publish", round: 1, state: "accepted", availability: "present", source: "reconcile", at: "2026-10-02T00:00:00Z", ...(metricsSeen ? { seen_at: metricsSeen } : {}), obs_source: "metrics_id", platform: "douyin", item_id: "7123", pub_state: "public", verified: true, evidence: "数据回流按作品 id 对上了这条" });
      importObservations(doc, [{ source: "plan", platform: "douyin", pub_state: "rejected", evidence: "发布计划里的记录", submitted_at: SUBMITTED, evidence_at: SUBMITTED }]);
      expect(slotOf(doc, 1, "douyin")).toMatchObject({ pub_state: "public", fact_id: "metrics" });
      expect(doc.facts).toHaveLength(2);
      expect(doc.facts[0]).toMatchObject({ id: "old", submitted_at: SUBMITTED });
      expect(doc.facts[0].published_at).toBeUndefined();
    }
  });

  it("[10-03 Codex P2] 同一轮、没定时的审核中重新提交：只有提交时间变了也算新回执，纠正后能重新出现", async () => {
    const { emptyProductionDoc } = await import("../../storage/production-types.js");
    const { importObservations, slotOf } = await import("./receipts.js");
    const doc = emptyProductionDoc();
    const base = { source: "plan" as const, platform: "douyin", pub_state: "reviewing" as const, evidence: "发布计划里的记录" };
    importObservations(doc, [{ ...base, submitted_at: "2026-09-30T10:00:00Z", evidence_at: "2026-09-30T10:00:00Z" }]);
    doc.decisions.push({ id: "c1", type: "publish_correction", round: 1, target_id: "slot:1:douyin", at: new Date(Date.now() + 1000).toISOString(), source: "founder" });
    expect(importObservations(doc, [{ ...base, submitted_at: "2026-09-30T10:00:00Z", evidence_at: "2026-09-30T10:00:00Z" }])).toBe(0);
    await new Promise((r) => setTimeout(r, 1100));
    expect(importObservations(doc, [{ ...base, submitted_at: "2026-10-02T10:00:00Z", evidence_at: "2026-10-02T10:00:00Z" }])).toBe(1);
    expect(slotOf(doc, 1, "douyin")).toMatchObject({ pub_state: "reviewing" });
  });

  it("[10-03 Codex P2] 上一条既没有公开时间也没有提交时间，新计划带上提交时间：算新提交，纠正后能重新出现", async () => {
    const { emptyProductionDoc } = await import("../../storage/production-types.js");
    const { importObservations, slotOf } = await import("./receipts.js");
    const doc = emptyProductionDoc();
    const base = { source: "plan" as const, platform: "douyin", pub_state: "reviewing" as const, evidence: "发布计划里的记录" };
    importObservations(doc, [base]);
    doc.decisions.push({ id: "c1", type: "publish_correction", round: 1, target_id: "slot:1:douyin", at: new Date(Date.now() + 1000).toISOString(), source: "founder" });
    await new Promise((r) => setTimeout(r, 1100));
    expect(importObservations(doc, [{ ...base, submitted_at: "2026-10-02T10:00:00Z", evidence_at: "2026-10-02T10:00:00Z" }])).toBe(1);
    expect(slotOf(doc, 1, "douyin")).toMatchObject({ pub_state: "reviewing" });
  });

  it("[10-03 Codex P2] 审核中只有核实时间、有定时：发布时间取定时，把关证据仍取核实时间", async () => {
    const { parsePlatformEntry } = await import("../../storage/publish-record.js");
    const p = parsePlatformEntry({ platform: "douyin", publication: { status: "reviewing", verified_at: "2026-09-01T00:00:00Z", scheduled_at: "2026-10-08T10:00:00Z" } }, Date.parse("2026-10-03T00:00:00Z"));
    expect(p).toMatchObject({ time: "2026-10-08T10:00:00Z", evidenceAt: "2026-09-01T00:00:00Z", submittedAt: null });
  });

  it("[3] 视图与归档同一份保留名单：视图显示的就是 keep，归档候选与它不相交", async () => {
    const a = await publishedWithPlan();
    const { publishedSet } = await import("../../storage/round-publish-time.js");
    const { archiveCandidates } = await import("../../storage/nas-archive.js");
    const { listContents } = await import("../../storage/local-store.js");
    const set = await publishedSet(await listContents(env.dir), env.dir, 1);
    expect([...set.keep]).toEqual([a.id]);
    expect(archiveCandidates(set, new Date("2026-12-01T00:00:00Z")).due.map((c) => c.id)).not.toContain(a.id);
    const { buildPlan } = await import("../../storage/my-content-plan.js");
    const plan = await buildPlan(env.dir, 1);
    expect(Object.values(plan.dirs)).toContain(a.id);
  });

  it("[4] 一条稿的 production.json 坏了：只跳过它，别的已发布稿照常进名单", async () => {
    const good = await publishedWithPlan();
    const bad = await videoContent(env, "坏草稿");
    const { productionFile } = await import("../../storage/production-store.js");
    const file = productionFile(bad.id, env.dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json");
    const { publishedSet } = await import("../../storage/round-publish-time.js");
    const { listContents, getContent, updateContent } = await import("../../storage/local-store.js");
    await updateContent(bad.id, { status: "published" } as never, env.dir);
    const set = await publishedSet(await listContents(env.dir), env.dir);
    expect(set.published.map((c) => c.id)).toContain(good.id);
    expect((await getContent(bad.id, env.dir))).toBeTruthy();
  });
});
