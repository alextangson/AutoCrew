import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("./wechat-mp.js", () => ({ generateWechatImageAsset: vi.fn() }));

import { generateWechatImageAsset } from "./wechat-mp.js";
import {
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
  await fs.rm(dir, { recursive: true, force: true });
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
