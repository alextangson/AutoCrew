import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("./wechat-mp.js", () => ({ generateWechatImageAsset: vi.fn() }));

import { generateWechatImageAsset } from "./wechat-mp.js";
import {
  attachUploadedArticleImage,
  generateArticleImages,
  getArticleImageReview,
  parseArticleImageMarkers,
  preparedArticleImages,
  removeArticleImage,
} from "./article-images.js";
import { saveContent, updateContent } from "../../storage/local-store.js";

const generateMock = vi.mocked(generateWechatImageAsset);
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-article-images-"));
  generateMock.mockReset();
  generateMock.mockImplementation(async (_prompt, outputPath) => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from("png"));
    return { ok: true, stdout: outputPath, stderr: "" };
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function seed() {
  return saveContent({
    title: "正文配图",
    body: "## 开场\n第一段\n\n[IMAGE: 一张纸质合同被红线圈住，无文字]\n\n## 结论\n[IMAGE: 数据装进透明行李箱，无文字]",
    platform: "wechat_mp",
    status: "draft_ready",
    tags: [],
    hashtags: [],
  }, dir);
}

describe("article images workspace", () => {
  it("解析插图位置与所属小节", () => {
    const markers = parseArticleImageMarkers("## A\n[IMAGE: 图一]\n## B\n[IMAGE: 图二]");
    expect(markers).toMatchObject([
      { index: 0, prompt: "图一", section: "A" },
      { index: 1, prompt: "图二", section: "B" },
    ]);
  });

  it("单张生成可预览，发布门要求全部准备好，移除后回到待生成", async () => {
    const content = await seed();
    const initial = await getArticleImageReview(content.id, dir);
    expect(initial.entries.map((entry) => entry.status)).toEqual(["missing", "missing"]);

    await generateArticleImages({ contentId: content.id, index: 0, prompt: "改过的第一张提示词" }, dir);
    const partial = await getArticleImageReview(content.id, dir);
    expect(partial.entries[0]).toMatchObject({ status: "ready", prompt: "改过的第一张提示词", revision: 1 });
    expect((await preparedArticleImages(content.id, dir)).ok).toBe(false);

    await generateArticleImages({ contentId: content.id }, dir);
    const prepared = await preparedArticleImages(content.id, dir);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.paths).toHaveLength(2);

    const removed = await removeArticleImage(content.id, 0, dir);
    expect(removed.entries[0].status).toBe("missing");
    expect(removed.entries[0].imagePath).toBeUndefined();
  });

  it("正文普通改动保留图片；某个 IMAGE 提示词变化只重置对应位置", async () => {
    const content = await seed();
    await generateArticleImages({ contentId: content.id }, dir);
    await updateContent(content.id, { body: `${content.body}\n\n补充一句普通正文` }, dir);
    const kept = await getArticleImageReview(content.id, dir);
    expect(kept.entries.every((entry) => entry.status === "ready")).toBe(true);

    await updateContent(content.id, { body: content.body.replace("数据装进透明行李箱", "数据装进纸箱") }, dir);
    const reset = await getArticleImageReview(content.id, dir);
    expect(reset.entries.map((entry) => entry.status)).toEqual(["ready", "missing"]);
  });
});

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const JPG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpg-body")]);

describe("attachUploadedArticleImage", () => {
  it("上传 jpg 顶进槽位：ready + origin=uploaded + revision+1，扩展名按魔数定", async () => {
    const content = await seed();
    const review = await attachUploadedArticleImage(content.id, 0, JPG_BYTES, dir);
    const entry = review.entries[0];
    expect(entry).toMatchObject({ status: "ready", origin: "uploaded", revision: 1 });
    expect(entry.imagePath!.endsWith("body-01-r1.jpg")).toBe(true);
    expect(await fs.readFile(entry.imagePath!)).toEqual(JPG_BYTES);
    expect(review.entries[1].status).toBe("missing");
  });

  it("png 魔数 → .png；重复上传顶掉旧文件并 revision+1（immutable 缓存靠文件名失效）", async () => {
    const content = await seed();
    const first = await attachUploadedArticleImage(content.id, 0, PNG_BYTES, dir);
    const firstPath = first.entries[0].imagePath!;
    expect(firstPath.endsWith("body-01-r1.png")).toBe(true);
    const second = await attachUploadedArticleImage(content.id, 0, JPG_BYTES, dir);
    expect(second.entries[0].revision).toBe(2);
    expect(second.entries[0].imagePath!.endsWith("body-01-r2.jpg")).toBe(true);
    await expect(fs.access(firstPath)).rejects.toThrow();
  });

  it("拒收：槽位不存在 / 生成中 / 超 5MB / 非 png-jpg 字节", async () => {
    const content = await seed();
    await expect(attachUploadedArticleImage(content.id, 9, PNG_BYTES, dir)).rejects.toThrow(/不存在/);

    // 把槽位 0 直接写成 generating——持久态才挡得住刷新后再传的场景
    const metaPath = path.join(dir, "contents", content.id, "article-images.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8")) as { entries: Array<{ status: string }> };
    meta.entries[0].status = "generating";
    await fs.writeFile(metaPath, JSON.stringify(meta));
    await expect(attachUploadedArticleImage(content.id, 0, PNG_BYTES, dir)).rejects.toThrow(/生成中/);

    const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    await expect(attachUploadedArticleImage(content.id, 1, huge, dir)).rejects.toThrow(/上限/);
    await expect(attachUploadedArticleImage(content.id, 1, Buffer.from("RIFFxxxxWEBPdata"), dir)).rejects.toThrow(/PNG\/JPG/);
  });

  it("正文他处改动后 reconcile 保留上传图与 origin；按提示重做后回到 AI 生成", async () => {
    const content = await seed();
    await attachUploadedArticleImage(content.id, 0, JPG_BYTES, dir);
    await updateContent(content.id, { body: content.body.replace("第一段", "第一段(改)") }, dir);
    const after = await getArticleImageReview(content.id, dir);
    expect(after.entries[0]).toMatchObject({ status: "ready", origin: "uploaded" });

    await generateArticleImages({ contentId: content.id, index: 0, prompt: "改成 AI 生成" }, dir);
    const regen = await getArticleImageReview(content.id, dir);
    expect(regen.entries[0].origin).toBe("generated");
    expect(regen.entries[0].imagePath!.endsWith("body-01-r2.png")).toBe(true);
  });
});
