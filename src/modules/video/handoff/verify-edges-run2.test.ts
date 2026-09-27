/**
 * verifier 第二轮真机验收（preview :4318，2026-09-27 23:20–23:45）补的边界。
 * 弹窗与转写全用假的，绝不弹真窗；媒体用真 ffmpeg 合成。
 *
 * 故意保留失败的用例 = 发现（实现与 spec 不符），不改断言去迁就实现。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { callVideo, HAS_FFMPEG, makeFixture, makeMp4, seedAccepted, type HandoffFixture } from "./handoff-testkit.js";
import { initializeProjectLayout, resolveContentProject } from "../../../storage/content-project.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { saveCoverage } from "./project-evidence.js";
import { setPullDeps } from "./pull-deps.js";
import { sha256File } from "./manifest.js";
import type { DialogRunner } from "./dialog.js";

let fx: HandoffFixture;

beforeEach(async () => {
  fx = await makeFixture();
  await fs.unlink(path.join(fx.dir, "video.json"));
  await initializeProjectLayout(fx.dir, "lib-deadbeef", "default");
  const dialog: DialogRunner = {
    choose: async (o) => ({ kind: "ok", value: o.items[0] }),
    ask: async () => ({ kind: "ok", value: "确认" }),
    input: async () => ({ kind: "timeout" }),
  };
  setPullDeps({ dialog, transcriber: { transcribe: async () => ({ ok: false, unavailable: true, reason: "测试不转写" }) } });
});
afterEach(async () => { setPullDeps(null); await fx.cleanup(); });

const TITLE = "你每天纠正 AI 同一件事？它根本不会从纠正里学";
const codex = (params: Record<string, unknown>) => callVideo(fx.dir, params, "codex");

async function cited(): Promise<Content> {
  const c = await seedAccepted(fx.dir, TITLE);
  const first = c.body.slice(0, c.body.indexOf("。") + 1);
  await saveCoverage(c, { draft_hash: draftHash(c), citations: [{ start: 0, end: first.length, excerpt: first, evidence_id: "creator", sourceType: "creator_opinion", quote: "", verification: "亲历" }], reviewed_by: "writer", reviewed_at: new Date().toISOString() }, fx.dir);
  return (await getContent(c.id, fx.dir))!;
}

/** match → confirm → handoff，一路 Codex 发起 */
async function pull(c: Content, aroll: string): Promise<Record<string, unknown>> {
  const m = await codex({ action: "match", aroll_path: aroll, request_id: "m-1" });
  const cfm = await codex({ action: "confirm", receipt_id: m.receipt_id, cover_text: "AI 不会从纠正里学", target_seconds: 480, request_id: "c-1" });
  expect(cfm).toMatchObject({ ok: true, status: "confirmed" });
  return codex({ action: "handoff", content_id: c.id, aroll_path: aroll, confirmation_id: cfm.confirmation_id, request_id: "h-1" });
}

describe.skipIf(!HAS_FFMPEG)("verifier 第二轮补边界：项目目录缺空子目录", () => {
  // 真机复现（2026-09-27 23:28）：沙盒项目 01-script 下没有 handoff/ 空目录，
  // handoff 回 handoff_rejected「ENOENT … scandir '…/01-script/handoff'」。
  // 根因：handoff.ts nextGeneration 的已绑定分支对 readdir 没兜 ENOENT（未绑定分支兜了）。
  // 空目录丢失很常见（同步盘、git、只拷文件的迁移）；第一次交接不该因为「还没有旧代次目录」失败。
  it("第一次交接：项目里没有 01-script/handoff 目录也能交接成功", async () => {
    const c = await cited();
    const root = resolveContentProject(c.id, fx.dir)!.project_root;
    await fs.rm(path.join(root, "01-script/handoff"), { recursive: true, force: true });
    const aroll = await makeMp4(path.join(fx.outside, `${TITLE} take 2.mov`));
    const h = await pull(c, aroll);
    expect(String(h.error ?? "")).not.toMatch(/ENOENT/);
    expect(h).toMatchObject({ ok: true, status: "handed_off", generation: 1 });
  });

  // 真机复现（2026-09-27 23:31）：项目里没有 00-project/notes/execution-reports，
  // 心跳 report 回「report 执行失败：ENOENT … execution-reports/<request_id>.json.tmp-…」（且没有 code 字段）。
  it("心跳 report：项目里没有 00-project/notes/execution-reports 目录也能落盘", async () => {
    const c = await cited();
    const aroll = await makeMp4(path.join(fx.outside, `${TITLE} take 2.mov`));
    const h = await pull(c, aroll);
    expect(h).toMatchObject({ ok: true, claim_token: expect.stringMatching(/^clm-/) });
    const root = String(h.project_root);
    await fs.rm(path.join(root, "00-project/notes/execution-reports"), { recursive: true, force: true });
    const res = await callVideo(fx.dir, {
      action: "report", content_id: c.id, claim_token: h.claim_token, _session: "editor-session",
      report: { request_id: "r-hb-1", generation: 1, binding_revision: 1, session_id: "editor-session", files: [], result: "开始粗剪", next_action: "出粗剪" },
    }, "codex");
    expect(String(res.error ?? "")).not.toMatch(/ENOENT/);
    expect(res).toMatchObject({ ok: true });
  });

  it("对照：目录齐全时同一流程交接成功、原片原名挪进 02-aroll、哈希不变", async () => {
    const c = await cited();
    const name = `${TITLE} take 2.mov`;
    const aroll = await makeMp4(path.join(fx.outside, name));
    const sha = await sha256File(aroll);
    const h = await pull(c, aroll);
    expect(h).toMatchObject({ ok: true, aroll_moved_to: path.join(String(h.project_root), "02-aroll", name) });
    expect(await sha256File(String(h.aroll_moved_to))).toBe(sha);
  });
});
