import { beforeEach, afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeFixture, seedAccepted, callVideo, writePng } from "./handoff-testkit.js";
import { initializeProjectLayout, resolveContentProject, contentFile } from "../../../storage/content-project.js";
import { getContent } from "../../../storage/local-store.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { founderProjectReview } from "./project-execution.js";
import { saveCoverage } from "./project-evidence.js";
import { claimContent } from "../../../storage/claims.js";
import { withCallerSession } from "../../../runtime/run-log.js";
import { sha256File } from "./manifest.js";

let env: Awaited<ReturnType<typeof makeFixture>>;
beforeEach(async () => { env = await makeFixture(); await fs.unlink(path.join(env.dir, "video.json")); await initializeProjectLayout(env.dir, "lib-deadbeef", "default"); });
afterEach(async () => { await env.cleanup(); });

/** 一条已交接、剪辑工位已认领的视频 */
async function handedOff(dir: string, aroll: string) {
  const seeded = await seedAccepted(dir);
  const content = (await getContent(seeded.id, dir))!;
  await founderProjectReview(content.id, dir, { action: "decisions", draft_hash: draftHash(content), title: content.title, cover_text: "封面字", target_seconds: 90 });
  await saveCoverage(content, { draft_hash: draftHash(content), citations: [{ start: 0, end: content.body.indexOf("。") + 1, excerpt: content.body.slice(0, content.body.indexOf("。") + 1), evidence_id: "creator", sourceType: "creator_opinion", quote: "", verification: "创作者亲历（测试夹具）" }], reviewed_by: "writer", reviewed_at: new Date().toISOString() }, dir);
  const handoff = await callVideo(dir, { action: "handoff", content_id: content.id, aroll_path: aroll });
  if (!handoff.ok) throw new Error(JSON.stringify(handoff));
  const claim = await withCallerSession("editor-session", () => claimContent(content.id, "editor", "codex", dir));
  if (!claim.ok) throw new Error("claim failed");
  const root = resolveContentProject(content.id, dir)!.project_root;
  let n = 0;
  const report = async (files: Array<{ file: string; role: string; version?: number }>, extra: Record<string, unknown> = {}) => callVideo(dir, {
    action: "report", content_id: content.id, claim_token: claim.claim.token, _session: "editor-session",
    report: { request_id: `r-${++n}`, generation: 1, binding_revision: 1, session_id: "editor-session", result: `第 ${n} 次`, next_action: "继续",
      files: await Promise.all(files.map(async f => ({ path: path.relative(root, f.file), sha256: await sha256File(f.file), role: f.role, ...(f.version ? { version: f.version } : {}) }))), ...extra },
  }, "codex");
  return { id: content.id, root, manifestHash: String(handoff.manifest_hash), report };
}

it("心跳只留最新，产物累计：封面新一批和一次纯心跳都挤不掉成片和旧版封面", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const final = await writePng(path.join(v.root, "07-delivery/final.png"), "final");
  const c1 = await writePng(path.join(v.root, "05-cover/v01/3x4.png"), "v1");
  const c2 = await writePng(path.join(v.root, "05-cover/v02/3x4.png"), "v2");
  expect((await v.report([{ file: final, role: "final-cut" }], { jianying_draft: "纠正AI-0927" })).ok).toBe(true);
  expect((await v.report([{ file: c1, role: "cover:3:4", version: 1 }])).ok).toBe(true);
  expect((await v.report([{ file: c2, role: "cover:3:4", version: 2 }])).ok).toBe(true);
  expect((await v.report([])).ok).toBe(true);
  const exec = JSON.parse(await fs.readFile(contentFile(v.id, env.dir, "execution.json"), "utf8"));
  expect(exec.heartbeat).toMatchObject({ result: "第 4 次", request_id: "r-4" });
  expect(exec.jianying_draft).toBe("纠正AI-0927");
  expect(exec.artifacts.map((a: { role: string; version?: number }) => `${a.role}${a.version ?? ""}`)).toEqual(["final-cut", "cover:3:41", "cover:3:42"]);
  expect(exec).not.toHaveProperty("files");
});

it("挪文件（同指纹新路径）只改路径；封面缺 version、项目外文件、状态/审批字段都被拒", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const a = await writePng(path.join(v.root, "04-edit/final.png"), "f");
  expect((await v.report([{ file: a, role: "final-cut" }])).ok).toBe(true);
  const moved = path.join(v.root, "07-delivery/final.png");
  await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(a, moved);
  expect((await v.report([{ file: moved, role: "final-cut" }])).ok).toBe(true);
  const exec = JSON.parse(await fs.readFile(contentFile(v.id, env.dir, "execution.json"), "utf8"));
  expect(exec.artifacts).toHaveLength(1);
  expect(exec.artifacts[0].path).toBe("07-delivery/final.png");
  const c = await writePng(path.join(v.root, "05-cover/v01/4x3.png"), "c");
  expect((await v.report([{ file: c, role: "cover:4:3" }])).ok).toBe(false);
  const outside = await writePng(path.join(env.outside, "x.png"), "o");
  expect((await v.report([{ file: outside, role: "final-cut" }])).ok).toBe(false);
  expect((await v.report([], { status: "publish_ready" })).ok).toBe(false);
  expect((await v.report([], { approvals: {} })).ok).toBe(false);
});

it("创始人选封面单独记录，只能选索引里该尺寸的版本", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const c1 = await writePng(path.join(v.root, "05-cover/v01/3x4.png"), "v1");
  await v.report([{ file: c1, role: "cover:3:4", version: 1 }]);
  const sha = await sha256File(c1);
  await expect(founderProjectReview(v.id, env.dir, { action: "select_cover", ratio: "4:3", sha256: sha })).rejects.toThrow(/不在产物记录/);
  await expect(founderProjectReview(v.id, env.dir, { action: "select_cover", ratio: "1:1", sha256: sha })).rejects.toThrow(/只有 3:4 和 4:3/);
  const r = await founderProjectReview(v.id, env.dir, { action: "select_cover", ratio: "3:4", sha256: sha });
  expect((r.cover_selection as Record<string, { version: number }>)["3:4"].version).toBe(1);
  await v.report([]);
  const exec = JSON.parse(await fs.readFile(contentFile(v.id, env.dir, "execution.json"), "utf8"));
  expect(exec).not.toHaveProperty("cover_selection");
});

it("存量旧形状 execution.json 读出来就是新形状，下一次 report 在其上累计", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const old = await writePng(path.join(v.root, "07-delivery/final.png"), "old");
  await fs.writeFile(contentFile(v.id, env.dir, "execution.json"), JSON.stringify({ request_id: "legacy", generation: 1, binding_revision: 1, session_id: "editor-session",
    machine: (await import("node:os")).hostname(), host: "codex", result: "旧", next_action: "旧", files: [{ path: "07-delivery/final.png", sha256: await sha256File(old), role: "final" }] }));
  const review = await founderProjectReview(v.id, env.dir);
  expect((review.execution as { artifacts: Array<{ role: string }> }).artifacts[0].role).toBe("final-cut");
  const c = await writePng(path.join(v.root, "05-cover/v01/3x4.png"), "c");
  expect((await v.report([{ file: c, role: "cover:3:4", version: 1 }])).ok).toBe(true);
  const exec = JSON.parse(await fs.readFile(contentFile(v.id, env.dir, "execution.json"), "utf8"));
  expect(exec.artifacts.map((a: { role: string }) => a.role)).toEqual(["final-cut", "cover:3:4"]);
});
