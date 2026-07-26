/**
 * publish.test.ts — 公众号 A 级发布链（P0 阶段 2）：
 * 审核员发布门同步阻断 / store 为事实源新鲜落盘 / publish.json 配置去桥化。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executePublish } from "./publish.js";
import { saveContent, updateContent, saveCoverReview, approveCoverVariant, getContent, transitionStatus } from "../storage/local-store.js";
import type { WechatMpDraftOptions, WechatMpDraftResult } from "../modules/publish/wechat-mp.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-publish-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function okResult(articlePath: string): WechatMpDraftResult {
  return {
    ok: true,
    articlePath,
    publishInput: articlePath,
    coverPath: "cover.png",
    imageCount: 2,
    generatedImages: [],
  };
}

function mockPublish() {
  return vi.fn(async (opts: WechatMpDraftOptions) => okResult(opts.articlePath));
}

async function mkContent(body: string) {
  return saveContent(
    { title: "测试标题", body, platform: "wechat_mp", status: "approved", tags: [], hashtags: [] },
    dir,
  );
}

describe("executePublish wechat_mp_draft", () => {
  it("content_id：发布时从 store 新鲜落盘 draft.md（工作台编辑后的旧稿不得被推送），附下一步指引", async () => {
    const c = await mkContent("干净正文，讲讲工具技巧");
    await updateContent(c.id, { body: "编辑后的最新正文" }, dir);

    const publishImpl = mockPublish();
    const r = (await executePublish(
      { action: "wechat_mp_draft", content_id: c.id, _dataDir: dir },
      { publishImpl },
    )) as Record<string, unknown>;

    expect(r.ok).toBe(true);
    expect(publishImpl).toHaveBeenCalledOnce();
    expect(String(r.nextStep)).toContain("草稿箱");
    const draftMd = await fs.readFile(path.join(dir, "contents", c.id, "draft.md"), "utf-8");
    expect(draftMd).toContain("编辑后的最新正文");
  });

  it("封面设计师接线:选用封面(approvedImagePath)传给 publishImpl,不再让脚本拿 img-01 兜底", async () => {
    const c = await mkContent("干净正文,讲讲工具技巧");
    const coverFile = path.join(dir, "contents", c.id, "assets", "covers", "cover-a-r2-2.35x1.png");
    await fs.mkdir(path.dirname(coverFile), { recursive: true });
    await fs.writeFile(coverFile, "png-bytes");
    await saveCoverReview(
      c.id,
      {
        platform: "wechat_mp",
        primaryRatio: "2.35:1",
        status: "review_pending",
        variants: [
          { label: "a", imagePaths: { "2.35:1": coverFile } },
          { label: "b", imagePaths: {} },
          { label: "c", imagePaths: {} },
        ],
      } as never,
      dir,
    );
    await approveCoverVariant(c.id, "a", dir);

    const publishImpl = mockPublish();
    const r = (await executePublish(
      { action: "wechat_mp_draft", content_id: c.id, _dataDir: dir },
      { publishImpl },
    )) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(publishImpl.mock.calls[0][0].coverPath).toBe(coverFile);
  });

  it("公众号绑定流转:publish.json 的 appid/secret/留言开关 传给 publishImpl(给别人用的凭证链)", async () => {
    const c = await mkContent("干净正文");
    await fs.writeFile(
      path.join(dir, "publish.json"),
      JSON.stringify({ wechatMp: { wechatAppId: "wx1234567890abcdef", wechatAppSecret: "sec42", openComment: true } }),
      "utf-8",
    );
    const publishImpl = mockPublish();
    await executePublish({ action: "wechat_mp_draft", content_id: c.id, _dataDir: dir }, { publishImpl });
    const opts = publishImpl.mock.calls[0][0];
    expect(opts.wechatAppId).toBe("wx1234567890abcdef");
    expect(opts.wechatAppSecret).toBe("sec42");
    expect(opts.openComment).toBe(true);
  });

  it("无选用封面 → coverPath 不传,脚本维持原兜底行为", async () => {
    const c = await mkContent("干净正文");
    const publishImpl = mockPublish();
    await executePublish({ action: "wechat_mp_draft", content_id: c.id, _dataDir: dir }, { publishImpl });
    expect(publishImpl.mock.calls[0][0].coverPath).toBeUndefined();
  });

  it("审核员发布门：违禁词阻断推送，publishImpl 不被调用", async () => {
    const c = await mkContent("你可以通过翻墙来访问更多信息");
    const publishImpl = mockPublish();
    const r = (await executePublish(
      { action: "wechat_mp_draft", content_id: c.id, _dataDir: dir },
      { publishImpl },
    )) as Record<string, unknown>;

    expect(r.ok).toBe(false);
    expect(r.violations as string[]).toContain("翻墙");
    expect(String(r.error)).toContain("阻断");
    expect(publishImpl).not.toHaveBeenCalled();
  });

  it("force：放行但违规照样透出（warning + violations，不静默）", async () => {
    const c = await mkContent("通过翻墙访问");
    const publishImpl = mockPublish();
    const r = (await executePublish(
      { action: "wechat_mp_draft", content_id: c.id, force: true, _dataDir: dir },
      { publishImpl },
    )) as Record<string, unknown>;

    expect(r.ok).toBe(true);
    expect(publishImpl).toHaveBeenCalledOnce();
    expect((r.violations as string[]).length).toBeGreaterThan(0);
    expect(String(r.warning)).toContain("违禁词");
  });

  it("publish.json 去桥化：wechatMp 段的 author/theme/脚本路径注入调用参数", async () => {
    await fs.writeFile(
      path.join(dir, "publish.json"),
      JSON.stringify({
        wechatMp: {
          author: "配置作者",
          theme: "github",
          wechatPublishScript: "/tmp/x/publish.py",
          imageGeneratorScript: "/tmp/x/gen.py",
        },
      }),
    );
    const c = await mkContent("干净正文");
    const publishImpl = mockPublish();
    await executePublish({ action: "wechat_mp_draft", content_id: c.id, _dataDir: dir }, { publishImpl });

    const opts = publishImpl.mock.calls[0][0];
    expect(opts.author).toBe("配置作者");
    expect(opts.theme).toBe("github");
    expect(opts.wechatPublishScript).toBe("/tmp/x/publish.py");
    expect(opts.imageGeneratorScript).toBe("/tmp/x/gen.py");
  });

  it("显式参数优先于 publish.json 配置", async () => {
    await fs.writeFile(
      path.join(dir, "publish.json"),
      JSON.stringify({ wechatMp: { theme: "github" } }),
    );
    const c = await mkContent("干净正文");
    const publishImpl = mockPublish();
    await executePublish(
      { action: "wechat_mp_draft", content_id: c.id, theme: "newspaper", _dataDir: dir },
      { publishImpl },
    );
    expect(publishImpl.mock.calls[0][0].theme).toBe("newspaper");
  });

  it("content 不存在 / 参数缺失 → 明确报错，不调发布", async () => {
    const publishImpl = mockPublish();
    const gone = (await executePublish(
      { action: "wechat_mp_draft", content_id: "content-nope", _dataDir: dir },
      { publishImpl },
    )) as Record<string, unknown>;
    expect(gone.ok).toBe(false);

    const missing = (await executePublish({ action: "wechat_mp_draft", _dataDir: dir }, { publishImpl })) as Record<
      string,
      unknown
    >;
    expect(missing.ok).toBe(false);
    expect(publishImpl).not.toHaveBeenCalled();
  });
});

// 生产计时的「发布」节点:确认已发布 = 盖发布戳,重复确认不许把首次时刻冲掉
describe("executePublish confirm_published — 发布戳", () => {
  it("首次确认盖 publishedAt 并转 published", async () => {
    const c = await mkContent("正文");
    const before = Date.now();
    const r = (await executePublish(
      { action: "confirm_published", content_id: c.id, publish_url: "https://mp.weixin.qq.com/s/x", _dataDir: dir },
    )) as Record<string, unknown>;

    expect(r.ok).toBe(true);
    const saved = await getContent(c.id, dir);
    expect(saved!.status).toBe("published");
    expect(saved!.publishUrl).toBe("https://mp.weixin.qq.com/s/x");
    const at = Date.parse(saved!.publishedAt!);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before);
  });

  it("重复确认幂等:publishedAt 保持首次时刻,不被第二次点击覆盖", async () => {
    const c = await mkContent("正文");
    await executePublish({ action: "confirm_published", content_id: c.id, _dataDir: dir });
    const first = (await getContent(c.id, dir))!.publishedAt;

    await new Promise((r) => setTimeout(r, 5));
    await executePublish({ action: "confirm_published", content_id: c.id, _dataDir: dir });

    expect((await getContent(c.id, dir))!.publishedAt).toBe(first);
  });

  it("transitionStatus 这条路同样只盖一次", async () => {
    const c = await mkContent("正文");
    await executePublish({ action: "confirm_published", content_id: c.id, _dataDir: dir });
    const first = (await getContent(c.id, dir))!.publishedAt;

    await new Promise((r) => setTimeout(r, 5));
    await transitionStatus(c.id, "published", { force: true }, dir);

    expect((await getContent(c.id, dir))!.publishedAt).toBe(first);
  });
});
