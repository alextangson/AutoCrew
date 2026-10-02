/**
 * 对账（§4）、影子模式与启用（§4.1）、事务恢复（§7）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, updateContent } from "../../storage/local-store.js";
import { isOntologyEnabled, productionFile, readProductionDoc, writeEnabledVersion } from "../../storage/production-store.js";
import { appendArchiveLog } from "../../storage/nas-archive-log.js";
import { boardData } from "../../desktop/board-data.js";
import { setMoveOps } from "../video/handoff/aroll-move.js";
import { enableOntology } from "./enable.js";
import { reconcileAll, readReconcileReport } from "./reconcile.js";
import { recoverTxns, saveTxn } from "./txn.js";
import { resetProductionReady } from "./service.js";
import { sha256File } from "../video/handoff/manifest.js";
import { draftHash } from "../../storage/draft-hash.js";
import { exists, founderApprove, makeEnv, setContent, png, projectRoot, put, record, SRT, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv(); });
afterEach(async () => { setMoveOps(null); await env.cleanup(); });

const TITLE = "AI 又忘了怎么办";

/** 一条「场外剪好」的稿：项目里有原片、成片 + 同名字幕、两张封面（v001 带清单、exports 里没清单） */
async function editedOffsite(status: "approved" | "draft_ready" | "editing" | "published" = "approved") {
  const c = await videoContent(env, TITLE, status);
  const root = projectRoot(env, c.id);
  await put(path.join(root, "02-aroll/原片.mov"), "raw");
  await put(path.join(root, "07-delivery/export/final.mp4"), "cut");
  await put(path.join(root, "07-delivery/export/final.srt"), SRT);
  await put(path.join(root, "05-cover/v001/a.png"), png(900, 1200));
  await fs.writeFile(path.join(root, "05-cover/v001/cover-manifest.json"), JSON.stringify({ outputs: [{ path: "/somewhere/else/a.png" }] }));
  await put(path.join(root, "05-cover/exports/b.png"), png(1200, 900));
  return c;
}

describe("影子模式（§4.1）：只算不写，给差异清单", () => {
  it("未启用：对账不写 production.json、不改状态；报告里给「要挪」的卡与依据", async () => {
    const c = await editedOffsite("approved");
    const metaBefore = (await getContent(c.id, env.dir))!;
    const report = await reconcileAll(env.dir);
    expect(report.enabled).toBe(false);
    expect(await exists(productionFile(c.id, env.dir))).toBe(false);
    expect((await getContent(c.id, env.dir))!.updatedAt).toBe(metaBefore.updatedAt);
    expect(report.moves).toEqual([expect.objectContaining({ id: c.id, from: "待录制", to: "剪辑中", rule: "D4" })]);
    expect(report.moves[0].evidence.length).toBeGreaterThan(0);
    expect(await readReconcileReport(env.dir)).toMatchObject({ moves: [{ id: c.id }] });
  });

  it("写稿段稿件项目里已有 A-roll：影子里仍写稿中 + badge（z265zp 形状），不算要挪", async () => {
    await editedOffsite("draft_ready");
    const report = await reconcileAll(env.dir);
    expect(report.moves).toEqual([]);
  });

  it("启用：原子切换——导入旧事实、补等价决定、投影状态、写启用版本；再对账没有要挪的", async () => {
    const c = await editedOffsite("approved");
    const r = await enableOntology(env.dir);
    expect(r).toMatchObject({ ok: true, errors: [] });
    expect(await isOntologyEnabled(env.dir)).toBe(true);
    expect((await getContent(c.id, env.dir))!.status).toBe("editing");
    const doc = (await readProductionDoc(c.id, env.dir))!;
    expect(doc.decisions).toMatchObject([{ type: "script_approval", source: "legacy" }]);
    expect(doc.facts.map((f) => f.kind).sort()).toEqual(["aroll", "cover", "cover", "cut", "srt"]);
    expect(doc.facts.find((f) => f.kind === "srt")!.for_cut).toBe(doc.facts.find((f) => f.kind === "cut")!.sha256);
    const board = await boardData(env.dir);
    expect(board.items.find((i) => i.id === c.id)).toMatchObject({ column: "剪辑中", missing: ["封面(4:3)"] }); // 对账收的导出不算待审；exports/ 里的图只做候选（review-inbox §6.2、§7-1）
    expect((await reconcileAll(env.dir)).moves).toEqual([]);
  });

  it("[Codex P1 derive.ts:94] 旧登记缺 approvals.json 批准：不借 legacy 登记进待发布，卡上说要重新通过", async () => {
    const reg = await videoContent(env, "已登记的稿", "publish_ready", undefined, { video: { final: { sha256: "c".repeat(64), asset_filename: "final.mp4", covers: { "3:4": "a", "4:3": "b" } } } as never });
    await put(path.join(projectRoot(env, reg.id), "02-aroll/raw.mov"), "raw");
    const report = await reconcileAll(env.dir);
    expect(report.moves.find((m) => m.id === reg.id)).toMatchObject({ from: "待发布", to: "剪辑中" });
    expect(report.moves.find((m) => m.id === reg.id)!.evidence.join("")).toContain("旧登记没迁移");
    expect((await enableOntology(env.dir)).ok).toBe(true);
    expect((await getContent(reg.id, env.dir))!.status).toBe("editing");
  });

  it.each(["none", "stale_draft"] as const)("[Codex seg2 P1 legacy.ts:52] 旧批准没绑到这次登记 / 批准后稿改过（%s）：不迁移，不进待发布", async (bindings) => {
    const reg = await legacyRegistered({ bindings });
    expect((await enableOntology(env.dir)).ok).toBe(true);
    expect((await getContent(reg.id, env.dir))!.status).toBe("editing");
    expect((await readProductionDoc(reg.id, env.dir))!.registrations).toEqual([]);
  });

  it("旧登记带齐创始人 gate3/gate4 批准 + 字幕、字节都对：迁成完整的 legacy 组合，留在待发布；新批准顶掉它", async () => {
    const reg = await legacyRegistered();
    const pub = await videoContent(env, "已发布的稿", "published");
    const arc = await videoContent(env, "归档的稿", "archived");
    expect((await reconcileAll(env.dir)).moves.find((m) => m.id === reg.id)).toBeUndefined();
    expect((await enableOntology(env.dir)).ok).toBe(true);
    expect((await getContent(reg.id, env.dir))!.status).toBe("publish_ready");
    const doc = (await readProductionDoc(reg.id, env.dir))!;
    expect(doc.registrations).toMatchObject([{ source: "legacy", cover_text: "AI 又忘了？" }]);
    expect((await getContent(pub.id, env.dir))!.status).toBe("published");
    expect((await getContent(arc.id, env.dir))!.status).toBe("archived");
  });

  it("旧 cover_pending 按推导重算", async () => {
    const c = await videoContent(env, TITLE, "cover_pending");
    await put(path.join(projectRoot(env, c.id), "07-delivery/export/final.mp4"), "cut");
    await enableOntology(env.dir);
    expect((await getContent(c.id, env.dir))!.status).toBe("editing");
  });
});

/** 一条旧库里「已登记」的稿：registered 成片 + 选中的两张封面 + 字幕 + approvals.json / cover-selection / decisions.json */
async function legacyRegistered(opts: { bindings?: "ok" | "none" | "stale_draft" } = {}) {
  const c = await videoContent(env, "已登记的稿", "approved");
  const root = projectRoot(env, c.id);
  const cut = await put(path.join(root, "07-delivery/registered/final-g1.mp4"), "registered-cut");
  const c34 = await put(path.join(root, "05-cover/v001/a.png"), png(900, 1200, "a"));
  const c43 = await put(path.join(root, "05-cover/v001/b.png"), png(1200, 900, "b"));
  const srt = await put(path.join(root, "04-edit/final.srt"), SRT);
  const [sCut, s34, s43] = [await sha256File(cut), await sha256File(c34), await sha256File(c43)];
  const auto = path.join(root, "00-project/autocrew");
  const { coverPairHash } = await import("../video/handoff/manifest.js");
  const dh = draftHash({ title: c.title, body: c.body, platform: c.platform });
  const bind = { generation: 1, manifest_hash: "m1", draft_hash: opts.bindings === "stale_draft" ? "0".repeat(64) : dh };
  const bindings = (opts.bindings ?? "ok") === "none" ? {} : { final_cut: bind, covers: bind };
  await fs.writeFile(path.join(auto, "approvals.json"), JSON.stringify({ schema: 2, source: "founder-workbench", bindings, rejections: [],
    final_cut: { artifact_sha256: sCut, approved_at: "x", user_message: "" }, covers: { artifact_sha256: coverPairHash(s34, s43), approved_at: "x", user_message: "" } }));
  await fs.writeFile(path.join(auto, "cover-selection.json"), JSON.stringify({ "3:4": { sha256: s34, path: "05-cover/v001/a.png", selected_at: "x" }, "4:3": { sha256: s43, path: "05-cover/v001/b.png", selected_at: "x" } }));
  await fs.writeFile(path.join(auto, "decisions.json"), JSON.stringify({ cover_text: "AI 又忘了？" }));
  return setContent(env, c.id, { status: "publish_ready", video: { final: { sha256: sCut, asset_filename: "final-g1.mp4", srt_path: srt, covers: { "3:4": c34, "4:3": c43 }, generation: 1, manifest_hash: "m1" } } as never });
}

describe("对账（§4）：启用之后", () => {
  it("旧存法导入：execution.json 报到的产物、meta.assets 的封面附件（source=legacy）", async () => {
    const c = await videoContent(env, TITLE, "approved");
    await enableOntology(env.dir);
    const root = projectRoot(env, c.id);
    await put(path.join(root, "04-edit/rough.mp4"), "rough");
    await fs.writeFile(path.join(root, "00-project/autocrew/execution.json"), JSON.stringify({ schema: 2, generation: 1, session_id: "s", machine: "m", host: "codex", transport_session: null, heartbeat: { request_id: "", session_id: "", result: "", next_action: "", reported_at: "" }, artifacts: [{ path: "04-edit/rough.mp4", sha256: "0".repeat(64), role: "final-cut", generation: 1, reported_at: "x" }] }));
    const cover = await put(path.join(env.outside, "attached.png"), png(900, 1200, "att"));
    await updateContent(c.id, { assets: [{ filename: "attached.png", libraryPath: path.relative(env.dir, cover), type: "cover", addedAt: "x" }] }, env.dir);
    await reconcileAll(env.dir);
    const doc = (await readProductionDoc(c.id, env.dir))!;
    expect(doc.facts.find((f) => f.kind === "cut")).toMatchObject({ source: "legacy", state: "accepted", path: "04-edit/rough.mp4" });
    expect(doc.facts.find((f) => f.kind === "cover")).toMatchObject({ source: "legacy", ratio: "3:4" });
  });

  it("文件不见了 → availability=missing，阶段不倒退；归档过的记 archived", async () => {
    const c = await editedOffsite("approved");
    await enableOntology(env.dir);
    await fs.rm(path.join(projectRoot(env, c.id), "02-aroll/原片.mov"));
    await reconcileAll(env.dir);
    const doc = (await readProductionDoc(c.id, env.dir))!;
    expect(doc.facts.find((f) => f.kind === "aroll")!.availability).toBe("missing");
    expect((await getContent(c.id, env.dir))!.status).toBe("editing");
    await appendArchiveLog(env.dir, { contentId: c.id, title: TITLE, target: "nas", freedBytes: 1, archivedAt: new Date().toISOString() });
    await reconcileAll(env.dir);
    expect((await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.kind === "aroll")!.availability).toBe("archived");
  });

  it("文件被原地覆盖 → 旧事实记 replaced_at，新字节是新事实（E13）", async () => {
    const c = await editedOffsite("approved");
    await enableOntology(env.dir);
    await put(path.join(projectRoot(env, c.id), "07-delivery/export/final.mp4"), "cut-overwritten");
    await reconcileAll(env.dir);
    const cuts = (await readProductionDoc(c.id, env.dir))!.facts.filter((f) => f.kind === "cut");
    expect(cuts).toHaveLength(2);
    expect(cuts[0].replaced_at).toBeTruthy();
    expect(cuts[1].replaced_at).toBeUndefined();
  });

  it("外部：收件箱原片文件名唯一对上等原片的稿 → 自动挂上（1b §4）；ChatCut 导出对上已发布稿 → post_publish 候选；不动已发布阶段", async () => {
    const waiting = await videoContent(env, TITLE, "draft_ready");
    const done = await videoContent(env, "已经发布的那条视频", "published");
    await enableOntology(env.dir);
    await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw");
    await put(path.join(env.chatcut, "已经发布的那条视频-v2.mp4"), "new-export");
    await put(path.join(env.chatcut, "毫不相干.mp4"), "other");
    await reconcileAll(env.dir);
    expect((await readProductionDoc(waiting.id, env.dir))!.facts).toMatchObject([{ kind: "aroll", state: "accepted", source: "reconcile", auto_attached: true, source_path: path.join(env.inbox, "AI又忘了怎么办-原片.mov") }]);
    expect((await readProductionDoc(done.id, env.dir))!.facts).toMatchObject([{ kind: "cut", state: "candidate", post_publish: true }]);
    expect((await getContent(done.id, env.dir))!.status).toBe("published");
    expect(await exists(path.join(env.inbox, "AI又忘了怎么办-原片.mov"))).toBe(false);
  });

  it("逐条隔离：一条的制作记录坏了，别条照常对账，失败进报告与看板", async () => {
    const bad = await editedOffsite("approved");
    const good = await videoContent(env, "另一条好好的稿", "approved");
    await put(path.join(projectRoot(env, good.id), "02-aroll/raw.mov"), "raw2");
    await fs.mkdir(path.dirname(productionFile(bad.id, env.dir)), { recursive: true });
    await fs.writeFile(productionFile(bad.id, env.dir), "{broken");
    await writeEnabledVersion(env.dir);
    const report = await reconcileAll(env.dir);
    expect(report.errors).toEqual([expect.objectContaining({ id: bad.id })]);
    expect((await readProductionDoc(good.id, env.dir))!.facts).toHaveLength(1);
    expect((await boardData(env.dir)).ontology.report?.errors).toHaveLength(1);
  });

  it("看板读取零写入（启用后也一样）", async () => {
    const c = await editedOffsite("approved");
    await enableOntology(env.dir);
    const files = [productionFile(c.id, env.dir), path.join(projectRoot(env, c.id), "00-project/autocrew/meta.json")];
    const before = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.mtimeMs)));
    await boardData(env.dir);
    expect(await Promise.all(files.map((f) => fs.stat(f).then((s) => s.mtimeMs)))).toEqual(before);
  });
});

describe("事务恢复（§7，E23/E28）", () => {
  beforeEach(async () => { await writeEnabledVersion(env.dir); });

  it("record 克隆到一半进程没了：恢复时按事务 id 判未提交，删掉项目里那份，源不动", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.chatcut, "x.mp4"), "cut");
    const dst = await put(path.join(projectRoot(env, c.id), "04-edit/x.mp4"), "cut");
    await saveTxn(env.dir, { id: "txn-crash-2", kind: "record", content_id: c.id, round: 1, at: "x", ops: [{ op: "clone", source: src, target: dst, sha256: await sha256File(dst), step: "placed" }] });
    resetProductionReady();
    expect(await recoverTxns(env.dir)).toMatchObject([{ outcome: "rolled_back" }]);
    expect(await exists(dst)).toBe(false);
    expect(await exists(src)).toBe(true);
  });

  it("[Codex P1 txn.ts:78] 崩溃后目标被人改过：恢复不删这份唯一的新版本，报冲突、日志留着", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.chatcut, "x.mp4"), "cut");
    const dst = await put(path.join(projectRoot(env, c.id), "04-edit/x.mp4"), "cut");
    const sha = await sha256File(dst);
    await fs.writeFile(dst, "编辑器改过的新版本");
    await saveTxn(env.dir, { id: "txn-crash-3", kind: "record", content_id: c.id, round: 1, at: "x", ops: [{ op: "clone", source: src, target: dst, sha256: sha, step: "placed" }] });
    const [r] = await recoverTxns(env.dir);
    expect(r.outcome).toMatch(/^failed:恢复冲突/);
    expect(await fs.readFile(dst, "utf8")).toBe("编辑器改过的新版本");
    expect(await exists(path.join(env.dir, "production/txns/txn-crash-3.json"))).toBe(true);
  });

  it("已提交的事务（production.json 里有事务 id）恢复时只删日志", async () => {
    const c = await videoContent(env, TITLE);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "r1" });
    const doc = (await readProductionDoc(c.id, env.dir))!;
    const target = path.join(projectRoot(env, c.id), doc.facts[0].path!);
    await saveTxn(env.dir, { id: doc.txns![0], kind: "record", content_id: c.id, round: 1, at: "x", ops: [{ op: "move", source: path.join(env.inbox, "AI又忘了怎么办-原片.mov"), target, sha256: doc.facts[0].sha256!, step: "placed" }] });
    expect(await recoverTxns(env.dir)).toMatchObject([{ outcome: "committed" }]);
    expect(await exists(target)).toBe(true);
  });

  it("跨卷搬运时源在复制途中变了 → 中止，原件不动、项目里不留残片（E28）", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw");
    setMoveOps({
      rename: async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); },
      copyFile: async (a, b) => { await fs.copyFile(a, b); const t = new Date(); await fs.utimes(a, t, t); },
    });
    const r = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" });
    expect(r).toMatchObject({ ok: false, code: "place_failed" });
    expect(await fs.readFile(src, "utf8")).toBe("raw");
    expect(await fs.readdir(path.join(projectRoot(env, c.id), "02-aroll"))).toEqual([]);
    expect(await readProductionDoc(c.id, env.dir)).toBeNull();
  });
});
