/**
 * Codex 审 seg2（~/.cache/autocrew-yt/ontology-advisor/codex-review-seg2.txt）的回归测试；
 * legacy.ts:52 那条在 reconcile.test（[Codex seg2 P1 legacy.ts:52]）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../storage/local-store.js";
import { emptyProductionDoc } from "../../storage/production-types.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderProjectReview } from "../video/handoff/founder-review.js";
import { revealProjectPath } from "../../desktop/project-reveal.js";
import { founderDecision } from "./decisions.js";
import { publishReceipts } from "./derive.js";
import { registeredPackage } from "./publish-gate.js";
import { exists, founderApprove, makeEnv, png, projectRoot, put, record, SRT, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

const TITLE = "AI 又忘了怎么办";
const decide = (id: string, a: string, p: Record<string, unknown> = {}) => founderDecision(id, a, p, env.dir);

async function edited() {
  const c = await videoContent(env, TITLE);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
  const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "AI又忘了怎么办.mp4"), "cut-v1"), request_id: "c" });
  await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), SRT), for_cut: cut.fact_id, request_id: "s" });
  const a = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c34.png"), png(900, 1200)), request_id: "p1" });
  const b = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c43.png"), png(1200, 900)), version: 1, request_id: "p2" });
  const doc = (await readProductionDoc(c.id, env.dir))!;
  const sha = (id: unknown) => doc.facts.find((f) => f.id === id)!.sha256!;
  return { c, cut: { fact_id: cut.fact_id, sha256: sha(cut.fact_id) }, a: { id: a.fact_id as string, sha: sha(a.fact_id) }, b: { id: b.fact_id as string, sha: sha(b.fact_id) } };
}
type S = Awaited<ReturnType<typeof edited>>;
const pick = (s: S) => decide(s.c.id, "pick_cover", { cover_3x4_fact_id: s.a.id, cover_3x4_sha: s.a.sha, cover_4x3_fact_id: s.b.id, cover_4x3_sha: s.b.sha, cover_text: "字" });
async function registered(): Promise<S> { const s = await edited(); await decide(s.c.id, "approve_cut", s.cut); await pick(s); return s; }

describe("Codex 审 seg2", () => {
  it("[P1 workbench.ts:20] 从导出目录克隆进来的成片，工作台不误判「导出文件变了」", async () => {
    const s = await edited();
    const view = await founderProjectReview(s.c.id, env.dir);
    expect(view.final_cut).toMatchObject({ changed: false, missing: false, sha256: s.cut.sha256 });
  });

  it("[P2 founder-review.ts:197] 在访达中显示：定位读本体的产物索引", async () => {
    const s = await edited();
    const r = await revealProjectPath(s.c.id, s.cut.sha256, env.dir, { platform: "linux" });
    expect(r).not.toMatchObject({ code: "not_allowed" });
  });

  it("[P1 registration.ts:86] 07-delivery/registered 是指向库外的符号链接：登记拒，不往库外写", async () => {
    const s = await edited();
    const escape = path.join(env.outside, "escape");
    await fs.mkdir(escape, { recursive: true });
    await fs.mkdir(path.join(projectRoot(env, s.c.id), "07-delivery"), { recursive: true });
    await fs.symlink(escape, path.join(projectRoot(env, s.c.id), "07-delivery/registered"));
    await decide(s.c.id, "approve_cut", s.cut);
    const r = await pick(s);
    expect(String(r.registration_failed)).toContain("符号链接");
    expect(await fs.readdir(escape)).toEqual([]);
  });

  it("[P1 derive.ts:72] 选封面并登记后又打回其中一张：批准失效，不可发", async () => {
    const s = await registered();
    expect(await registeredPackage((await getContent(s.c.id, env.dir))!, env.dir)).toMatchObject({ ok: true });
    await decide(s.c.id, "reject_cover", { fact_id: s.a.id, sha256: s.a.sha, note: "字太小" });
    expect((await registeredPackage((await getContent(s.c.id, env.dir))!, env.dir))?.ok).toBe(false);
    expect((await getContent(s.c.id, env.dir))!.status).toBe("editing");
  });

  it("[P2 registration.ts:163] 登记已提交、稿件投影失败：报 warning；下次提交补完 video.final", async () => {
    const s = await edited();
    await decide(s.c.id, "approve_cut", s.cut);
    const reg = await import("./registration.js");
    vi.spyOn(reg, "registrationPatch").mockRejectedValueOnce(new Error("meta 写不进去"));
    const r = await pick(s);
    expect(r.registration).toBeTruthy();
    expect(String(r.warnings)).toContain("没写完");
    expect((await getContent(s.c.id, env.dir))!.video?.final).toBeUndefined();
    vi.restoreAllMocks();
    await reg.commitRegistration(s.c.id, env.dir);
    expect((await getContent(s.c.id, env.dir))!.video?.final?.register_hash).toBe(r.registration);
  });

  it("[P2 publish-gate.ts:51] 登记绑的字幕被删：发布出口拦", async () => {
    const s = await registered();
    await fs.rm(path.join(projectRoot(env, s.c.id), "04-edit/a.srt"));
    expect(await registeredPackage((await getContent(s.c.id, env.dir))!, env.dir)).toMatchObject({ ok: false, code: "registered_file_changed" });
  });

  it("[P2 decisions.ts:46] 批准 → 打回 → 再批同一版：落新决定，成片批准重新有效", async () => {
    const s = await edited();
    const first = await decide(s.c.id, "approve_cut", s.cut);
    await decide(s.c.id, "reject_cut", { ...s.cut, note: "再改改" });
    const again = await decide(s.c.id, "approve_cut", s.cut);
    expect((again.decision as { id: string }).id).not.toBe((first.decision as { id: string }).id);
    expect(again.missing).not.toContain("成片待你审");
    expect(await exists(path.join(projectRoot(env, s.c.id), "04-edit/AI又忘了怎么办.mp4"))).toBe(true);
  });
});
