/**
 * video-kit.test.ts — 视频发布件（IA v5 V5.4b）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareVideoKit } from "./video-kit.js";
import { generateImageViaRelay } from "./image-gen.js";
import { saveContent, getContent } from "../../storage/local-store.js";
import type { runLoop } from "../../engine/loop.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-vkit-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "sk-test" }), "utf-8");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const KIT_ARGS = {
  postTitle: "删AI代码,周入1万美元",
  caption: "刷到必看:有人靠删AI代码周入1万美元 #AI #代码",
  storyboard: [
    { shot: "近景怼脸", visual: "开场直视镜头", line: "有人靠删代码赚钱", overlay: "大字:1万美元/周" },
    { shot: "中景+屏幕", visual: "屏幕展示代码库", line: "14个日期格式化器" },
    { shot: "近景", visual: "摊手", line: "能跑和能改是两回事", overlay: "" },
  ],
  coverText: "删代码年入百万",
  coverPrompt: "工程师面对堆积如山的代码,竖版插画",
};

function mockLoop(args: Record<string, unknown>): typeof runLoop {
  return (async (_c: unknown, opts: { tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> }) => {
    const tool = opts.tools.find((t) => t.name === "submit_video_kit");
    if (tool) await tool.execute(args);
    return { stopReason: "tool", turns: 1, totalTokens: 200, finalText: "" };
  }) as unknown as typeof runLoop;
}

async function mkVideoContent(platform = "douyin"): Promise<string> {
  const c = await saveContent({
    title: "删AI代码的生意", body: "口播稿正文……", platform,
    status: "approved", tags: [], hashtags: ["AI"],
  }, dir);
  return c.id;
}

describe("prepareVideoKit", () => {
  it("happy path:kit 落到 Content.videoKit,coverText 截 12 字,分镜规整", async () => {
    const id = await mkVideoContent();
    const r = await prepareVideoKit(id, { generateCover: false }, dir, { runLoopImpl: mockLoop(KIT_ARGS) });
    expect(r.kit.platform).toBe("douyin");
    expect(r.kit.storyboard).toHaveLength(3);
    expect(r.kit.storyboard[0].overlay).toContain("1万美元");
    expect(r.kit.storyboard[2].overlay).toBeUndefined(); // 空串滤掉
    const saved = await getContent(id, dir);
    expect(saved!.videoKit!.caption).toContain("#AI");
    expect(saved!.videoKit!.postTitle).toBe("删AI代码,周入1万美元");
    expect(saved!.videoKit!.generatedAt).toBeTruthy();
  });

  it("平台标题硬门:小红书 >20 字被工具打回(不静默截断),模型未重交 → 失败", async () => {
    const id = await mkVideoContent("xiaohongshu");
    await expect(prepareVideoKit(id, { generateCover: false }, dir, {
      runLoopImpl: mockLoop({
        ...KIT_ARGS,
        postTitle: "这是一个刻意写得非常非常长超过二十个字的小红书标题肯定超限",
      }),
    })).rejects.toThrow(/未调用 submit_video_kit/);
  });

  it("非视频平台 → 拒绝;分镜 <3 行 → 工具打回致失败", async () => {
    const wechatId = (await saveContent({
      title: "t", body: "b", platform: "wechat_mp", status: "approved", tags: [], hashtags: [],
    }, dir)).id;
    await expect(prepareVideoKit(wechatId, {}, dir, { runLoopImpl: mockLoop(KIT_ARGS) }))
      .rejects.toThrow(/视频平台/);

    const id = await mkVideoContent();
    await expect(prepareVideoKit(id, { generateCover: false }, dir, {
      runLoopImpl: mockLoop({ ...KIT_ARGS, storyboard: [KIT_ARGS.storyboard[0]] }),
    })).rejects.toThrow(/未调用 submit_video_kit/);
  });

  it("封面:中转未配置 → coverError 透出,发布件照常落库;配置了 → 写盘并记 coverPath", async () => {
    const id = await mkVideoContent();
    const r1 = await prepareVideoKit(id, { generateCover: true }, dir, { runLoopImpl: mockLoop(KIT_ARGS) });
    expect(r1.coverError).toMatch(/未配置/);
    expect(r1.kit.coverPath).toBeUndefined();

    await fs.writeFile(path.join(dir, "publish.json"), JSON.stringify({
      wechatMp: { imageBaseUrl: "https://relay.example/v1", imageApiKey: "sk-img", imageModel: "gpt-image-2" },
    }), "utf-8");
    const fakePng = Buffer.from("png-bytes");
    const imageImpl = (async () => fakePng) as unknown as typeof generateImageViaRelay;
    const id2 = await mkVideoContent("xiaohongshu");
    const r2 = await prepareVideoKit(id2, { generateCover: true }, dir, {
      runLoopImpl: mockLoop(KIT_ARGS), imageImpl,
    });
    expect(r2.coverError).toBeUndefined();
    expect(r2.kit.coverPath).toBe("images/video-cover.png");
    const onDisk = await fs.readFile(path.join(dir, "contents", id2, "images", "video-cover.png"));
    expect(onDisk.equals(fakePng)).toBe(true);
  });
});

describe("clipboard 集成:视频平台有 kit 用 caption", () => {
  it("douyin + videoKit → copyText 用发布文案且不重复贴标签;无 kit → 旧行为", async () => {
    const { executePublish } = await import("../../tools/publish.js");
    const id = await mkVideoContent();
    await prepareVideoKit(id, { generateCover: false }, dir, { runLoopImpl: mockLoop(KIT_ARGS) });
    const r = (await executePublish({ action: "clipboard", content_id: id, _dataDir: dir })) as Record<string, unknown>;
    const data = r.data as { copyText: string; fromVideoKit?: boolean };
    expect(data.fromVideoKit).toBe(true);
    expect(data.copyText).toContain("删AI代码,周入1万美元"); // 用发布件标题,不用口播稿标题
    expect(data.copyText).toContain("刷到必看");
    expect(data.copyText).not.toContain("口播稿正文");

    const plainId = await mkVideoContent();
    const r2 = (await executePublish({ action: "clipboard", content_id: plainId, _dataDir: dir })) as Record<string, unknown>;
    expect((r2.data as { copyText: string }).copyText).toContain("口播稿正文");
  });
});
