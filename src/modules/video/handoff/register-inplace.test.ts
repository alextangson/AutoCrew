/**
 * 成片第 4 步（P6 §13.4-F，评审 #9）：批准后 Codex 把剪映导出挪进 07-delivery，report 只改索引路径；
 * register 对项目里的文件原地核验、不复制，照样核实际字节；通过后又导出 → approval_mismatch。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callVideo, HAS_FFMPEG, handedOff, makeFixture, makeMp4, writePng } from "./handoff-testkit.js";
import { contentFile, initializeProjectLayout } from "../../../storage/content-project.js";
import { getContent } from "../../../storage/local-store.js";
import { setVideoSettings } from "../../../desktop/settings-video.js";
import { prepareEgoLitePublish } from "../../publish/ego-lite.js";
import { founderProjectReview } from "./founder-review.js";
import { sha256File } from "./manifest.js";

let env: Awaited<ReturnType<typeof makeFixture>>;
let exportDir: string;
beforeEach(async () => {
  env = await makeFixture();
  await fs.unlink(path.join(env.dir, "video.json"));
  await initializeProjectLayout(env.dir, "lib-deadbeef", "default");
  exportDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-jianying-export-")));
  await setVideoSettings({ _dataDir: env.dir, jianying_export_dir: exportDir });
});
afterEach(async () => { await env.cleanup(); await fs.rm(exportDir, { recursive: true, force: true }); });

type V = Awaited<ReturnType<typeof handedOff>>;
let n = 0;
async function report(v: V, file: string, role: string, version?: number) {
  return callVideo(env.dir, { action: "report", content_id: v.id, claim_token: v.token, _session: "editor-session",
    report: { request_id: `ip-${++n}`, generation: 1, binding_revision: 1, session_id: "editor-session", result: "进度", next_action: "继续",
      files: [{ path: file, sha256: await sha256File(file), role, ...(version ? { version } : {}) }] } }, "codex");
}

/** 剪映导出 → 通过成片 → 挪进 07-delivery → 封面出好并通过 */
async function approvedAndMoved(v: V) {
  const exported = await makeMp4(path.join(exportDir, "纠正AI.mp4"));
  expect((await report(v, exported, "final-cut-candidate")).ok).toBe(true);
  const card = (await founderProjectReview(v.id, env.dir)).final_cut as { path: string; sha256: string };
  await founderProjectReview(v.id, env.dir, { action: "approve", which: "final_cut", manifest_hash: v.manifestHash, files: [{ path: card.path, sha256: card.sha256 }] });
  const delivered = path.join(v.root, "07-delivery/纠正AI.mp4");
  await fs.mkdir(path.dirname(delivered), { recursive: true });
  await fs.rename(exported, delivered);
  expect((await report(v, delivered, "final-cut-candidate")).ok).toBe(true);
  const c34 = await writePng(path.join(v.root, "05-cover/v01/3x4.png"), "34");
  const c43 = await writePng(path.join(v.root, "05-cover/v01/4x3.png"), "43");
  await report(v, c34, "cover:3:4", 1);
  await report(v, c43, "cover:4:3", 1);
  const rel = (f: string) => path.relative(v.root, f);
  const approved = await founderProjectReview(v.id, env.dir, { action: "approve", which: "covers", manifest_hash: v.manifestHash,
    files: [{ path: rel(c34), sha256: await sha256File(c34) }, { path: rel(c43), sha256: await sha256File(c43) }] });
  const a = approved.approvals as Record<string, unknown>;
  const register = { action: "register", content_id: v.id, manifest_hash: v.manifestHash, claim_token: v.token, final_path: delivered,
    covers: { "3:4": c34, "4:3": c43 }, jianying_draft: "纠正AI-0927", approvals: { final_cut: a.final_cut, covers: a.covers } };
  return { delivered, c34, c43, register, sha: card.sha256 };
}

describe.skipIf(!HAS_FFMPEG)("register 原地核验", () => {
  it("挪进 07-delivery 后索引只改路径；登记原地不复制，发布包按项目内路径找到成片", async () => {
    const v = await handedOff(env.dir, env.aroll);
    const { delivered, register, sha } = await approvedAndMoved(v);
    const exec = JSON.parse(await fs.readFile(contentFile(v.id, env.dir, "execution.json"), "utf8"));
    const cut = exec.artifacts.filter((a: { role: string }) => a.role === "final-cut-candidate");
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({ path: "07-delivery/纠正AI.mp4", sha256: sha });
    expect(cut[0]).not.toHaveProperty("external");

    const result = await callVideo(env.dir, register, "codex");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const content = (await getContent(v.id, env.dir))!;
    expect(content.status).toBe("publish_ready");
    expect(content.video?.final?.sha256).toBe(sha);
    expect(content.assets.find(a => a.type === "video")?.projectPath).toBe("07-delivery/纠正AI.mp4");
    await expect(fs.access(path.join(v.root, "07-delivery/registered"))).rejects.toThrow();
    // 登记不再放 codex-g*-… 正式副本（「封面*.png」便携副本是封面定稿的既有行为，不归登记管）
    expect((await fs.readdir(path.join(v.root, "05-cover"), { recursive: true })).filter(f => String(f).includes("codex-"))).toEqual([]);
    expect(await sha256File(delivered)).toBe(sha);
    expect((await prepareEgoLitePublish(v.id, env.dir)).videoPath).toBe(delivered);
  });

  it("通过之后又导出（挪进来的字节变了）：register 回 approval_mismatch，文件原样不动，状态不推进", async () => {
    const v = await handedOff(env.dir, env.aroll);
    const { delivered, register } = await approvedAndMoved(v);
    await makeMp4(delivered, { freq: 880 });
    const before = await sha256File(delivered);
    const result = await callVideo(env.dir, register, "codex");
    expect(result).toMatchObject({ ok: false, code: "approval_mismatch" });
    expect(String(result.error)).toMatch(/导出文件变了，需要重新通过/);
    expect(await sha256File(delivered)).toBe(before);
    expect((await getContent(v.id, env.dir))?.status).toBe("editing");
  });

  it("report 故障都带码：代次不对回 stale_handoff 码，不是裸的「执行失败」", async () => {
    const v = await handedOff(env.dir, env.aroll);
    const res = await callVideo(env.dir, { action: "report", content_id: v.id, claim_token: v.token, _session: "editor-session",
      report: { request_id: "bad-gen", generation: 9, binding_revision: 1, session_id: "editor-session", result: "x", next_action: "y", files: [] } }, "codex");
    expect(res).toMatchObject({ ok: false, code: "stale_handoff" });
  });

  it("登记即交还认领：之后旧令牌再 report 回 already_registered，不重新认领；05-cover 里不多出「封面*」副本", async () => {
    const v = await handedOff(env.dir, env.aroll);
    const { delivered, register } = await approvedAndMoved(v);
    expect((await callVideo(env.dir, register, "codex")).ok).toBe(true);
    expect((await getContent(v.id, env.dir))?.claim).toBeUndefined();
    const late = await report(v, delivered, "final-cut");
    expect(late).toMatchObject({ ok: false, code: "already_registered" });
    expect(late).not.toHaveProperty("claim_token");
    expect((await getContent(v.id, env.dir))?.claim).toBeUndefined();
    const covers = (await fs.readdir(path.join(v.root, "05-cover"), { recursive: true })).map(String);
    expect(covers.filter((f) => path.basename(f).startsWith("封面"))).toEqual([]);
    // 重放同一份登记照样拿回结果
    expect(await callVideo(env.dir, register, "codex")).toMatchObject({ ok: true, replayed: true });
  });
});
