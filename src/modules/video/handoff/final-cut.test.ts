import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callVideo, makeFixture, handedOff, writePng } from "./handoff-testkit.js";
import { initializeProjectLayout } from "../../../storage/content-project.js";
import { setVideoSettings } from "../../../desktop/settings-video.js";
import { founderProjectReview } from "./founder-review.js";
import { setFinalCutProbe } from "./final-cut.js";
import { sha256File } from "./manifest.js";

let env: Awaited<ReturnType<typeof makeFixture>>;
let exportDir: string;
beforeEach(async () => {
  env = await makeFixture();
  await fs.unlink(path.join(env.dir, "video.json"));
  await initializeProjectLayout(env.dir, "lib-deadbeef", "default");
  exportDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-jianying-export-")));
  await setVideoSettings({ _dataDir: env.dir, jianying_export_dir: exportDir });
  setFinalCutProbe(async () => 83_400);
});
afterEach(async () => { setFinalCutProbe(null); await env.cleanup(); await fs.rm(exportDir, { recursive: true, force: true }); });

type Card = { name: string; sha8: string; sha256: string; path: string; external: boolean; duration_ms: number; exported_at: string; jianying_draft: string; changed: boolean };
type Gate = { status: string; reason?: string; approval: { artifact_sha256: string } | null };

async function candidate(v: Awaited<ReturnType<typeof handedOff>>, file: string, n: number) {
  return callVideo(env.dir, { action: "report", content_id: v.id, claim_token: v.token, _session: "editor-session",
    report: { request_id: `cand-${n}`, generation: 1, binding_revision: 1, session_id: "editor-session", result: "导出", next_action: "等创始人",
      files: [{ path: file, sha256: await sha256File(file), role: "final-cut-candidate" }], jianying_draft: "纠正AI-0927" } }, "codex");
}
const approve = (v: { id: string; manifestHash: string }, card: Card) =>
  founderProjectReview(v.id, env.dir, { action: "approve", which: "final_cut", manifest_hash: v.manifestHash, files: [{ path: card.path, sha256: card.sha256 }] });

it("成片待审卡：文件名、时长、导出时间、剪映草稿名、指纹前 8 位；通过成片绑定页面上的那个指纹", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const exported = await writePng(path.join(exportDir, "纠正AI.mp4"), "cut-1");
  expect((await candidate(v, exported, 1)).ok).toBe(true);
  const review = await founderProjectReview(v.id, env.dir);
  const card = review.final_cut as Card;
  const sha = await sha256File(exported);
  expect(card).toMatchObject({ name: "纠正AI.mp4", sha8: sha.slice(0, 8), external: true, duration_ms: 83_400, jianying_draft: "纠正AI-0927", changed: false });
  expect(Date.parse(card.exported_at)).toBeGreaterThan(0);
  const done = await approve(v, card);
  expect((done.gates as Record<string, Gate>).gate3).toMatchObject({ status: "approved", approval: { artifact_sha256: sha } });
});

it("点通过前又导出过：服务端重算不一致，拒绝并提示刷新", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const exported = await writePng(path.join(exportDir, "纠正AI.mp4"), "cut-1");
  await candidate(v, exported, 1);
  const card = (await founderProjectReview(v.id, env.dir)).final_cut as Card;
  await fs.writeFile(exported, "re-exported with different bytes");
  await expect(approve(v, card)).rejects.toThrow("导出文件变了，刷新后再看");
  expect(((await founderProjectReview(v.id, env.dir)).gates as Record<string, Gate>).gate3.status).toBe("pending");
});

it("通过之后又导出：看板显示「导出文件变了，需要重新通过」，批准失效", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const exported = await writePng(path.join(exportDir, "纠正AI.mp4"), "cut-1");
  await candidate(v, exported, 1);
  await approve(v, (await founderProjectReview(v.id, env.dir)).final_cut as Card);
  await fs.writeFile(exported, "re-exported after approval, longer bytes");
  const after = await founderProjectReview(v.id, env.dir);
  expect((after.final_cut as Card).changed).toBe(true);
  expect((after.gates as Record<string, Gate>).gate3).toMatchObject({ status: "invalidated", reason: "导出文件变了，需要重新通过" });
  // Codex 报了这次新导出：指纹换了，同样失效、同样的话
  await candidate(v, exported, 2);
  const reported = await founderProjectReview(v.id, env.dir);
  expect((reported.gates as Record<string, Gate>).gate3).toMatchObject({ status: "invalidated", reason: "导出文件变了，需要重新通过" });
});
