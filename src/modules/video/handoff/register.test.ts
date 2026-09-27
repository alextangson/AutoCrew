/**
 * `autocrew_video register`（P6 spec §3.4 / §4 登记行）：路径门、审批凭据、四样同事务、
 * 登记后发布包真能解析到成片与封面（走 `prepareEgoLitePublish` 真实路径解析）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, getCoverReview, updateContent } from "../../../storage/local-store.js";
import { listDiffs } from "../../learnings/diff-tracker.js";
import { prepareEgoLitePublish } from "../../publish/ego-lite.js";
import { isRegisterInput, parseRegisterInput, registerVideo } from "./register.js";
import type { RegisterJournal } from "./register-commit.js";
import {
  approvalsFor,
  BODY,
  callVideo,
  HAS_FFMPEG,
  makeFixture,
  makeMp4,
  seedAccepted,
  tokenIn,
  writeJpeg,
  writePng,
  type HandoffFixture,
} from "./handoff-testkit.js";

let fx: HandoffFixture;
let contentId: string;
let project: string;
let manifest: string;
let token: string;
let final: string;
let cover34: string;
let cover43: string;
let srt: string;

const SRT = [
  "1", "00:00:00,000 --> 00:00:02,000", "今天聊聊我怎么用 AI 工具省下每天两小时。", "",
  "2", "00:00:02,100 --> 00:00:04,000", "据麦肯锡报告，能省 30%。", "",
  "3", "00:00:06,000 --> 00:00:08,000", "第一步，把重复的事交出去。", "",
].join("\n");

async function handedOff(): Promise<Record<string, unknown>> {
  const res = await callVideo(fx.dir, { action: "handoff", content_id: contentId, aroll_path: fx.aroll });
  expect(res.ok).toBe(true);
  project = String(res.project_root);
  manifest = String(res.manifest_hash);
  token = await tokenIn(String(res.handoff_path));
  return res;
}

beforeEach(async () => {
  fx = await makeFixture();
  contentId = (await seedAccepted(fx.dir)).id;
  if (!HAS_FFMPEG) return;
  await handedOff();
  final = await makeMp4(path.join(project, "05-export", "final.mp4"));
  cover34 = await writePng(path.join(project, "06-cover", "cover-3x4.png"), "three-four");
  cover43 = await writeJpeg(path.join(project, "06-cover", "cover-4x3.jpg"), "four-three");
  srt = path.join(project, "05-export", "final.srt");
  await fs.writeFile(srt, SRT);
});

afterEach(async () => {
  await fx.cleanup();
});

async function registerParams(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    action: "register",
    content_id: contentId,
    manifest_hash: manifest,
    claim_token: token,
    final_path: final,
    covers: { "3:4": cover34, "4:3": cover43 },
    srt_path: srt,
    approvals: await approvalsFor(final, cover34, cover43),
    ...over,
  };
}

async function register(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return callVideo(fx.dir, await registerParams(over), "codex");
}

async function assertUntouched(): Promise<void> {
  const content = (await getContent(contentId, fx.dir))!;
  expect(content.status).toBe("editing");
  expect(content.videoDone).toBeUndefined();
  expect(content.video?.final).toBeUndefined();
  expect(content.assets.filter((a) => a.type === "video")).toEqual([]);
  expect(await getCoverReview(contentId, fx.dir)).toBeNull();
  const assetsDir = path.join(fx.dir, "contents", contentId, "assets");
  expect((await fs.readdir(assetsDir)).filter((n) => n.startsWith(".register-staging"))).toEqual([]);
  await expect(fs.access(path.join(fx.dir, "contents", contentId, "handoff", "register-journal.json"))).rejects.toThrow();
}

describe.skipIf(!HAS_FFMPEG)("登记成功（register-to-ego-lite）", () => {
  it("四样落盘、状态到待发布、发布包解析到成片与封面；重发 = 重放", async () => {
    const res = await register();
    expect(res).toMatchObject({ ok: true, status: "registered", generation: 1, content_status: "publish_ready" });
    expect(res.next_action).toMatchObject({ tool: "autocrew_pre_publish", params: { action: "video_kit", content_id: contentId } });
    expect(res.video_ready_at).toBeTruthy();

    const content = (await getContent(contentId, fx.dir))!;
    expect(content.status).toBe("publish_ready");
    expect(content.videoDone?.renderedRevision).toBe(1);
    expect(content.claim).toBeUndefined();
    const asset = content.assets.find((a) => a.type === "video")!;
    expect(asset).toMatchObject({ role: "other", renderedRevision: 1, description: "Codex 剪辑成片 g1" });
    expect(asset.managedBy).toBeUndefined();
    expect(content.video?.final).toMatchObject({ path: final, generation: 1, register_hash: res.register_hash, registered_by: "codex" });
    expect(content.video?.final?.approvals.final_cut.user_message).toBe("成片可以");

    const review = (await getCoverReview(contentId, fx.dir))!;
    expect(review).toMatchObject({ status: "publish_ready", approvedLabel: "codex" });
    expect(review.approvedImagePath).toBe(content.video?.final?.cover_copies["3:4"]);
    expect(review.approvedImagePath!.endsWith(".png")).toBe(true);
    expect(content.video?.final?.cover_copies["4:3"].endsWith(".jpg")).toBe(true);

    // ego-lite 走真实路径解析：成片在 assets/ 下、封面是评审单里的批准图
    const pkg = await prepareEgoLitePublish(contentId, fx.dir);
    expect(pkg.videoPath).toBe(path.join(fx.dir, "contents", contentId, "assets", asset.filename));
    expect(pkg.coverPath).toBe(review.approvedImagePath);
    expect(await fs.readFile(pkg.videoPath)).toEqual(await fs.readFile(final));

    const again = await register();
    expect(again).toMatchObject({ ok: true, replayed: true, register_hash: res.register_hash });
  });

  it("字幕还原成实拍版口播存进项目，记一条「定稿 → 实拍」差异；重放不重复记", async () => {
    const res = await register();
    expect(res).toMatchObject({ ok: true, status: "registered" });
    expect(res.warning).toBeUndefined();
    const spoken = await fs.readFile(path.join(project, "01-script/spoken/g0001-spoken.md"), "utf-8");
    expect(spoken).toBe("今天聊聊我怎么用 AI 工具省下每天两小时。据麦肯锡报告，能省 30%。\n\n第一步，把重复的事交出去。\n");
    const diffs = (await listDiffs({ contentId }, fx.dir)).filter((d) => d.changeType === "实拍口播与定稿的差异");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ field: "body", before: BODY, after: spoken, platform: "douyin" });
    expect(await register()).toMatchObject({ ok: true, replayed: true });
    expect((await listDiffs({ contentId }, fx.dir)).filter((d) => d.changeType === "实拍口播与定稿的差异")).toHaveLength(1);
  });

  it("视频稿不带 srt_path → invalid_params，说清要成片字幕；字幕格式不对 → srt_invalid，什么都不落", async () => {
    const missing = await register({ srt_path: undefined });
    expect(missing).toMatchObject({ ok: false, code: "invalid_params", which: "srt_path" });
    expect(String(missing.error)).toContain("字幕");
    const bad = path.join(project, "05-export", "bad.srt");
    await fs.writeFile(bad, "1\n00:00\n你好\n");
    const malformed = await register({ srt_path: bad });
    expect(malformed).toMatchObject({ ok: false, code: "srt_invalid", which: "srt_path" });
    expect(String(malformed.error)).toContain("时间轴");
    await assertUntouched();
    await expect(fs.access(path.join(project, "01-script/spoken"))).rejects.toThrow();
  });

  it("同代次只换封面 = 新登记（v2），旧的进 history，代次不变", async () => {
    const first = await register();
    cover34 = await writePng(path.join(project, "06-cover", "cover-3x4-v2.png"), "three-four-v2");
    const second = await register({ covers: { "3:4": cover34, "4:3": cover43 }, approvals: await approvalsFor(final, cover34, cover43) });
    expect(second).toMatchObject({ ok: true, generation: 1 });
    expect(second.register_hash).not.toBe(first.register_hash);
    const content = (await getContent(contentId, fx.dir))!;
    expect(content.status).toBe("publish_ready");
    expect(content.video?.history?.map((h) => h.register_hash)).toEqual([first.register_hash]);
    expect((await getCoverReview(contentId, fx.dir))?.approvedImagePath).toBe(content.video?.final?.cover_copies["3:4"]);
  });
});

describe.skipIf(!HAS_FFMPEG)("审批凭据（register-approval-mismatch）", () => {
  it("成片或封面对不上凭据就拒，指明哪一份，不回报实际哈希，什么都不落", async () => {
    const approvals = await approvalsFor(final, cover34, cover43) as Record<string, Record<string, string>>;
    const badFinal = await register({ approvals: { ...approvals, final_cut: { ...approvals.final_cut, artifact_sha256: "a".repeat(64) } } });
    expect(badFinal).toMatchObject({ ok: false, code: "approval_mismatch", which: "final_cut" });
    expect(JSON.stringify(badFinal)).not.toContain(approvals.final_cut.artifact_sha256);
    const badCovers = await register({ approvals: { ...approvals, covers: { ...approvals.covers, artifact_sha256: "b".repeat(64) } } });
    expect(badCovers).toMatchObject({ ok: false, code: "approval_mismatch", which: "covers" });
    // 封面对调也不行：配对哈希有顺序
    const swapped = await register({ covers: { "3:4": cover43, "4:3": cover34 } });
    expect(swapped).toMatchObject({ ok: false, code: "approval_mismatch", which: "covers" });
    await assertUntouched();
  });

  it("成片没音轨 → final_invalid；封面不是图 → cover_invalid；凭据形状不对 → invalid_params", async () => {
    const silent = await makeMp4(path.join(project, "05-export", "silent.mp4"), { audio: false });
    expect(await register({ final_path: silent, approvals: await approvalsFor(silent, cover34, cover43) })).toMatchObject({ ok: false, code: "final_invalid" });
    const text = path.join(project, "06-cover", "cover.txt");
    await fs.writeFile(text, "not an image");
    expect(await register({ covers: { "3:4": text, "4:3": cover43 } })).toMatchObject({ ok: false, code: "cover_invalid", which: "3:4" });
    const approvals = await approvalsFor(final, cover34, cover43) as Record<string, Record<string, string>>;
    expect(await register({ approvals: { ...approvals, final_cut: { ...approvals.final_cut, approved_at: "昨天" } } })).toMatchObject({ ok: false, code: "invalid_params" });
    await assertUntouched();
  });
});

describe.skipIf(!HAS_FFMPEG)("路径门（登记侧）", () => {
  it("register-path-guard：白名单外 / 不存在 / 别的项目目录一律拒", async () => {
    const outsideFinal = path.join(fx.outside, "final.mp4");
    await fs.copyFile(final, outsideFinal);
    expect(await register({ final_path: outsideFinal })).toMatchObject({ ok: false, code: "path_not_whitelisted", which: "final_path" });
    expect(await register({ final_path: path.join(project, "nope.mp4") })).toMatchObject({ ok: false, code: "path_missing" });
    const sibling = path.join(fx.root, "另一个项目");
    await fs.mkdir(sibling);
    const siblingCover = await writePng(path.join(sibling, "c.png"), "x");
    expect(await register({ covers: { "3:4": siblingCover, "4:3": cover43 } })).toMatchObject({ ok: false, code: "path_not_whitelisted", which: "covers.3:4" });
    await assertUntouched();
  });

  it("register-symlink-rejected：文件本身或项目内某一段是符号链接都拒", async () => {
    const link = path.join(project, "05-export", "final-link.mp4");
    await fs.symlink(final, link);
    expect(await register({ final_path: link })).toMatchObject({ ok: false, code: "path_symlink" });
    const linkDir = path.join(project, "export-link");
    await fs.symlink(path.join(project, "05-export"), linkDir);
    expect(await register({ final_path: path.join(linkDir, "final.mp4") })).toMatchObject({ ok: false, code: "path_symlink" });
    await assertUntouched();
  });

  it("project-owned-by-other：交接后项目归属被改，登记拒收", async () => {
    await fs.writeFile(path.join(project, ".autocrew-owner"), JSON.stringify({ content_id: "content-1-other" }));
    expect(await register()).toMatchObject({ ok: false, code: "project_owned_by_other", owner: "content-1-other" });
    await assertUntouched();
  });
});

describe.skipIf(!HAS_FFMPEG)("旧交接（stale-handoff-rejected）", () => {
  it("撤回重交之后，拿第 1 代交接包登记被拒，并指明当前代次", async () => {
    const oldManifest = manifest;
    const oldToken = token;
    const revoked = await callVideo(fx.dir, { action: "revoke", content_id: contentId, claim_token: token });
    expect(revoked.ok).toBe(true);
    const second = await callVideo(fx.dir, { action: "handoff", content_id: contentId, aroll_path: fx.aroll, claim_token: revoked.claim_token });
    expect(second).toMatchObject({ ok: true, generation: 2 });
    const late = await register({ manifest_hash: oldManifest, claim_token: oldToken });
    expect(late).toMatchObject({ ok: false, code: "stale_handoff", current_generation: 2, expected_manifest_hash: second.manifest_hash });
    expect((await getContent(contentId, fx.dir))?.status).toBe("editing");
  });
});

describe.skipIf(!HAS_FFMPEG)("四样同事务（register-atomic）", () => {
  it("成片戳盖不上：已写的素材、封面评审单全部回滚，状态不推进", async () => {
    const parsed = parseRegisterInput(await registerParams(), contentId, "codex");
    if (!isRegisterInput(parsed)) throw new Error("参数解析失败");
    const res = await registerVideo(parsed, {
      dataDir: fx.dir,
      gate: async () => ({ grant: {} }),
      stamp: async () => ({ videoReadyAt: null, stampWarning: "模拟：成片戳落盘失败" }),
    });
    expect(res).toMatchObject({ ok: false, code: "register_failed" });
    expect(String(res.error)).toContain("模拟：成片戳落盘失败");
    await assertUntouched();
    const covers = await fs.readdir(path.join(fx.dir, "contents", contentId, "assets", "covers")).catch(() => []);
    expect(covers).toEqual([]);
    // 回滚之后同一份登记可以正常重来
    expect(await register()).toMatchObject({ ok: true, status: "registered" });
  });

  it("进程崩在半路留下的日志：下一次登记进门先按日志回滚", async () => {
    const before = (await getContent(contentId, fx.dir))!;
    const orphan = path.join(fx.dir, "contents", contentId, "assets", "final-g1-orphan.mp4");
    await fs.writeFile(orphan, "half");
    const journal: RegisterJournal = {
      register_hash: "f".repeat(64),
      started_at: new Date().toISOString(),
      created: [orphan],
      prev: { coverReviewRaw: null, assets: before.assets, video: before.video, claim: before.claim, handoffs: before.handoffs },
    };
    const journalFile = path.join(fx.dir, "contents", contentId, "handoff", "register-journal.json");
    await fs.writeFile(journalFile, JSON.stringify(journal));
    // 模拟崩溃前已盖的戳
    await updateContent(contentId, { videoDone: { renderedRevision: 1, at: "2026-09-25T00:00:00Z" } }, fx.dir);

    const res = await register({ final_path: path.join(fx.outside, "x.mp4") });
    expect(res).toMatchObject({ ok: false, code: "path_missing" });
    await expect(fs.access(orphan)).rejects.toThrow();
    await assertUntouched();
  });
});
