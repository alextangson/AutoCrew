/**
 * `autocrew_video register`（P6 spec §3.4 / §4 登记行）：路径门、审批凭据、四样同事务、
 * 登记后发布包真能解析到成片与封面（走 `prepareEgoLitePublish` 真实路径解析）。
 *
 * 夹具是资料库项目（v2）：凭据只认创始人在工作台记下的那份（report + founderProjectReview approve），
 * 自己算的一律 approval_mismatch；没绑资料库项目的旧稿（v1）登记整个不收。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getContent, getCoverReview, updateContent } from "../../../storage/local-store.js";
import { contentFile, initializeProjectLayout } from "../../../storage/content-project.js";
import { setVideoSettings } from "../../../desktop/settings-video.js";
import { listDiffs } from "../../learnings/diff-tracker.js";
import { prepareEgoLitePublish } from "../../publish/ego-lite.js";
import { founderProjectReview } from "./founder-review.js";
import { coverPairHash, sha256File } from "./manifest.js";
import { isRegisterInput, parseRegisterInput, registerVideo } from "./register.js";
import type { RegisterJournal } from "./register-commit.js";
import {
  approvalsFor,
  BODY,
  callVideo,
  handedOff,
  HAS_FFMPEG,
  makeFixture,
  makeMp4,
  seedAccepted,
  tokenIn,
  workbenchApprovals,
  writeJpeg,
  writePng,
  type HandoffFixture,
} from "./handoff-testkit.js";

type Approvals = Record<"final_cut" | "covers", Record<string, string>>;

let fx: HandoffFixture;
let exportDir: string;
let v: Awaited<ReturnType<typeof handedOff>>;
let contentId: string;
let project: string;
let final: string;
let cover34: string;
let cover43: string;
let srt: string;
let approvals: Approvals;

const SRT = [
  "1", "00:00:00,000 --> 00:00:02,000", "今天聊聊我怎么用 AI 工具省下每天两小时。", "",
  "2", "00:00:02,100 --> 00:00:04,000", "据麦肯锡报告，能省 30%。", "",
  "3", "00:00:06,000 --> 00:00:08,000", "第一步，把重复的事交出去。", "",
].join("\n");

beforeEach(async () => {
  fx = await makeFixture();
  await fs.unlink(path.join(fx.dir, "video.json"));
  await initializeProjectLayout(fx.dir, "lib-deadbeef", "default");
  exportDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-jianying-export-")));
  await setVideoSettings({ _dataDir: fx.dir, jianying_export_dir: exportDir });
  if (!HAS_FFMPEG) return;
  v = await handedOff(fx.dir, fx.aroll);
  contentId = v.id;
  project = v.root;
  final = await makeMp4(path.join(project, "07-delivery", "final.mp4"));
  cover34 = await writePng(path.join(project, "05-cover", "v01", "cover-3x4.png"), "three-four");
  cover43 = await writeJpeg(path.join(project, "05-cover", "v01", "cover-4x3.jpg"), "four-three");
  srt = path.join(project, "07-delivery", "final.srt");
  await fs.writeFile(srt, SRT);
  approvals = await workbenchApprovals(fx.dir, v, final, cover34, cover43) as Approvals;
});

afterEach(async () => {
  await fx.cleanup();
  await fs.rm(exportDir, { recursive: true, force: true });
});

function registerParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "register",
    content_id: contentId,
    manifest_hash: v.manifestHash,
    claim_token: v.token,
    final_path: final,
    covers: { "3:4": cover34, "4:3": cover43 },
    srt_path: srt,
    approvals,
    ...over,
  };
}

async function register(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return callVideo(fx.dir, registerParams(over), "codex");
}

/** 稿件目录 assets 下的所有文件名（递归；目录不存在 = 空） */
async function assetEntries(): Promise<string[]> {
  return (await fs.readdir(contentFile(contentId, fx.dir, "assets"), { recursive: true }).catch(() => [])).map(String);
}

/** 什么都没落：状态、戳、素材、评审单、日志都没动；v2 不暂存不复制，项目里的原件字节也原样 */
async function assertUntouched(): Promise<void> {
  const content = (await getContent(contentId, fx.dir))!;
  expect(content.status).toBe("editing");
  expect(content.videoDone).toBeUndefined();
  expect(content.video?.final).toBeUndefined();
  expect(content.assets.filter((a) => a.type === "video")).toEqual([]);
  expect(await getCoverReview(contentId, fx.dir)).toBeNull();
  expect((await assetEntries()).filter((n) => n.includes(".register-staging") || path.basename(n).startsWith("codex-g"))).toEqual([]);
  await expect(fs.access(contentFile(contentId, fx.dir, "handoff", "register-journal.json"))).rejects.toThrow();
  expect(await sha256File(final)).toBe(approvals.final_cut.artifact_sha256);
  expect(coverPairHash(await sha256File(cover34), await sha256File(cover43))).toBe(approvals.covers.artifact_sha256);
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
    expect(asset).toMatchObject({ role: "other", renderedRevision: 1, description: "Codex 剪辑成片 g1", projectPath: "07-delivery/final.mp4" });
    expect(asset.managedBy).toBeUndefined();
    expect(content.video?.final).toMatchObject({ path: final, generation: 1, register_hash: res.register_hash, registered_by: "codex" });
    expect(content.video?.final?.approvals).toEqual(approvals);

    // 原地登记：封面「副本」就是项目里被批准的那两张，不另复制
    const review = (await getCoverReview(contentId, fx.dir))!;
    expect(review).toMatchObject({ status: "publish_ready", approvedLabel: "codex" });
    expect(content.video?.final?.cover_copies).toEqual({ "3:4": cover34, "4:3": cover43 });
    expect(review.approvedImagePath).toBe(cover34);
    expect(review.approvedImagePath!.endsWith(".png")).toBe(true);
    expect(content.video?.final?.cover_copies["4:3"].endsWith(".jpg")).toBe(true);
    expect((await assetEntries()).filter((n) => path.basename(n).startsWith("codex-g"))).toEqual([]);

    // ego-lite 走真实路径解析：成片就是项目里的那份、封面是评审单里的批准图
    const pkg = await prepareEgoLitePublish(contentId, fx.dir);
    expect(pkg.videoPath).toBe(final);
    expect(pkg.coverPath).toBe(review.approvedImagePath);
    expect(await sha256File(pkg.videoPath)).toBe(approvals.final_cut.artifact_sha256);

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
    const bad = path.join(project, "07-delivery", "bad.srt");
    await fs.writeFile(bad, "1\n00:00\n你好\n");
    const malformed = await register({ srt_path: bad });
    expect(malformed).toMatchObject({ ok: false, code: "srt_invalid", which: "srt_path" });
    expect(String(malformed.error)).toContain("时间轴");
    await assertUntouched();
    await expect(fs.access(path.join(project, "01-script/spoken"))).rejects.toThrow();
  });

  it("同代次只换封面 = 新登记（v2），旧的进 history，代次不变", async () => {
    // 新一版封面先交给工作台（登记后剪辑 report 就收不进了），首登记用第 1 版
    const v2Cover34 = await writePng(path.join(project, "05-cover", "v02", "cover-3x4.png"), "three-four-v2");
    const v2Cover43 = await writeJpeg(path.join(project, "05-cover", "v02", "cover-4x3.jpg"), "four-three-v2");
    const reported = await v.report([{ file: v2Cover34, role: "cover:3:4", version: 2 }, { file: v2Cover43, role: "cover:4:3", version: 2 }]);
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    const first = await register();
    expect(first).toMatchObject({ ok: true });
    const a = await founderApproveCovers(v2Cover34, v2Cover43);
    cover34 = v2Cover34;
    cover43 = v2Cover43;
    const second = await register({ covers: { "3:4": cover34, "4:3": cover43 }, approvals: a });
    expect(second).toMatchObject({ ok: true, generation: 1 });
    expect(second.register_hash).not.toBe(first.register_hash);
    const content = (await getContent(contentId, fx.dir))!;
    expect(content.status).toBe("publish_ready");
    expect(content.video?.history?.map((h) => h.register_hash)).toEqual([first.register_hash]);
    expect((await getCoverReview(contentId, fx.dir))?.approvedImagePath).toBe(content.video?.final?.cover_copies["3:4"]);
    expect(content.video?.final?.cover_copies["3:4"]).toBe(v2Cover34);
  });
});

/** 登记后工作台改批另一对已 report 过的封面（剪辑的 report 在登记后已关门） */
async function founderApproveCovers(c34: string, c43: string): Promise<Approvals> {
  const rel = (f: string) => path.relative(project, f);
  const res = await founderProjectReview(contentId, fx.dir, { action: "approve", which: "covers", manifest_hash: v.manifestHash,
    files: [{ path: rel(c34), sha256: await sha256File(c34) }, { path: rel(c43), sha256: await sha256File(c43) }] });
  const a = res.approvals as Approvals;
  return { final_cut: a.final_cut, covers: a.covers };
}

describe.skipIf(!HAS_FFMPEG)("审批凭据（register-approval-mismatch）", () => {
  it("凭据对不上工作台记录、或文件字节对不上凭据就拒，指明哪一份，不回报实际哈希，什么都不落", async () => {
    // 篡改凭据里的哈希：工作台没有这份记录
    const badFinal = await register({ approvals: { ...approvals, final_cut: { ...approvals.final_cut, artifact_sha256: "a".repeat(64) } } });
    expect(badFinal).toMatchObject({ ok: false, code: "approval_mismatch" });
    expect(JSON.stringify(badFinal)).not.toContain(approvals.final_cut.artifact_sha256);
    const badCovers = await register({ approvals: { ...approvals, covers: { ...approvals.covers, artifact_sha256: "b".repeat(64) } } });
    expect(badCovers).toMatchObject({ ok: false, code: "approval_mismatch" });
    expect(JSON.stringify(badCovers)).not.toContain(approvals.covers.artifact_sha256);
    const badMessage = await register({ approvals: { ...approvals, final_cut: { ...approvals.final_cut, user_message: "成片可以" } } });
    expect(badMessage).toMatchObject({ ok: false, code: "approval_mismatch" });
    // 凭据是真的、但成片换成了没批过的另一份字节：指明 final_cut，不回报实际哈希
    const other = await makeMp4(path.join(project, "07-delivery", "other.mp4"), { freq: 880 });
    const wrongBytes = await register({ final_path: other });
    expect(wrongBytes).toMatchObject({ ok: false, code: "approval_mismatch", which: "final_cut" });
    expect(JSON.stringify(wrongBytes)).not.toContain(await sha256File(other));
    // 封面对调也不行：配对哈希有顺序
    const swapped = await register({ covers: { "3:4": cover43, "4:3": cover34 } });
    expect(swapped).toMatchObject({ ok: false, code: "approval_mismatch", which: "covers" });
    await assertUntouched();
  });

  it("字节全对、但凭据是自己算的（不是工作台记下的那份）→ approval_mismatch，什么都不落", async () => {
    const forged = await approvalsFor(final, cover34, cover43) as Approvals;
    expect(forged.final_cut.artifact_sha256).toBe(approvals.final_cut.artifact_sha256);
    expect(forged.covers.artifact_sha256).toBe(approvals.covers.artifact_sha256);
    expect(await register({ approvals: forged })).toMatchObject({ ok: false, code: "approval_mismatch" });
    await assertUntouched();
  });

  it("成片没音轨 → final_invalid；封面不是图 → cover_invalid；凭据形状不对 → invalid_params", async () => {
    // 产物核验先查容器再比哈希：没音轨的片子在比凭据之前就被拒
    const silent = await makeMp4(path.join(project, "07-delivery", "silent.mp4"), { audio: false });
    expect(await register({ final_path: silent })).toMatchObject({ ok: false, code: "final_invalid" });
    const text = path.join(project, "05-cover", "cover.txt");
    await fs.writeFile(text, "not an image");
    expect(await register({ covers: { "3:4": text, "4:3": cover43 } })).toMatchObject({ ok: false, code: "cover_invalid", which: "3:4" });
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
    const sibling = path.join(path.dirname(project), "另一个项目");
    await fs.mkdir(sibling);
    const siblingCover = await writePng(path.join(sibling, "c.png"), "x");
    expect(await register({ covers: { "3:4": siblingCover, "4:3": cover43 } })).toMatchObject({ ok: false, code: "path_not_whitelisted", which: "covers.3:4" });
    await assertUntouched();
  });

  it("register-symlink-rejected：文件本身或项目内某一段是符号链接都拒", async () => {
    const link = path.join(project, "07-delivery", "final-link.mp4");
    await fs.symlink(final, link);
    expect(await register({ final_path: link })).toMatchObject({ ok: false, code: "path_symlink" });
    const linkDir = path.join(project, "export-link");
    await fs.symlink(path.join(project, "07-delivery"), linkDir);
    expect(await register({ final_path: path.join(linkDir, "final.mp4") })).toMatchObject({ ok: false, code: "path_symlink" });
    await assertUntouched();
  });

  it("project-owned-by-other：交接后项目归属被改，登记拒收", async () => {
    // v2 的归属由资料库绑定核（resolveContentProject 对 .autocrew-owner 逐字段比对），在任何写动作之前就抛错
    const ownerFile = path.join(project, ".autocrew-owner");
    const original = await fs.readFile(ownerFile, "utf-8");
    await fs.writeFile(ownerFile, JSON.stringify({ content_id: "content-1-other" }));
    const res = await register();
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("project_owner_mismatch");
    // 归属改回来才读得到稿件的项目文件，再核什么都没落
    await fs.writeFile(ownerFile, original);
    await assertUntouched();
  });
});

describe.skipIf(!HAS_FFMPEG)("旧交接（stale-handoff-rejected）", () => {
  it("撤回重交之后，拿第 1 代交接包登记被拒，并指明当前代次", async () => {
    const revoked = await callVideo(fx.dir, { action: "revoke", content_id: contentId, claim_token: v.token });
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true);
    const second = await callVideo(fx.dir, { action: "handoff", content_id: contentId, aroll_path: fx.aroll, claim_token: revoked.claim_token });
    expect(second).toMatchObject({ ok: true, generation: 2 });
    const late = await register();
    expect(late).toMatchObject({ ok: false, code: "stale_handoff", current_generation: 2, expected_manifest_hash: second.manifest_hash });
    expect((await getContent(contentId, fx.dir))?.status).toBe("editing");
  });
});

describe.skipIf(!HAS_FFMPEG)("四样同事务（register-atomic）", () => {
  it("成片戳盖不上：已写的素材、封面评审单全部回滚，项目里的原件不被删，状态不推进", async () => {
    const parsed = parseRegisterInput(registerParams(), contentId, "codex");
    if (!isRegisterInput(parsed)) throw new Error("参数解析失败");
    const res = await registerVideo(parsed, {
      dataDir: fx.dir,
      gate: async () => ({ grant: {} }),
      stamp: async () => ({ videoReadyAt: null, stampWarning: "模拟：成片戳落盘失败" }),
    });
    expect(res).toMatchObject({ ok: false, code: "register_failed" });
    expect(String(res.error)).toContain("模拟：成片戳落盘失败");
    // assertUntouched 里核了项目内成片与两张封面仍在、字节未变（原地登记的回滚绝不能删项目文件）
    await assertUntouched();
    // 回滚之后同一份登记可以正常重来
    expect(await register()).toMatchObject({ ok: true, status: "registered" });
  });

  it("进程崩在半路留下的日志：下一次登记进门先按日志回滚", async () => {
    const before = (await getContent(contentId, fx.dir))!;
    const orphan = contentFile(contentId, fx.dir, "assets", "final-g1-orphan.mp4");
    await fs.mkdir(path.dirname(orphan), { recursive: true });
    await fs.writeFile(orphan, "half");
    const journal: RegisterJournal = {
      register_hash: "f".repeat(64),
      started_at: new Date().toISOString(),
      created: [orphan],
      prev: { coverReviewRaw: null, assets: before.assets, video: before.video, claim: before.claim, handoffs: before.handoffs },
    };
    const journalFile = contentFile(contentId, fx.dir, "handoff", "register-journal.json");
    await fs.mkdir(path.dirname(journalFile), { recursive: true });
    await fs.writeFile(journalFile, JSON.stringify(journal));
    // 模拟崩溃前已盖的戳
    await updateContent(contentId, { videoDone: { renderedRevision: 1, at: "2026-09-25T00:00:00Z" } }, fx.dir);

    const res = await register({ final_path: path.join(project, "07-delivery", "x.mp4") });
    expect(res).toMatchObject({ ok: false, code: "path_missing" });
    await expect(fs.access(orphan)).rejects.toThrow();
    await assertUntouched();
  });
});

describe.skipIf(!HAS_FFMPEG)("没绑资料库项目的旧稿（v1）", () => {
  let old: HandoffFixture;
  beforeEach(async () => { old = await makeFixture(); });
  afterEach(async () => { await old.cleanup(); });

  it("工作台没有批准入口：自己算的凭据一律 approval_mismatch，状态不推进、不盖戳、不建封面评审单", async () => {
    const id = (await seedAccepted(old.dir)).id;
    const handoff = await callVideo(old.dir, { action: "handoff", content_id: id, aroll_path: old.aroll });
    expect(handoff.ok, JSON.stringify(handoff)).toBe(true);
    const root = String(handoff.project_root);
    const f = await makeMp4(path.join(root, "05-export", "final.mp4"));
    const c34 = await writePng(path.join(root, "06-cover", "cover-3x4.png"), "three-four");
    const c43 = await writeJpeg(path.join(root, "06-cover", "cover-4x3.jpg"), "four-three");
    const s = path.join(root, "05-export", "final.srt");
    await fs.writeFile(s, SRT);
    const res = await callVideo(old.dir, {
      action: "register", content_id: id, manifest_hash: handoff.manifest_hash, claim_token: await tokenIn(String(handoff.handoff_path)),
      final_path: f, covers: { "3:4": c34, "4:3": c43 }, srt_path: s, approvals: await approvalsFor(f, c34, c43),
    }, "codex");
    expect(res).toMatchObject({ ok: false, code: "approval_mismatch" });
    const content = (await getContent(id, old.dir))!;
    expect(content.status).toBe("editing");
    expect(content.videoDone).toBeUndefined();
    expect(content.video?.final).toBeUndefined();
    expect(await getCoverReview(id, old.dir)).toBeNull();
  });
});
