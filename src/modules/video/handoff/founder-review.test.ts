import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeFixture, handedOff, seedAccepted, writePng } from "./handoff-testkit.js";
import { initializeProjectLayout, contentFile } from "../../../storage/content-project.js";
import { getContent, updateContent } from "../../../storage/local-store.js";
import { founderProjectReview } from "./founder-review.js";
import { coverPairHash, sha256File } from "./manifest.js";
import { gateView, normalizeApprovals, type GateContext } from "./gate-state.js";
import type { StoredExecution } from "./execution-index.js";
import { HUMAN_WRITE } from "../../../storage/first-body-guard.js";

let env: Awaited<ReturnType<typeof makeFixture>>;
beforeEach(async () => { env = await makeFixture(); await fs.unlink(path.join(env.dir, "video.json")); await initializeProjectLayout(env.dir, "lib-deadbeef", "default"); });
afterEach(async () => { await env.cleanup(); });

type Gates = Record<string, { status: string; approval: { approved_at: string } | null; rejection: { note: string } | null }>;
const rel = (root: string, file: string) => path.relative(root, file);

it("批准幂等：同一门同一指纹重复点返回原记录、不改时间；产物一换就失效", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const f1 = await writePng(path.join(v.root, "07-delivery/final.png"), "1");
  await v.report([{ file: f1, role: "final-cut" }]);
  const files = [{ path: rel(v.root, f1), sha256: await sha256File(f1) }];
  const first = await founderProjectReview(v.id, env.dir, { action: "approve", which: "final_cut", manifest_hash: v.manifestHash, files });
  await new Promise(r => setTimeout(r, 5));
  const again = await founderProjectReview(v.id, env.dir, { action: "approve", which: "final_cut", manifest_hash: v.manifestHash, files });
  expect(again.decision).toEqual(first.decision);
  expect((again.gates as Gates).gate3.status).toBe("approved");
  const f2 = await writePng(path.join(v.root, "07-delivery/final-v2.png"), "2");
  await v.report([{ file: f2, role: "final-cut" }]);
  const after = await founderProjectReview(v.id, env.dir);
  expect((after.gates as Gates).gate3.status).toBe("invalidated");
  const state = JSON.parse(await fs.readFile(path.join(v.root, "00-project/notes/workflow-state.json"), "utf8"));
  expect(state.gates.gate3.status).toBe("invalidated");
  // 页面上还挂着旧文件就去批：服务端认的是当前那一件
  await expect(founderProjectReview(v.id, env.dir, { action: "approve", which: "final_cut", manifest_hash: v.manifestHash, files })).rejects.toThrow(/导出文件变了，刷新后再看/);
});

it("打回：必须带原话、记录不可改、重复点返回原记录；被打回的这一版不能再批，新版本回到待批", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const r1 = await writePng(path.join(v.root, "04-edit/rough.png"), "r1");
  await v.report([{ file: r1, role: "rough_cut" }]);
  const sha = await sha256File(r1);
  const base = { action: "reject", which: "rough_cut", manifest_hash: v.manifestHash, artifact_sha256: sha };
  await expect(founderProjectReview(v.id, env.dir, { ...base, note: "  " })).rejects.toThrow(/原话/);
  await expect(founderProjectReview(v.id, env.dir, { ...base, artifact_sha256: "0".repeat(64), note: "x" })).rejects.toThrow(/产物已变化/);
  const first = await founderProjectReview(v.id, env.dir, { ...base, note: "开头太长" });
  const again = await founderProjectReview(v.id, env.dir, { ...base, note: "换一句" });
  expect(again.decision).toEqual(first.decision);
  expect((again.gates as Gates).gate1).toMatchObject({ status: "rejected", rejection: { note: "开头太长" } });
  await expect(founderProjectReview(v.id, env.dir, { action: "approve", which: "rough_cut", manifest_hash: v.manifestHash, files: [{ path: rel(v.root, r1), sha256: sha }] })).rejects.toThrow(/已打回/);
  const r2 = await writePng(path.join(v.root, "04-edit/rough-2.png"), "r2");
  await v.report([{ file: r2, role: "rough_cut" }]);
  const next = await founderProjectReview(v.id, env.dir);
  expect((next.gates as Gates).gate1.status).toBe("pending");
  expect((next.approvals as { rejections: unknown[] }).rejections).toHaveLength(1);
});

it("gate4：批准哈希沿用 sha256(3:4 hex + 4:3 hex)；整批打回后出 v2 回到待批，旧版仍在", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const a = await writePng(path.join(v.root, "05-cover/v01/3x4.png"), "a"), b = await writePng(path.join(v.root, "05-cover/v01/4x3.png"), "b");
  await v.report([{ file: a, role: "cover:3:4", version: 1 }, { file: b, role: "cover:4:3", version: 1 }]);
  const review = await founderProjectReview(v.id, env.dir);
  const g4 = (review.gates as Record<string, { artifact_sha256: string | null; reject_sha256: string | null }>).gate4;
  expect(g4.artifact_sha256).toBeNull(); // 还没选，批准目标为空
  expect(g4.reject_sha256).toBe(await batchHash(v.id)); // 打回针对整批
  const rejected = await founderProjectReview(v.id, env.dir, { action: "reject", which: "covers", manifest_hash: v.manifestHash, note: "字太小", artifact_sha256: await batchHash(v.id) });
  expect((rejected.gates as Gates).gate4.status).toBe("rejected");
  const c = await writePng(path.join(v.root, "05-cover/v02/3x4.png"), "c"), d = await writePng(path.join(v.root, "05-cover/v02/4x3.png"), "d");
  await v.report([{ file: c, role: "cover:3:4", version: 2 }, { file: d, role: "cover:4:3", version: 2 }]);
  const files = [{ path: rel(v.root, c), sha256: await sha256File(c) }, { path: rel(v.root, d), sha256: await sha256File(d) }];
  const ok = await founderProjectReview(v.id, env.dir, { action: "approve", which: "covers", manifest_hash: v.manifestHash, files });
  expect((ok.decision as { artifact_sha256: string }).artifact_sha256).toBe(coverPairHash(files[0].sha256, files[1].sha256));
  expect((ok.gates as Gates).gate4.status).toBe("approved");
  expect((ok.cover_selection as Record<string, { version: number }>)["3:4"].version).toBe(2);
  expect((ok.execution as StoredExecution).artifacts.filter(x => x.role.startsWith("cover:"))).toHaveLength(4);
  // 登记前改用另一版 → 直接批准那一对，选择随之换
  const old = [{ path: rel(v.root, a), sha256: await sha256File(a) }, { path: rel(v.root, b), sha256: await sha256File(b) }];
  const switched = await founderProjectReview(v.id, env.dir, { action: "approve", which: "covers", manifest_hash: v.manifestHash, files: old });
  expect((switched.gates as Gates).gate4.status).toBe("approved");
  expect((switched.cover_selection as Record<string, { version: number }>)["3:4"].version).toBe(1);
});

it("稿子在批准后被改：批准失效", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const r = await writePng(path.join(v.root, "04-edit/sb.png"), "s");
  await v.report([{ file: r, role: "storyboard" }]);
  await founderProjectReview(v.id, env.dir, { action: "approve", which: "storyboard", manifest_hash: v.manifestHash, files: [{ path: rel(v.root, r), sha256: await sha256File(r) }] });
  await updateContent(v.id, { _provenance: HUMAN_WRITE, body: (await getContent(v.id, env.dir))!.body + "补一句。" }, env.dir);
  const gates = (await founderProjectReview(v.id, env.dir)).gates as Record<string, { status: string; reason?: string }>;
  expect(gates.gate2).toMatchObject({ status: "invalidated", reason: "稿件已改" });
});

async function batchHash(id: string): Promise<string> {
  const { coverBatchHash } = await import("./gate-state.js");
  const exec = JSON.parse(await fs.readFile(contentFile(id, env.dir, "execution.json"), "utf8"));
  return coverBatchHash(exec.artifacts)!;
}

describe("gateView 失效条件", () => {
  const execution = { artifacts: [{ path: "x", sha256: "a".repeat(64), role: "rough_cut", generation: 1, reported_at: "t" }] } as unknown as StoredExecution;
  const approval = { artifact_sha256: "a".repeat(64), approved_at: "2026-09-27T00:00:00Z", user_message: "m" };
  const ctx = (over: Partial<GateContext> = {}): GateContext => ({ handoff: { generation: 2, hash: "h2" }, draftHash: "d",
    approvals: { schema: 2, source: "founder-workbench", rough_cut: approval, bindings: { rough_cut: { generation: 2, manifest_hash: "h2", draft_hash: "d" } }, rejections: [] },
    execution, selection: null, ...over });
  it("代次 / 稿 / 产物任一变化即失效，否则已批", () => {
    expect(gateView("rough_cut", ctx()).status).toBe("approved");
    expect(gateView("rough_cut", ctx({ handoff: { generation: 3, hash: "h3" } })).reason).toBe("交接代次已变化");
    expect(gateView("rough_cut", ctx({ draftHash: "other" })).reason).toBe("稿件已改");
    expect(gateView("rough_cut", ctx({ handoff: null })).status).toBe("invalidated");
    expect(gateView("storyboard", ctx()).status).toBe("pending");
  });
  it("旧形状批准（无稿件绑定）读成新形状并按失效处理", () => {
    const legacy = normalizeApprovals({ source: "founder-workbench", generation: 2, manifest_hash: "h2", rough_cut: approval });
    expect(legacy?.bindings.rough_cut).toEqual({ generation: 2, manifest_hash: "h2", draft_hash: "" });
    expect(gateView("rough_cut", ctx({ approvals: legacy })).status).toBe("invalidated");
  });
});

describe("创始人撤回交接（看板）", () => {
  it("跑完整撤回：代次作废、回到 draft_ready、认领释放；再撤是重放", async () => {
    const v = await handedOff(env.dir, env.aroll);
    const r = await founderProjectReview(v.id, env.dir, { action: "revoke", manifest_hash: v.manifestHash });
    expect(r).toMatchObject({ ok: true, status: "revoked", content_status: "draft_ready", manifest_hash: v.manifestHash });
    const after = (await getContent(v.id, env.dir))!;
    expect(after.status).toBe("draft_ready");
    expect(after.video?.revoked).toContain(v.manifestHash);
    expect(after.claim).toBeUndefined();
    expect(await founderProjectReview(v.id, env.dir, { action: "revoke", manifest_hash: v.manifestHash })).toMatchObject({ ok: true, replayed: true });
  });

  it("没交接过：nothing_to_revoke；不在剪辑中：not_editing", async () => {
    const seeded = await seedAccepted(env.dir);
    expect(await founderProjectReview(seeded.id, env.dir, { action: "revoke", manifest_hash: "h" })).toMatchObject({ ok: false, code: "nothing_to_revoke" });
    const v = await handedOff(env.dir, env.aroll);
    const c = (await getContent(v.id, env.dir))!;
    await updateContent(v.id, { _provenance: HUMAN_WRITE, status: "cover_pending", video: { ...c.video } }, env.dir);
    expect(await founderProjectReview(v.id, env.dir, { action: "revoke", manifest_hash: v.manifestHash })).toMatchObject({ ok: false, code: "not_editing" });
  });

  it("不带代次或代次已换：拒绝，不动当前交接", async () => {
    const v = await handedOff(env.dir, env.aroll);
    expect(await founderProjectReview(v.id, env.dir, { action: "revoke" })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await founderProjectReview(v.id, env.dir, { action: "revoke", manifest_hash: "stale" })).toMatchObject({ ok: false, code: "stale_handoff" });
    const after = (await getContent(v.id, env.dir))!;
    expect(after.status).toBe("editing");
    expect(after.video?.revoked ?? []).not.toContain(v.manifestHash);
  });
});
