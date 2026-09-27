/**
 * 交接失败不留副作用（P6 §13.4-D）。回归 2026-09-26：缺决定的 handoff 失败后仍占着新认领、
 * 新令牌没回给调用方，之后带原令牌的写操作被报 claim_held。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeFixture, seedAccepted, callVideo, HAS_FFMPEG } from "./handoff-testkit.js";
import { initializeProjectLayout, resolveContentProject } from "../../../storage/content-project.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import * as store from "../../../storage/local-store.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { founderProjectReview } from "./founder-review.js";
import { saveCoverage } from "./project-evidence.js";
import { claimContent } from "../../../storage/claims.js";
import { executeContentSave } from "../../../tools/content-save.js";
import { sha256File } from "./manifest.js";
import { arollLockOf } from "./pull-store.js";
import { recoverArollMoves } from "./aroll-move.js";
import { hashClaimToken } from "../../../storage/claim-token.js";

vi.mock("../../../storage/local-store.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../storage/local-store.js")>();
  return { ...real, transitionStatus: vi.fn(real.transitionStatus) };
});

let env: Awaited<ReturnType<typeof makeFixture>>;
beforeEach(async () => {
  env = await makeFixture();
  await fs.unlink(path.join(env.dir, "video.json"));
  await initializeProjectLayout(env.dir, "lib-deadbeef", "default");
});
afterEach(async () => { vi.mocked(store.transitionStatus).mockRestore?.(); await env.cleanup(); });

const handoff = (c: Content, extra: Record<string, unknown> = {}) =>
  callVideo(env.dir, { action: "handoff", content_id: c.id, aroll_path: env.aroll, ...extra });

async function claimed(c: Content): Promise<string> {
  const r = await claimContent(c.id, "writer", "claude-code", env.dir);
  if (!r.ok) throw new Error(r.error);
  return r.claim.token;
}

async function withDecisions(c: Content): Promise<Content> {
  await founderProjectReview(c.id, env.dir, { action: "decisions", draft_hash: draftHash(c), title: c.title, cover_text: "封面字", target_seconds: 90 });
  return (await getContent(c.id, env.dir))!;
}

async function withCoverage(c: Content): Promise<void> {
  const first = c.body.slice(0, c.body.indexOf("。") + 1);
  const citations = [{ start: 0, end: first.length, excerpt: first, evidence_id: "creator", sourceType: "creator_opinion" as const, quote: "", verification: "创作者亲历（测试夹具）" }];
  await saveCoverage(c, { draft_hash: draftHash(c), citations, reviewed_by: "writer", reviewed_at: new Date().toISOString() }, env.dir);
}

describe.skipIf(!HAS_FFMPEG)("交接缺料在认领写入之前拒绝", () => {
  it("回归 09-26：缺决定 → missing_decisions，认领和令牌原样，原令牌后续写入不被 claim_held", async () => {
    const c = await seedAccepted(env.dir);
    const token = await claimed(c);
    const before = (await getContent(c.id, env.dir))!.claim;
    const r = await handoff(c, { claim_token: token });
    expect(r).toMatchObject({ ok: false, code: "missing_decisions", failure_class: "handoff_rejected" });
    expect(String(r.next_action)).toContain("工作台");
    expect(r).not.toHaveProperty("claim_token");
    const after = (await getContent(c.id, env.dir))!;
    expect(after.claim).toEqual(before);
    expect(after.status).toBe("draft_ready");
    const write = await executeContentSave({ action: "update", id: c.id, title: "改个标题", claim_token: token, _host: "claude-code", _dataDir: env.dir });
    expect(write).toMatchObject({ ok: true });
  });

  it("调用前没人认领：失败的交接不新占认领", async () => {
    const c = await seedAccepted(env.dir);
    expect(await handoff(c)).toMatchObject({ ok: false, code: "missing_decisions" });
    expect((await getContent(c.id, env.dir))!.claim).toBeUndefined();
  });

  it("缺出处 → missing_citations，列出没被覆盖的句子", async () => {
    const c = await withDecisions(await seedAccepted(env.dir));
    const token = await claimed(c);
    const r = await handoff(c, { claim_token: token });
    expect(r).toMatchObject({ ok: false, code: "missing_citations", failure_class: "handoff_rejected" });
    expect(r.uncovered_sentences).toEqual([expect.objectContaining({ start: 0, text: expect.stringContaining("每天两小时") })]);
    expect(String(r.next_action)).toContain("citations");
    expect((await getContent(c.id, env.dir))!.claim?.token).toBe(hashClaimToken(token));
  });
});

describe.skipIf(!HAS_FFMPEG)("认领转交之后的失败", () => {
  async function ready(): Promise<{ c: Content; token: string; root: string }> {
    const c = await withDecisions(await seedAccepted(env.dir));
    await withCoverage(c);
    return { c, token: await claimed(c), root: resolveContentProject(c.id, env.dir)!.project_root };
  }

  it("确认没提交 → handoff_not_committed：认领回到原持有者和原令牌，交接包删掉", async () => {
    const { c, token, root } = await ready();
    const before = (await getContent(c.id, env.dir))!.claim;
    const sha = await sha256File(env.aroll);
    vi.mocked(store.transitionStatus).mockResolvedValueOnce({ ok: false, error: "模拟没推进" });
    const r = await handoff(c, { claim_token: token });
    expect(r).toMatchObject({ ok: false, code: "handoff_not_committed", failure_class: "handoff_not_committed", claim_restored: true });
    const after = (await getContent(c.id, env.dir))!;
    expect(after.claim).toMatchObject({ token: hashClaimToken(token), host: before!.host, employee: before!.employee });
    expect(after.status).toBe("draft_ready");
    await expect(fs.access(path.join(root, "01-script/handoff/g0001/handoff.md"))).rejects.toThrow();
    // 原片挪回原处，不留在项目里（slice 1 遗留）；原片锁释放
    expect(r.aroll_restored_to).toBe(env.aroll);
    expect(await sha256File(env.aroll)).toBe(sha);
    expect(await fs.readdir(path.join(root, "02-aroll")).catch(() => [])).toEqual([]);
    expect(await arollLockOf(env.dir, sha)).toBeNull();
    expect(await handoff(after, { claim_token: token })).toMatchObject({ ok: true, content_status: "editing" });
  });

  it("结果不确定 → handoff_pending_recovery：不删交接包、不谎报回滚", async () => {
    const { c, token, root } = await ready();
    vi.mocked(store.transitionStatus).mockRejectedValueOnce(Object.assign(new Error("project_commit_uncertain: 写入结果待恢复"), { code: "PROJECT_COMMIT_UNCERTAIN" }));
    const r = await handoff(c, { claim_token: token });
    expect(r).toMatchObject({ ok: false, code: "handoff_pending_recovery", failure_class: "handoff_pending_recovery", claim_restored: false });
    expect((await getContent(c.id, env.dir))!.claim?.host).toBe("codex");
    await expect(fs.access(path.join(root, "01-script/handoff/g0001/handoff.md"))).resolves.toBeUndefined();
    // 结果不确定：日志与原片锁都留着，原片留在项目里；重启核定——没提交就挪回原处并释放锁
    const sha = (await readdirJournals())[0];
    expect(await arollLockOf(env.dir, sha)).toMatchObject({ content_id: c.id });
    await expect(fs.access(env.aroll)).rejects.toThrow();
    const out = await recoverArollMoves(env.dir, env.outside);
    expect(out).toEqual([{ sha256: sha, outcome: `returned:${env.aroll}` }]);
    expect(await arollLockOf(env.dir, sha)).toBeNull();
  });

  async function readdirJournals(): Promise<string[]> {
    return (await fs.readdir(path.join(env.dir, "video/pull/move-journals"))).map((n) => n.replace(/\.json$/, ""));
  }
});
