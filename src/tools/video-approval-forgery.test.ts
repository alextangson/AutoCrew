/**
 * 批准伪造（P6 §14.7 #1）：视频稿的成片审过、封面定稿是创始人在工作台上的决定（gate3 / gate4），
 * 只该由浏览器会话路由写。MCP 宿主拿着认领令牌，不能靠旧入口盖出这两枚标记、再把稿推进「待发布」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveContent, getContent, getCoverReview, saveCoverReview, transitionStatus, updateContent, approveCoverVariant, VideoCoverApprovalRefused, type ContentUpdates } from "../storage/local-store.js";
import { claimContent } from "../storage/claims.js";
import { setVideoService } from "../modules/video/service-registry.js";
import type { VideoService } from "../modules/video/service.js";
import { executeVideo } from "./video.js";
import { executeCoverReview } from "./cover-review.js";
import { executeContentSave } from "./content-save.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

let dir: string;

/** 内置剪辑线的替身：审片通过即回 done，只为让工具走到盖戳那一步 */
const stubService = {
  confirmReview: async (_id: string, args: { verdict: string }) =>
    args.verdict === "approve" ? { phase: "done", state: "done", revisions: { rendered: 1 } } : { phase: "edit", state: "awaiting_human", revisions: { rendered: 1 } },
} as unknown as VideoService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-forgery-"));
  setVideoService(stubService, dir);
});
afterEach(async () => {
  setVideoService(null);
  await fs.rm(dir, { recursive: true, force: true });
});

/** 一条已正常交接、正在剪辑的抖音稿，宿主 claude 握着认领 */
async function editingVideo(): Promise<{ id: string; token: string }> {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "口播稿", body: "口播正文。".repeat(200), platform: "douyin", status: "approved" }, dir);
  const moved = await transitionStatus(c.id, "editing", { viaHandoff: true }, dir);
  if (!moved.ok) throw new Error(moved.error);
  await saveCoverReview(c.id, { platform: "douyin", status: "review_pending", variants: [{ label: "a", imagePaths: { "3:4": "/tmp/a.png" } }] }, dir);
  const claimed = await claimContent(c.id, "editor", "claude", dir);
  if (!claimed.ok) throw new Error(claimed.error);
  return { id: c.id, token: claimed.claim.token };
}

describe("MCP 宿主不能伪造视频稿的创始人批准", () => {
  it("video review approve + cover_review approve 之后，content transition 推不进待发布", async () => {
    const { id, token } = await editingVideo();
    const host = { _dataDir: dir, _host: "claude", claim_token: token, content_id: id };

    await executeVideo({ ...host, action: "review", rendered_revision: 1, verdict: "approve" });
    await executeCoverReview({ ...host, action: "approve", label: "a" });
    const moved = await executeContentSave({ _provenance: HUMAN_WRITE, ...host, action: "transition", id, target_status: "publish_ready" });

    expect(moved).toMatchObject({ ok: false });
    expect((await getContent(id, dir))!.status).toBe("editing");
  });

  it("两个批准入口对模型调用都当场拒（founder_only），标记一枚都没盖", async () => {
    const { id, token } = await editingVideo();
    const host = { _dataDir: dir, _host: "claude", claim_token: token, content_id: id };
    expect(await executeVideo({ ...host, action: "review", rendered_revision: 1, verdict: "approve" })).toMatchObject({ ok: false, code: "founder_only" });
    expect(await executeCoverReview({ ...host, action: "approve", label: "a" })).toMatchObject({ ok: false, code: "founder_only" });
    // OpenClaw 模型调用不带 _host、带 _modelCall，同样拒
    expect(await executeCoverReview({ _dataDir: dir, _modelCall: true, claim_token: token, content_id: id, action: "approve", label: "a" })).toMatchObject({ code: "founder_only" });
    expect((await getContent(id, dir))!.videoDone).toBeUndefined();
    expect((await getCoverReview(id, dir))!.approvedLabel).toBeUndefined();
  });

  it("宿主照常能替创作者报打回", async () => {
    const { id, token } = await editingVideo();
    const res = await executeVideo({ _dataDir: dir, _host: "claude", claim_token: token, content_id: id, action: "review", rendered_revision: 1, verdict: "revise", target: "edit", note: "开头再紧一点" });
    expect(res).toMatchObject({ ok: true });
  });

  it("工作台 / 桌面的人手点击（不带 _host）照常定封面", async () => {
    const { id } = await editingVideo();
    expect(await executeCoverReview({ _dataDir: dir, content_id: id, action: "approve", label: "a" })).toMatchObject({ ok: true });
    expect((await getCoverReview(id, dir))!.approvedLabel).toBe("a");
  });

  it("公众号封面流程不变：宿主照样能选用", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "长文", body: "正文。".repeat(200), platform: "wechat_mp", status: "approved" }, dir);
    await saveCoverReview(c.id, { platform: "wechat_mp", status: "review_pending", variants: [{ label: "a", imagePaths: { "2.35:1": "/tmp/a.png" } }] }, dir);
    expect(await executeCoverReview({ _dataDir: dir, _host: "claude", content_id: c.id, action: "approve", label: "a" })).toMatchObject({ ok: true });
    expect((await getCoverReview(c.id, dir))!.approvedLabel).toBe("a");
  });

  it("剪辑之后宿主不能把视频稿临时改成公众号再绕回来（改平台被拒）", async () => {
    const { id, token } = await editingVideo();
    const host = { _dataDir: dir, _host: "claude", claim_token: token };
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, ...host, action: "update", id, platform: "wechat_mp" })).toMatchObject({ ok: false, code: "platform_locked" });
    expect((await getContent(id, dir))!.platform).toBe("douyin");
    // 视频平台之间互换不受影响
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, ...host, action: "update", id, platform: "xiaohongshu" })).toMatchObject({ ok: true });
  });

  it("已按公众号进了待发布的稿，宿主不能再改回视频平台", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "长文", body: "正文。".repeat(200), platform: "wechat_mp", status: "approved" }, dir);
    expect((await transitionStatus(c.id, "publish_ready", {}, dir)).ok).toBe(true);
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: dir, _host: "claude", action: "update", id: c.id, platform: "douyin" })).toMatchObject({ ok: false, code: "platform_locked" });
  });

  it("退回已过审也解不开平台锁：交接过的视频稿，宿主改平台照样被拒", async () => {
    const { id, token } = await editingVideo();
    const host = { _dataDir: dir, _host: "claude", claim_token: token };
    // 真交接会留下交接记录（这里只补上记录本身，形状见 VideoHandoffRecord）
    await updateContent(id, { _provenance: HUMAN_WRITE, video: { handoff: { generation: 1, hash: "a".repeat(64) } } } as unknown as ContentUpdates, dir);
    // 本体 §2.1：模型连退回「已过审」也不行（认稿及之后只归创始人）；退回由创始人在工作台做
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, ...host, action: "transition", id, target_status: "approved" })).toMatchObject({ ok: false, code: "founder_decision_required" });
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: dir, claim_token: token, action: "transition", id, target_status: "approved" })).toMatchObject({ ok: true });
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, ...host, action: "update", id, platform: "wechat_mp" })).toMatchObject({ ok: false, code: "platform_locked" });
  });

  it("交接前：公众号身份下选了封面，就不能再改回视频平台", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "长文", body: "正文。".repeat(200), platform: "wechat_mp", status: "approved" }, dir);
    await saveCoverReview(c.id, { platform: "wechat_mp", status: "review_pending", variants: [{ label: "a", imagePaths: { "3:4": "/tmp/a.png" } }] }, dir);
    const host = { _dataDir: dir, _host: "claude" };
    const approved = await executeCoverReview({ ...host, content_id: c.id, action: "approve", label: "a" });
    expect(approved).toMatchObject({ ok: true });
    const token = approved.claim_token as string;
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, ...host, claim_token: token, action: "update", id: c.id, platform: "douyin" })).toMatchObject({ ok: false, code: "platform_locked" });
  });

  it("没有成片戳：宿主 force 从已过审直推封面台被阶段门拦下", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "口播稿", body: "口播正文。".repeat(200), platform: "douyin", status: "approved" }, dir);
    const moved = await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: dir, _host: "claude", action: "transition", id: c.id, target_status: "cover_pending", force: true });
    expect(moved).toMatchObject({ ok: false, blocked: true });
    expect((await getContent(c.id, dir))!.status).toBe("approved");
  });

  it("OpenClaw 模型调用（只带 _modelCall）同样改不了平台", async () => {
    const { id, token } = await editingVideo();
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: dir, _modelCall: true, claim_token: token, action: "update", id, platform: "wechat_mp" })).toMatchObject({ ok: false, code: "platform_locked" });
  });

  it("并发：公众号身份推进待发布与改回抖音同时发，结局绝不是「抖音 + 待发布 + 没成片戳」", async () => {
    for (let round = 0; round < 10; round++) {
      const c = await saveContent({ _provenance: HUMAN_WRITE, title: `口播稿${round}`, body: "口播正文。".repeat(200), platform: "wechat_mp", status: "approved" }, dir);
      const host = { _dataDir: dir, _host: "claude" };
      const first = await executeContentSave({ _provenance: HUMAN_WRITE, ...host, action: "update", id: c.id, title: `口播稿${round}` });
      const token = first.claim_token as string;
      await Promise.all([
        executeContentSave({ _provenance: HUMAN_WRITE, ...host, claim_token: token, action: "transition", id: c.id, target_status: "publish_ready" }),
        executeContentSave({ _provenance: HUMAN_WRITE, ...host, claim_token: token, action: "update", id: c.id, platform: "douyin" }),
      ]);
      const after = (await getContent(c.id, dir))!;
      expect(after.platform === "douyin" && after.status === "publish_ready" && !after.videoDone, `round ${round}`).toBe(false);
    }
  });

  it("锁内复核：锁外按公众号放行后平台被改成抖音，模型调用的定封面在写锁里被拒", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "口播稿", body: "口播正文。".repeat(200), platform: "wechat_mp", status: "approved" }, dir);
    await saveCoverReview(c.id, { platform: "wechat_mp", status: "review_pending", variants: [{ label: "a", imagePaths: { "3:4": "/tmp/a.png" } }] }, dir);
    // 模拟并发：锁外预检之后、拿到写锁之前，平台已被另一个调用改成抖音
    await updateContent(c.id, { _provenance: HUMAN_WRITE, platform: "douyin" }, dir);
    await expect(approveCoverVariant(c.id, "a", dir, { modelCall: true })).rejects.toBeInstanceOf(VideoCoverApprovalRefused);
    expect((await getCoverReview(c.id, dir))!.approvedLabel).toBeUndefined();
    // 人手点击（工作台）照常
    expect((await approveCoverVariant(c.id, "a", dir))?.approvedLabel).toBe("a");
  });
});
