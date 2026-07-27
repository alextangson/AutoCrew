/**
 * research-asset-store.test.ts — 研究素材库（深调研 §0.3/§7）：
 * 内容寻址落盘 / **选题级** URL 去重 / 索引 latest-wins / imported 态 / 路径穿越拒绝。
 *
 * 断言的都是确定性层（文件名、路径、索引行数、读视图），零网络、零 LLM。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findResearchAssetByUrl,
  getResearchAsset,
  getResearchAssetFile,
  listResearchAssets,
  markResearchAssetImported,
  researchAssetsDir,
  resolveAssetPath,
  saveResearchAsset,
  type ResearchAsset,
} from "./research-asset-store.js";
import type { FetchedImage } from "./fetch-image.js";

let dataDir: string;
const TOPIC = "topic-abc123";
const OTHER_TOPIC = "topic-def456";

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-research-assets-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** 与 fetch-image 同款的手搓 PNG 头（这里只关心「一段确定的字节」） */
function pngBytes(seed: string): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(800, 16);
  head.writeUInt32BE(600, 20);
  return Buffer.concat([head, Buffer.from(seed, "utf-8")]);
}

const image = (over: Partial<FetchedImage> = {}): FetchedImage => ({
  bytes: pngBytes("payload-a"),
  format: "png",
  width: 800,
  height: 600,
  finalUrl: "https://cdn.test/a/pic.png",
  ...over,
});

const meta = (over: Partial<Parameters<typeof saveResearchAsset>[0]> = {}) => ({
  topicId: TOPIC,
  sourceUrl: "https://cdn.test/a/pic.png",
  sourcePageUrl: "https://ex.test/article",
  caption: "现场图",
  ...over,
});

const indexFile = () => path.join(researchAssetsDir(dataDir), "index.jsonl");
const indexLines = async (): Promise<string[]> =>
  (await fs.readFile(indexFile(), "utf-8")).split("\n").filter((l) => l.trim());
const sha16 = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

describe("落盘与记录", () => {
  it("文件名 = 内容 sha256 前 16 位 + magic 定的扩展名，字节原样落盘", async () => {
    const img = image();
    const asset = await saveResearchAsset(meta(), img, dataDir);

    expect(asset.file).toBe(`research/assets/files/${sha16(img.bytes)}.png`);
    const onDisk = await fs.readFile(path.join(dataDir, asset.file));
    expect(onDisk.equals(img.bytes)).toBe(true);
    expect(asset).toMatchObject({
      topicId: TOPIC,
      format: "png",
      width: 800,
      height: 600,
      bytes: img.bytes.length,
      sourceUrl: "https://cdn.test/a/pic.png",
      sourcePageUrl: "https://ex.test/article",
      caption: "现场图",
      status: "candidate",
      license: "unknown",
    });
    expect(Date.parse(asset.capturedAt)).not.toBeNaN();
  });

  it("扩展名跟 magic（FetchedImage.format），不跟 URL 后缀", async () => {
    const asset = await saveResearchAsset(
      meta({ sourceUrl: "https://cdn.test/x/photo.gif?v=2" }),
      image({ format: "jpeg" }),
      dataDir,
    );
    expect(asset.file.endsWith(".jpg")).toBe(true);
  });

  it.each([
    ["webp", "webp"],
    ["png", "png"],
  ])("format %s 落 .%s", async (format, ext) => {
    const asset = await saveResearchAsset(
      meta({ sourceUrl: `https://cdn.test/${format}.bin` }),
      image({ format: format as FetchedImage["format"] }),
      dataDir,
    );
    expect(path.extname(asset.file)).toBe(`.${ext}`);
  });

  it("同一份内容 hash 命名稳定（两次存不同 URL，文件名一致）", async () => {
    const a = await saveResearchAsset(meta({ sourceUrl: "https://cdn.test/1.png" }), image(), dataDir);
    const b = await saveResearchAsset(meta({ sourceUrl: "https://cdn.test/2.png" }), image(), dataDir);
    expect(path.basename(a.file)).toBe(path.basename(b.file));
  });

  it("非法 topicId 直接拒（别让它拼出路径）", async () => {
    await expect(saveResearchAsset(meta({ topicId: "../etc" }), image(), dataDir)).rejects.toThrow(
      /非法选题 id/,
    );
  });
});

describe("去重", () => {
  it("同一 sourceUrl 二次存 → 返回既有记录，不重写索引", async () => {
    const first = await saveResearchAsset(meta(), image(), dataDir);
    const again = await saveResearchAsset(
      meta({ caption: "换了个说明" }),
      image({ bytes: pngBytes("payload-b") }),
      dataDir,
    );
    expect(again).toEqual(first);
    expect(again.caption).toBe("现场图");
    expect(await indexLines()).toHaveLength(1);
  });

  it("URL 只差 tracking 参数也算同一张（规范化后比对）", async () => {
    const first = await saveResearchAsset(meta(), image(), dataDir);
    const again = await saveResearchAsset(
      meta({ sourceUrl: "https://cdn.test/a/pic.png?utm_source=x&gclid=y" }),
      image(),
      dataDir,
    );
    expect(again.assetId).toBe(first.assetId);
  });

  it("同内容不同源 → 各自成记录，但共享同一个 hash 文件", async () => {
    const a = await saveResearchAsset(meta({ sourceUrl: "https://cdn.test/1.png" }), image(), dataDir);
    const b = await saveResearchAsset(
      meta({ sourceUrl: "https://cdn.test/2.png", sourcePageUrl: "https://other.test/p" }),
      image(),
      dataDir,
    );
    expect(b.assetId).not.toBe(a.assetId);
    expect(b.file).toBe(a.file);
    expect(await indexLines()).toHaveLength(2);
    const dir = path.dirname(path.join(dataDir, a.file));
    expect(await fs.readdir(dir)).toEqual([path.basename(a.file)]);
  });

  // 创始人裁决（R1b-B）：去重键是 (topicId, 规范化 URL)，不是全库 URL。
  // 素材清单按选题看——别的选题存过，不该让这条选题的清单里凭空少一张。
  it("同一 URL 跨选题：各自成记录，各自的清单里都有", async () => {
    const first = await saveResearchAsset(meta(), image(), dataDir);
    const other = await saveResearchAsset(meta({ topicId: OTHER_TOPIC }), image(), dataDir);

    expect(other.assetId).not.toBe(first.assetId);
    expect(other.topicId).toBe(OTHER_TOPIC);
    expect(await listResearchAssets(TOPIC, dataDir)).toEqual([first]);
    expect(await listResearchAssets(OTHER_TOPIC, dataDir)).toEqual([other]);
    expect(await indexLines()).toHaveLength(2);
  });

  it("同一 URL 跨选题：字节层仍只有一份文件（内容 hash 全库共享）", async () => {
    const first = await saveResearchAsset(meta(), image(), dataDir);
    const other = await saveResearchAsset(meta({ topicId: OTHER_TOPIC }), image(), dataDir);

    expect(other.file).toBe(first.file);
    const dir = path.dirname(path.join(dataDir, first.file));
    expect(await fs.readdir(dir)).toEqual([path.basename(first.file)]);
  });
});

describe("查询", () => {
  it("空库读出空列表 / null，不抛", async () => {
    expect(await listResearchAssets(TOPIC, dataDir)).toEqual([]);
    expect(await findResearchAssetByUrl(TOPIC, "https://cdn.test/none.png", dataDir)).toBeNull();
    expect(await getResearchAsset("rasset-none", dataDir)).toBeNull();
    expect(await getResearchAssetFile("rasset-none", dataDir)).toBeNull();
  });

  it("index roundtrip：写进去的原样读出来，按 topicId 过滤", async () => {
    const a = await saveResearchAsset(meta({ sourceUrl: "https://cdn.test/1.png" }), image(), dataDir);
    const b = await saveResearchAsset(
      meta({ topicId: OTHER_TOPIC, sourceUrl: "https://cdn.test/2.png" }),
      image({ bytes: pngBytes("payload-b") }),
      dataDir,
    );
    expect(await listResearchAssets(TOPIC, dataDir)).toEqual([a]);
    expect(await listResearchAssets(OTHER_TOPIC, dataDir)).toEqual([b]);
  });

  it("findResearchAssetByUrl 命中最早那条，且只在本选题内找", async () => {
    const first = await saveResearchAsset(meta(), image(), dataDir);
    expect(await findResearchAssetByUrl(TOPIC, "https://cdn.test/a/pic.png", dataDir)).toEqual(first);
    expect(await findResearchAssetByUrl(OTHER_TOPIC, "https://cdn.test/a/pic.png", dataDir)).toBeNull();
    expect(await findResearchAssetByUrl(TOPIC, "", dataDir)).toBeNull();
  });

  it("索引按 assetId latest-wins（后写的同 id 覆盖前一条）", async () => {
    const asset = await saveResearchAsset(meta(), image(), dataDir);
    const updated: ResearchAsset = { ...asset, caption: "人工改过的说明" };
    await fs.appendFile(indexFile(), JSON.stringify(updated) + "\n", "utf-8");

    const listed = await listResearchAssets(TOPIC, dataDir);
    expect(listed).toHaveLength(1);
    expect(listed[0].caption).toBe("人工改过的说明");
  });

  it("损坏行跳过，不清空读视图", async () => {
    const asset = await saveResearchAsset(meta(), image(), dataDir);
    await fs.appendFile(indexFile(), '{"assetId":"broken\n{}\n', "utf-8");
    expect(await listResearchAssets(TOPIC, dataDir)).toEqual([asset]);
  });
});

describe("imported 态", () => {
  it("candidate → imported，重复标记幂等（不追加重复行）", async () => {
    const asset = await saveResearchAsset(meta(), image(), dataDir);
    expect(asset.status).toBe("candidate");

    const marked = await markResearchAssetImported(asset.assetId, dataDir);
    expect(marked?.status).toBe("imported");
    expect(await indexLines()).toHaveLength(2); // 原始一行 + 改态一行

    const again = await markResearchAssetImported(asset.assetId, dataDir);
    expect(again?.status).toBe("imported");
    expect(await indexLines()).toHaveLength(2); // 已是 imported → 不再追加
    expect((await getResearchAsset(asset.assetId, dataDir))?.status).toBe("imported");
  });

  it("无此 assetId → null（不静默成功）", async () => {
    expect(await markResearchAssetImported("rasset-none", dataDir)).toBeNull();
  });
});

describe("路径穿越防护", () => {
  it("getResearchAssetFile 返回绝对路径，且文件读得到", async () => {
    const asset = await saveResearchAsset(meta(), image(), dataDir);
    const full = await getResearchAssetFile(asset.assetId, dataDir);
    expect(full).toBe(path.resolve(dataDir, asset.file));
    expect(path.isAbsolute(full!)).toBe(true);
    expect((await fs.readFile(full!)).equals(image().bytes)).toBe(true);
  });

  it.each([
    ["上跳出 dataDir", "../../../etc/passwd"],
    ["跳出 assets 目录但仍在 dataDir 内", "research/briefs/topic-x.v1.json"],
    ["绝对路径", "/etc/passwd"],
    ["assets 目录的兄弟前缀", "research/assets-evil/x.png"],
  ])("索引被污染成 %s → 抛，不静默", async (_label, file) => {
    const asset = await saveResearchAsset(meta(), image(), dataDir);
    await fs.appendFile(indexFile(), JSON.stringify({ ...asset, file }) + "\n", "utf-8");
    await expect(getResearchAssetFile(asset.assetId, dataDir)).rejects.toThrow(/路径越界/);
    expect(() => resolveAssetPath(file, dataDir)).toThrow(/路径越界/);
  });
});
