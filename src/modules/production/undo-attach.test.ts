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
import { reconcileAll } from "./reconcile.js";
import { recoverTxns, saveTxn } from "./txn.js";
import { CHATCUT_USES, IN_EDIT } from "./undo-attach.js";
import { exists, founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const A = "甲稿的正文，讲一件事。".repeat(40), B = "乙稿的正文，讲另一件事。".repeat(40);
const decide = (id: string, action: string, params: Record<string, unknown>) => founderDecision(id, action, params, env.dir) as Promise<Record<string, unknown>>;
async function aroll(id: string): Promise<Fact> {
  const d = await readProductionDocOrEmpty(id, env.dir);
  return d.facts.find((f) => f.kind === "aroll" && f.round === d.round)!;
}

/**
 * 停用前「从收件箱自动挂上」的旧数据（手动收件 spec 2026-10-06 规则 5）：收件箱原片挂进项目，再补上旧版自动挂上的标记。
 * → 剪辑中、正文冻结。
 */
async function markAutoAttached(id: string): Promise<void> {
  const { withFileOwnership } = await import("./mutex.js");
  const { mutateProduction } = await import("./service.js");
  await withFileOwnership(() => mutateProduction(id, env.dir, (doc) => {
    Object.assign(doc.facts.find((f) => f.kind === "aroll" && f.round === doc.round && f.state === "accepted")!, { auto_attached: true, source: "reconcile" });
    return { value: null, events: [] };
  }));
}

async function autoAttached(fileName = "IMG_7.mov"): Promise<{ id: string; src: string; fact: Fact }> {
  const a = await videoContent(env, "甲稿撤销测试", "draft_ready", A);
  await founderApprove(env, a.id);
  const src = await put(path.join(env.inbox, fileName), "take");
  expect(await decide(a.id, "attach_aroll", { path: src, confirm_other: true })).toMatchObject({ ok: true });
  await markAutoAttached(a.id);
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
    // 巡检不会把挪回收件箱的原片再挂回来（B10；手动收件后巡检根本不看收件箱）
    await reconcileAll(env.dir);
    expect((await aroll(id)).state).toBe("rejected");
    expect(await exists(src)).toBe(true);
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
    expect((await cardPanel(other.id, env.dir)).arolls).toEqual([expect.objectContaining({ undo_blocked: IN_EDIT })]);
  });

  it("创始人在卡片上挂的原片也能点「不是」：挪回原处（1b 验收：自己挂的，撤回是自己的事）", async () => {
    const a = await videoContent(env, "甲稿人挂测试", "draft_ready", A);
    await founderApprove(env, a.id);
    const r = await decide(a.id, "attach_aroll", { path: await put(path.join(env.outside, "x.mov"), "x") });
    const f = await aroll(a.id);
    expect(r).toMatchObject({ ok: true });
    expect(await decide(a.id, "undo_auto_attach", { fact_id: f.id, sha256: f.sha256 })).toMatchObject({ ok: true, moved_to: path.join(env.outside, "x.mov") });
  });

  it("项目里的原片挂上之后被改过 → 拒，什么都不动：文件还在项目里、事实仍 accepted、不留事务日志（Codex 审 segB3 P1）", async () => {
    const { id, src, fact } = await autoAttached();
    const inProject = path.join(projectRoot(env, id), fact.path!);
    await put(inProject, "edited-after-attach");
    const r = await decide(id, "undo_auto_attach", { fact_id: fact.id, sha256: fact.sha256 });
    expect(r).toMatchObject({ ok: false, error: "项目里的原片在挂上之后被改过，不能自动撤销；要换原片请重开文稿" });
    expect(await fs.readFile(inProject, "utf8")).toBe("edited-after-attach");
    expect(await exists(src)).toBe(false);
    expect((await aroll(id)).state).toBe("accepted");
    expect(await fs.readdir(path.join(env.dir, "production", "txns")).catch(() => [])).toEqual([]);
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
  const b = await videoContent(env, "乙稿撤销测试", "draft_ready", B);
  await founderApprove(env, b.id);
  await decide(b.id, "attach_aroll", { path: await put(path.join(env.inbox, "IMG_8.mov"), "take-b"), confirm_other: true });
  await markAutoAttached(b.id);
  return { id: b.id, fact: await aroll(b.id) };
}

describe("「不是」也能撤创始人自己确认的原片（1b 验收）", () => {
  it("从项目外确认进来的原片：同一个 §4.1 事务挪回原处、拒事实、解冻；面板行写明来源", async () => {
    const watch = path.join(env.outside, "downloads");
    await fs.mkdir(watch);
    const a = await videoContent(env, "甲稿确认后撤回", "draft_ready", A);
    await founderApprove(env, a.id);
    const src = await put(path.join(watch, "IMG_0421.MOV"), "confirmed");
    const { withFileOwnership } = await import("./mutex.js");
    const { mutateProduction } = await import("./service.js");
    const { cachedSha } = await import("./observe.js");
    const h = await cachedSha(src);
    await withFileOwnership(() => mutateProduction(a.id, env.dir, (doc) => {
      doc.facts.push({ id: "fact-watch-1", kind: "aroll", round: doc.round, state: "candidate", availability: "present", source: "reconcile", at: new Date().toISOString(), path: src, sha256: h.sha256, size: h.size, mtime_ms: h.mtime_ms, evidence: "对账发现" });
      return { value: null, events: [] };
    }));
    expect(await decide(a.id, "confirm_candidate", { fact_id: "fact-watch-1", sha256: h.sha256 })).toMatchObject({ ok: true, state: "accepted" });
    expect(await exists(src)).toBe(false);
    const row = ((await cardPanel(a.id, env.dir)).arolls as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ name: "IMG_0421.MOV", origin: "你确认的", undo_blocked: null });
    const r = await decide(a.id, "undo_auto_attach", { fact_id: "fact-watch-1", sha256: h.sha256 });
    expect(r).toMatchObject({ ok: true, moved_to: src, stage: "待录制" });
    expect(await fs.readFile(src, "utf8")).toBe("confirmed");
    const doc = await readProductionDocOrEmpty(a.id, env.dir);
    expect(doc.facts.find((f) => f.id === "fact-watch-1")?.state).toBe("rejected");
    expect(doc.frozen).toBeNull();
  });
});
