import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveContent,
  saveCoverReview,
  approveCoverVariant,
  transitionStatus,
  updateContent,
  getContent,
} from "../storage/local-store.js";
import { executePrePublish, executePrePublishTool } from "./pre-publish.js";
import { editorialDraftHash } from "./editorial.js";
import { claimContent } from "../storage/claims.js";

vi.mock("./review.js", () => ({
  executeReview: vi.fn().mockResolvedValue({
    ok: true,
    passed: true,
    qualityScore: { total: 90 },
    summary: "通过",
  }),
}));

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-prepublish-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("executePrePublish platform-specific checks", () => {
  for (const [platform, max] of [["xiaohongshu", 1000], ["wechat_video", 800], ["bilibili", 2000]] as const) {
    it(`${platform} 按发布简介检查长度，长口播不被压缩，超限简介仍被拦下`, async () => {
      const kit = { platform, postTitle: "这期讲什么", caption: "字".repeat(300), storyboard: [], coverText: "AI", coverPrompt: "封面", generatedAt: new Date().toISOString() };
      const content = await saveContent({ title: "这期讲什么", body: "字".repeat(2500), platform, status: "approved", videoKit: kit }, dataDir);
      const params = { action: "check", content_id: content.id, _dataDir: dataDir, _readOnly: true };
      const result = await executePrePublish(params);
      expect("checks" in result && result.checks.find((c) => c.name === "发布简介字数")).toMatchObject({ status: "pass" });
      expect((await getContent(content.id, dataDir))?.body).toHaveLength(2500);
      await updateContent(content.id, { videoKit: { ...kit, caption: "字".repeat(max + 1) } }, dataDir);
      const tooLong = await executePrePublish(params);
      expect("checks" in tooLong && tooLong.checks.find((c) => c.name === "发布简介字数")).toMatchObject({ status: "fail" });
    });
  }

  it("公众号仍检查全文上限，不接受无关的视频简介来绕过", async () => {
    const content = await saveContent({ title: "公众号长文", body: "字".repeat(3001), platform: "wechat_mp", status: "approved", videoKit: { platform: "douyin", postTitle: "介绍", caption: "字".repeat(300), storyboard: [], coverText: "封面", coverPrompt: "封面", generatedAt: new Date().toISOString() } }, dataDir);
    const result = await executePrePublish({ action: "check", content_id: content.id, _dataDir: dataDir, _readOnly: true });
    expect("checks" in result && result.checks.find((c) => c.name === "正文字数")).toMatchObject({ status: "fail" });
  });

  it("does not require hashtags for WeChat official-account articles", async () => {
    const content = await saveContent(
      {
        title: "一篇可以发布的公众号文章",
        body: "这是公众号正文。".repeat(120),
        platform: "wechat_mp",
        status: "approved",
        tags: [],
      },
      dataDir,
    );

    const result = await executePrePublish({ action: "check", content_id: content.id, _dataDir: dataDir });
    expect("checks" in result).toBe(true);
    if (!("checks" in result)) return;
    expect(result.checks.find((check) => check.name === "Hashtags")).toMatchObject({ status: "skip" });
    expect(result.allPassed).toBe(true);
  });

  for (const platform of ["wechat_video", "bilibili"]) {
    it(`requires an approved cover for ${platform}`, async () => {
      const content = await saveContent(
        {
          title: "这一年 AI 如何重写工作与生活",
          body: "这是一段符合平台长度要求的视频正文。".repeat(30),
          platform,
          status: "approved",
          hashtags: ["AI"],
        },
        dataDir,
      );
      const result = await executePrePublish({ action: "check", content_id: content.id, _dataDir: dataDir });
      expect("checks" in result).toBe(true);
      if (!("checks" in result)) return;
      expect(result.checks.find((check) => check.name === "封面审核")).toMatchObject({ status: "fail" });
    });
  }
});

// --- 阶段门（阶段制 spec §2 最坏输入 / §4 #1）---

describe("发布前检查 · 阶段门", () => {
  /** 六项内容检查全过的视频稿：唯一还能拦住它的就是阶段门 */
  const readyVideo = async (status: "approved" | "cover_pending") => {
    const c = await saveContent(
      {
        title: "这一年 AI 如何重写工作与生活",
        body: "这是一段符合平台长度要求的视频正文。".repeat(30),
        platform: "douyin",
        status: "approved",
        hashtags: ["AI"],
      },
      dataDir,
    );
    await saveCoverReview(
      c.id,
      { platform: "douyin", status: "review_pending", variants: [{ label: "a", imagePaths: { "3:4": "/tmp/a.png" } }] },
      dataDir,
    );
    await approveCoverVariant(c.id, "a", dataDir);
    if (status === "cover_pending") {
      await updateContent(c.id, { videoDone: { renderedRevision: 1, at: "2026-08-25T00:00:00.000Z" } }, dataDir);
      await transitionStatus(c.id, "editing", { viaHandoff: true }, dataDir);
      await transitionStatus(c.id, "cover_pending", undefined, dataDir);
    }
    return c.id;
  };

  it("视频稿在 approved 上跑预检：不谎报全过，明示卡在阶段门", async () => {
    const id = await readyVideo("approved");
    const result = await executePrePublish({ action: "check", content_id: id, _dataDir: dataDir });
    expect("checks" in result).toBe(true);
    if (!("checks" in result)) return;
    expect(result.allPassed).toBe(false);
    expect(result.checks.find((c) => c.name === "阶段门")).toMatchObject({ status: "fail" });
    expect(result.summary).toContain("卡在阶段门");
    expect(result.summary).toContain("交接给剪辑工位");
    // 被拦下就是没进——状态一个字都不许动
    expect((await getContent(id, dataDir))!.status).toBe("approved");
  });

  it("走完剪辑与封面后，预检全过并把稿件推进「待发布」", async () => {
    const id = await readyVideo("cover_pending");
    const result = await executePrePublish({ action: "check", content_id: id, _dataDir: dataDir });
    expect("checks" in result).toBe(true);
    if (!("checks" in result)) return;
    expect(result.allPassed).toBe(true);
    expect((await getContent(id, dataDir))!.status).toBe("publish_ready");
  });

  it("_readOnly：门的判定照报，但一个字都不写盘", async () => {
    const id = await readyVideo("cover_pending");
    const result = await executePrePublish({ action: "check", content_id: id, _dataDir: dataDir, _readOnly: true });
    expect("checks" in result).toBe(true);
    if (!("checks" in result)) return;
    expect(result.allPassed).toBe(true);
    expect((await getContent(id, dataDir))!.status).toBe("cover_pending");
  });

  it("已发布的稿重跑预检不被倒拨回「待发布」", async () => {
    const id = await readyVideo("cover_pending");
    await transitionStatus(id, "published", { force: true }, dataDir);
    await executePrePublish({ action: "check", content_id: id, _dataDir: dataDir });
    expect((await getContent(id, dataDir))!.status).toBe("published");
  });

  it("写门（P6 §3.8）：会推进状态的预检是写——同宿主另一个会话不带令牌被拒且状态不动，带令牌推进并交回令牌", async () => {
    const id = await readyVideo("cover_pending");
    const claimed = await claimContent(id, "editor", "claude", dataDir);
    if (!claimed.ok) throw new Error(claimed.error);
    const run = (extra: Record<string, unknown> = {}) =>
      executePrePublishTool({ action: "check", content_id: id, _dataDir: dataDir, _host: "claude", ...extra });
    expect(await run()).toMatchObject({ ok: false, code: "claim_held", holder: { host: "claude", employee: "editor" } });
    expect((await getContent(id, dataDir))!.status).toBe("cover_pending");
    expect(await run({ _readOnly: true })).toMatchObject({ ok: true, allPassed: true });
    expect(await run({ claim_token: claimed.claim.token })).toMatchObject({ ok: true, allPassed: true, claim_token: claimed.claim.token });
    expect((await getContent(id, dataDir))!.status).toBe("publish_ready");
  });
});

// --- video_kit：宿主交发布包（P6 §3.6，eval video-kit-stale / pre-publish-reads-caption）---

describe("video_kit 宿主发布包", () => {
  const KIT = { post_title: "不写代码也能用的AI", caption: "这期讲清楚普通人怎么把重复活交给 AI，看完就能上手。", cover_text: "别再手搬了" };
  // 「剪辑中」只能经交接进入（§13.4-C）：要 editing 的先建在已过审，再按交接的方式推进
  const mkVideo = async (platform = "xiaohongshu", extra: Record<string, unknown> = {}) => {
    const c = await saveContent({ title: "口播稿标题", body: "口播正文。".repeat(600), platform, status: "approved", hashtags: [], videoDone: { renderedRevision: 1, at: "2026-09-25T00:00:00.000Z" }, ...extra, ...(extra.status === "editing" ? { status: "approved" } : {}) }, dataDir);
    if (extra.status !== "editing") return c;
    const moved = await transitionStatus(c.id, "editing", { viaHandoff: true }, dataDir);
    if (!moved.content) throw new Error(moved.error);
    return moved.content;
  };
  const saveKit = (id: string, platform: string, kit: Record<string, unknown> = KIT) =>
    executePrePublishTool({ action: "video_kit", content_id: id, platform, kit, _dataDir: dataDir });
  const check = (id: string) => executePrePublish({ action: "check", content_id: id, _dataDir: dataDir, _readOnly: true });

  it("写门（P6 §3.8）：交发布包是写——同宿主另一个会话不带令牌被拒不落盘，带令牌照存并交回令牌；不推进状态的预检不设卡", async () => {
    const c = await mkVideo();
    const claimed = await claimContent(c.id, "writer", "claude", dataDir);
    if (!claimed.ok) throw new Error(claimed.error);
    const tool = (extra: Record<string, unknown>) =>
      executePrePublishTool({ content_id: c.id, _dataDir: dataDir, _host: "claude", ...extra });
    expect(await tool({ action: "video_kit", platform: "xiaohongshu", kit: KIT })).toMatchObject({ ok: false, code: "claim_held", holder: { host: "claude" } });
    expect((await getContent(c.id, dataDir))!.videoKit).toBeUndefined();
    expect(await tool({ action: "check" })).toMatchObject({ ok: true, allPassed: false });
    const saved = await tool({ action: "video_kit", platform: "xiaohongshu", kit: KIT, claim_token: claimed.claim.token });
    expect(saved).toMatchObject({ ok: true, status: "kit_saved", claim_token: claimed.claim.token });
    expect((await getContent(c.id, dataDir))!.videoKit).toMatchObject({ source: "host" });
  });

  it("保存到 videoKit：记当前稿指纹、source=host，标签并进简介末尾，下一步指向 check", async () => {
    const c = await mkVideo();
    const r = await saveKit(c.id, "xiaohongshu", { ...KIT, hashtags: ["AI工具", "#职场"] });
    expect(r).toMatchObject({ ok: true, status: "kit_saved", next_action: { tool: "autocrew_pre_publish", params: { action: "check", content_id: c.id } } });
    const saved = (await getContent(c.id, dataDir))!;
    expect(saved.videoKit).toMatchObject({ platform: "xiaohongshu", postTitle: KIT.post_title, coverText: KIT.cover_text, source: "host" });
    expect(saved.videoKit!.draftHash).toBe(editorialDraftHash(saved));
    expect(saved.videoKit!.caption.startsWith(KIT.caption)).toBe(true);
    expect(saved.videoKit!.caption.endsWith("#AI工具 #职场")).toBe(true);
    // 已在简介里的标签不重复并入
    await saveKit(c.id, "xiaohongshu", { ...KIT, caption: `${KIT.caption} #AI工具`, hashtags: ["AI工具"] });
    expect((await getContent(c.id, dataDir))!.videoKit!.caption.match(/#AI工具/g)).toHaveLength(1);
  });

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ["发布标题超出小红书 20 字", { post_title: "这是一个刻意写得非常非常长超过二十个字的小红书标题" }, "post_title"],
    ["缺发布标题", { post_title: "  " }, "post_title"],
    ["简介不足 20 字", { caption: "太短了" }, "caption"],
    ["简介超出小红书 1000 字", { caption: "字".repeat(1001) }, "caption"],
    ["封面大字超出 12 字", { cover_text: "这句封面大字明显超过了十二个字" }, "cover_text"],
    ["标签带空格", { hashtags: ["AI 工具"] }, "hashtags"],
    ["标签不是字符串数组", { hashtags: "AI" }, "hashtags"],
  ];
  for (const [label, patch, field] of invalid) {
    it(`kit_invalid：${label} → 按字段打回，不落盘`, async () => {
      const c = await mkVideo();
      const r = await saveKit(c.id, "xiaohongshu", { ...KIT, ...patch });
      expect(r).toMatchObject({ ok: false, code: "kit_invalid" });
      const failures = (r as { failures: Array<{ field: string; detail: string }> }).failures;
      expect(failures.map((f) => f.field)).toContain(field);
      expect(failures.every((f) => f.detail.length > 0)).toBe(true);
      expect((await getContent(c.id, dataDir))!.videoKit).toBeUndefined();
    });
  }

  it("标签并入后超限也算超限（按实际发出去的简介算）", async () => {
    const c = await mkVideo();
    const r = await saveKit(c.id, "xiaohongshu", { ...KIT, caption: "字".repeat(995), hashtags: ["AI工具"] });
    expect(r).toMatchObject({ ok: false, code: "kit_invalid", failures: [{ field: "caption" }] });
  });

  it("platform 缺失或与稿件不符 → platform_mismatch；非视频平台 → not_video_platform", async () => {
    const c = await mkVideo("douyin");
    expect(await saveKit(c.id, "xiaohongshu")).toMatchObject({ ok: false, code: "platform_mismatch", expected_platform: "douyin" });
    expect(await executePrePublishTool({ action: "video_kit", content_id: c.id, kit: KIT, _dataDir: dataDir })).toMatchObject({ ok: false, code: "platform_mismatch" });
    const mp = await saveContent({ title: "公众号", body: "正文", platform: "wechat_mp", status: "approved" }, dataDir);
    expect(await saveKit(mp.id, "wechat_mp")).toMatchObject({ ok: false, code: "not_video_platform" });
    expect((await getContent(c.id, dataDir))!.videoKit).toBeUndefined();
  });

  it("成片没登记（videoDone 未盖）就不出发布包：video_not_done，next_action 是看状态（P6-e narration-not-state）", async () => {
    const c = await mkVideo("xiaohongshu", { videoDone: undefined, status: "editing" });
    const r = await saveKit(c.id, "xiaohongshu");
    expect(r).toMatchObject({ ok: false, code: "video_not_done", content_status: "editing", next_action: { tool: "autocrew_content", params: { action: "get", id: c.id } } });
    expect((await getContent(c.id, dataDir))?.videoKit).toBeUndefined();
  });

  it("稿件改了之后 check 报 kit_stale，next_action 指回 video_kit", async () => {
    const c = await mkVideo();
    await saveKit(c.id, "xiaohongshu");
    expect(await check(c.id)).toHaveProperty("checks");
    await updateContent(c.id, { body: "改过的口播正文。".repeat(300) }, dataDir);
    const r = await check(c.id);
    expect(r).toMatchObject({
      ok: false,
      code: "kit_stale",
      next_action: { tool: "autocrew_pre_publish", params: { action: "video_kit", content_id: c.id, platform: "xiaohongshu" } },
    });
    expect((r as { error: string }).error).toBeTruthy();
    // 按新稿重交就恢复
    await saveKit(c.id, "xiaohongshu");
    expect(await check(c.id)).toHaveProperty("checks");
  });

  it("有发布包时标题 / 标签 / 字数读发布包，不读口播稿", async () => {
    // 口播稿：标题超小红书上限、正文 3000 字超 1000、无标签——全是不会被发出去的东西
    const c = await mkVideo("xiaohongshu", { title: "这是一个刻意写得非常非常长超过二十个字的口播稿标题" });
    await saveKit(c.id, "xiaohongshu", { ...KIT, hashtags: ["AI工具"] });
    const r = await check(c.id);
    if (!("checks" in r)) throw new Error(`预检没跑成：${r.error}`);
    const byName = (name: string) => r.checks.find((item) => item.name === name);
    expect(byName("发布简介字数")).toMatchObject({ status: "pass" });
    expect(byName("正文字数")).toBeUndefined();
    expect(byName("标题规范")).toMatchObject({ status: "pass" });
    expect(byName("标题规范")!.detail).toContain(KIT.post_title);
    expect(byName("Hashtags")).toMatchObject({ status: "pass" });
  });

  it("交包的下限就是预检的下限：交得进去的短简介不会被正文下限打回", async () => {
    const c = await mkVideo();
    await saveKit(c.id, "xiaohongshu");
    const r = await check(c.id);
    if (!("checks" in r)) throw new Error(`预检没跑成：${r.error}`);
    expect(KIT.caption.length).toBeLessThan(200);
    expect(r.checks.find((item) => item.name === "发布简介字数")).toMatchObject({ status: "pass" });
  });

  it("没有发布包：照旧查正文，超限提示指向 video_kit 并带上参数", async () => {
    const c = await mkVideo();
    const r = await check(c.id);
    if (!("checks" in r)) throw new Error(`预检没跑成：${r.error}`);
    const item = r.checks.find((x) => x.name === "正文字数");
    expect(item).toMatchObject({ status: "fail" });
    expect(item!.fix).toContain("action='video_kit'");
    expect(item!.fix).toContain("platform:'xiaohongshu'");
    expect(item!.fix).toContain("post_title");
  });
});
