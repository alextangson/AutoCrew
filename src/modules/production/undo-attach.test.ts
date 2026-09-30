/** 撤销自动挂上（1b §4.1，B8 / B9 / B30 / B31）与卡片挂载核对 + 改挂（§7） */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContent } from "../../storage/local-store.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact } from "../../storage/production-types.js";
import { cardPanel } from "./panel.js";
import { founderDecision } from "./decisions.js";
import { explainContent } from "./read.js";
import { setMatchDeps } from "./match/deps.js";
import { matchWorkerIdle } from "./match/queue.js";
import type { TranscribeOutcome } from "./match/transcribe.js";
import { synth } from "./match/synth-fixture.js";
import { reconcileAll } from "./reconcile.js";
import { recoverTxns, saveTxn } from "./txn.js";
import { CHATCUT_USES, IN_EDIT, IN_EDIT_REASSIGN } from "./undo-attach.js";
import { exists, founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await matchWorkerIdle(env.dir); await env.cleanup(); });

const A = synth(31, 500), B = synth(32, 500);
function asr(answer: (f: string) => TranscribeOutcome, notReady: string | null = null): void {
  setMatchDeps({ thresholds: { calibrated: true, floor: 0.3, margin: 0.2 }, transcriber: { notReady: async () => notReady, transcribe: async (f) => answer(f) } });
}
const decide = (id: string, action: string, params: Record<string, unknown>) => founderDecision(id, action, params, env.dir) as Promise<Record<string, unknown>>;
async function aroll(id: string): Promise<Fact> {
  const d = await readProductionDocOrEmpty(id, env.dir);
  return d.facts.find((f) => f.kind === "aroll" && f.round === d.round)!;
}

/** 认过稿的甲稿，从收件箱自动挂上一段原片 → 剪辑中、正文冻结 */
async function autoAttached(fileName = "IMG_7.mov"): Promise<{ id: string; src: string; fact: Fact }> {
  asr(() => ({ ok: true, text: A.slice(20, 160) }));
  const a = await videoContent(env, "甲稿撤销测试", "draft_ready", A);
  await founderApprove(env, a.id);
  const src = await put(path.join(env.inbox, fileName), "take");
  await reconcileAll(env.dir);
  await matchWorkerIdle(env.dir);
  await reconcileAll(env.dir);
  const fact = await aroll(a.id);
  expect(fact).toMatchObject({ state: "accepted", auto_attached: true });
  expect((await readProductionDocOrEmpty(a.id, env.dir)).frozen).toBeTruthy();
  return { id: a.id, src, fact };
}

describe("§4.1 「不是这条」撤销自动挂上", () => {
  it("挪回原处原名、事实转 rejected、解冻、回待录制；决定持久、时间线可见（B8）", async () => {
    const { id, src, fact } = await autoAttached();
    const r = await decide(id, "undo_auto_attach", { fact_id: fact.id, sha256: fact.sha256 });
    expect(r).toMatchObject({ ok: true, moved_to: src, stage: "待录制" });
    expect(await fs.readFile(src, "utf8")).toBe("take");
    const doc = await readProductionDocOrEmpty(id, env.dir);
    expect(doc.frozen).toBeNull();
    expect(doc.facts[0]).toMatchObject({ state: "rejected", path: src });
    expect(doc.decisions.some((d) => d.type === "auto_attach_undo")).toBe(true);
    expect((await getContent(id, env.dir))!.status).toBe("approved");
    // 点过「不是这条」的字节不再自动挪回来（B10）
    await reconcileAll(env.dir);
    expect((await aroll(id)).state).toBe("rejected");
  });

  it("原名被占 → 加 -2 后缀并在回执里说（B9）；原目录没了 → 挪回收件箱（B31）", async () => {
    const { id, src, fact } = await autoAttached();
    await put(src, "someone-else");
    const r = await decide(id, "undo_auto_attach", { fact_id: fact.id, sha256: fact.sha256 });
    expect(r).toMatchObject({ ok: true, moved_to: path.join(env.inbox, "IMG_7-2.mov") });
    expect(String(r.note)).toContain("原名被占");
    expect(await fs.readFile(src, "utf8")).toBe("someone-else");
  });

  it("原目录已不在 → 挪回收件箱并告知", async () => {
    const { id, fact } = await autoAttached();
    const d = await readProductionDocOrEmpty(id, env.dir);
    const gone = path.join(env.outside, "gone", "IMG_7.mov");
    d.facts[0].source_path = gone;
    await fs.writeFile(path.join(projectRoot(env, id), "00-project/autocrew/production.json"), JSON.stringify(d));
    const r = await decide(id, "undo_auto_attach", { fact_id: fact.id, sha256: fact.sha256 });
    expect(r).toMatchObject({ ok: true, moved_to: path.join(env.inbox, "IMG_7.mov") });
    expect(String(r.note)).toContain("收件箱");
  });

  it("被 ChatCut 工程引用 / 已有成片（推导回不到待录制）→ 拒并指路（B30）", async () => {
    const { id, fact } = await autoAttached();
    await record(env, { content_id: id, kind: "chatcut_project", chatcut_project_id: "p1", uses_aroll: [fact.id], request_id: "cc" });
    expect(await decide(id, "undo_auto_attach", { fact_id: fact.id, sha256: fact.sha256 })).toMatchObject({ ok: false, error: CHATCUT_USES });
    const other = await autoAttachedSecond();
    await put(path.join(projectRoot(env, other.id), "04-edit/final.mp4"), "cut");
    await record(env, { content_id: other.id, kind: "cut", path: path.join(projectRoot(env, other.id), "04-edit/final.mp4"), request_id: "c1" });
    expect(await decide(other.id, "undo_auto_attach", { fact_id: other.fact.id, sha256: other.fact.sha256 })).toMatchObject({ ok: false, error: IN_EDIT });
    expect((await cardPanel(other.id, env.dir)).arolls).toEqual([expect.objectContaining({ undo_blocked: IN_EDIT, reassign_blocked: IN_EDIT_REASSIGN })]);
  });

  it("人确认挂上的原片不走这条（只撤系统自己挂错的）", async () => {
    asr(() => ({ ok: true, text: A.slice(0, 100) }));
    const a = await videoContent(env, "甲稿人挂测试", "draft_ready", A);
    await founderApprove(env, a.id);
    const r = await decide(a.id, "attach_aroll", { path: await put(path.join(env.outside, "x.mov"), "x") });
    const f = await aroll(a.id);
    expect(r).toMatchObject({ ok: true });
    expect(await decide(a.id, "undo_auto_attach", { fact_id: f.id, sha256: f.sha256 })).toMatchObject({ ok: false, code: "not_auto" });
  });

  it("挪回之后、提交之前崩了：重启恢复按事务日志把原片放回项目", async () => {
    const { id, fact } = await autoAttached();
    const inProject = path.join(projectRoot(env, id), fact.path!);
    const outside = path.join(env.outside, "half.mov");
    await fs.rename(inProject, outside);
    await saveTxn(env.dir, { id: "txn-crash-1", kind: "undo", content_id: id, round: 1, at: "x", ops: [{ op: "move", source: inProject, target: outside, sha256: fact.sha256!, step: "placed" }] });
    const out = await recoverTxns(env.dir);
    expect(out).toEqual([expect.objectContaining({ id: "txn-crash-1", outcome: "rolled_back" })]);
    expect(await exists(inProject)).toBe(true);
    expect(await exists(outside)).toBe(false);
  });
});

async function autoAttachedSecond(): Promise<{ id: string; fact: Fact }> {
  asr(() => ({ ok: true, text: B.slice(20, 160) }));
  const b = await videoContent(env, "乙稿撤销测试", "draft_ready", B);
  await founderApprove(env, b.id);
  await put(path.join(env.inbox, "IMG_8.mov"), "take-b");
  await reconcileAll(env.dir);
  await matchWorkerIdle(env.dir);
  await reconcileAll(env.dir);
  return { id: b.id, fact: await aroll(b.id) };
}

describe("§7 卡片挂载核对 + 改挂", () => {
  async function attachToWrong(): Promise<{ a: string; b: string; fact: Fact }> {
    asr(() => ({ ok: true, text: B.slice(20, 160) }));
    const a = await videoContent(env, "甲稿挂载核对", "draft_ready", A);
    const b = await videoContent(env, "乙稿挂载核对", "draft_ready", B);
    await founderApprove(env, a.id);
    expect(await decide(a.id, "attach_aroll", { path: await put(path.join(env.outside, "take.mov"), "tk") })).toMatchObject({ ok: true });
    await matchWorkerIdle(env.dir);
    return { a: a.id, b: b.id, fact: await aroll(a.id) };
  }

  it("听起来更像别条 → 卡片 badge 与两个按钮的数据；「就是这条」记住不再提示", async () => {
    const { a, fact } = await attachToWrong();
    expect(fact.attach_check).toMatchObject({ status: "suggest", other_title: "乙稿挂载核对" });
    expect((await explainContent((await getContent(a, env.dir))!, env.dir)).badges).toContain("这段原片听起来更像《乙稿挂载核对》");
    expect(await decide(a, "keep_attach", { fact_id: fact.id, sha256: fact.sha256 })).toMatchObject({ ok: true });
    expect((await aroll(a)).attach_check?.status).toBe("kept");
    expect((await explainContent((await getContent(a, env.dir))!, env.dir)).badges.join()).not.toContain("更像");
  });

  it("「改挂到《X》」：这条撤下（不挪回原处），同一事务收进《X》并改名；这条回待录制", async () => {
    const { a, b, fact } = await attachToWrong();
    const r = await decide(a, "reassign_aroll", { fact_id: fact.id, sha256: fact.sha256, to: b });
    expect(r).toMatchObject({ ok: true, reassigned_to: b, path: "02-aroll/乙稿挂载核对-原片.mov" });
    expect(await aroll(a)).toMatchObject({ state: "rejected", released_to: b });
    expect(await aroll(b)).toMatchObject({ state: "accepted", sha256: fact.sha256 });
    expect(await exists(path.join(projectRoot(env, b), "02-aroll/乙稿挂载核对-原片.mov"))).toBe(true);
    expect(await exists(path.join(env.outside, "take.mov"))).toBe(false);
    expect((await readProductionDocOrEmpty(a, env.dir)).frozen).toBeNull();
    expect((await getContent(a, env.dir))!.status).toBe("approved");
  });

  it("已经在剪（有成片）→ 改挂被拒，说先重开文稿", async () => {
    const { a, b, fact } = await attachToWrong();
    await put(path.join(projectRoot(env, a), "04-edit/final.mp4"), "cut");
    await record(env, { content_id: a, kind: "cut", path: path.join(projectRoot(env, a), "04-edit/final.mp4"), request_id: "c1" });
    expect(await decide(a, "reassign_aroll", { fact_id: fact.id, sha256: fact.sha256, to: b })).toMatchObject({ ok: false, error: IN_EDIT_REASSIGN });
  });

  it("文件名对上这条、转写却明显是别条 → 仍提示更像别条（按转写分数判，不被文件名短路；Codex 审 segB P2）", async () => {
    asr(() => ({ ok: true, text: B.slice(20, 160) }));
    const a = await videoContent(env, "甲稿文件名陷阱", "draft_ready", A);
    await videoContent(env, "乙稿文件名陷阱", "draft_ready", B);
    await founderApprove(env, a.id);
    await decide(a.id, "attach_aroll", { path: await put(path.join(env.outside, "甲稿文件名陷阱.mov"), "trap") });
    await matchWorkerIdle(env.dir);
    expect((await aroll(a.id)).attach_check).toMatchObject({ status: "suggest", other_title: "乙稿文件名陷阱" });
  });

  it("转写没就绪 → 卡片小字「没做内容核对：转写环境没装好…」", async () => {
    asr(() => ({ ok: true, text: "" }), "ASR 依赖环境还没装好");
    const a = await videoContent(env, "甲稿没就绪核对", "draft_ready", A);
    await founderApprove(env, a.id);
    await decide(a.id, "attach_aroll", { path: await put(path.join(env.outside, "t.mov"), "t") });
    await matchWorkerIdle(env.dir);
    const badges = (await explainContent((await getContent(a.id, env.dir))!, env.dir)).badges.join();
    expect(badges).toContain("没做内容核对");
    expect(badges).toContain("转写环境没装好");
  });
});
