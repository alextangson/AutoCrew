/**
 * research-asset-route.test.ts — 研究素材取图端点的安全语义（深调研 §7）：
 * 鉴权先于一切、id 形状、索引被污染时的越界拒绝、文件丢失与 content-type。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serveResearchAsset } from "./research-asset-route.js";
import {
  researchAssetsDir,
  saveResearchAsset,
  type ResearchAsset,
} from "../modules/research/research-asset-store.js";
import type { FetchedImage } from "../modules/research/fetch-image.js";

let dataDir: string;
const TOPIC = "topic-abc123";

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-research-route-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function pngBytes(seed: string): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(800, 16);
  head.writeUInt32BE(600, 20);
  return Buffer.concat([head, Buffer.from(seed, "utf-8")]);
}

const image = (over: Partial<FetchedImage> = {}): FetchedImage => ({
  bytes: pngBytes("a"),
  format: "png",
  width: 800,
  height: 600,
  finalUrl: "https://cdn.test/a.png",
  ...over,
});

const seed = (over: Partial<FetchedImage> = {}): Promise<ResearchAsset> =>
  saveResearchAsset(
    {
      topicId: TOPIC,
      sourceUrl: over.finalUrl ?? "https://cdn.test/a.png",
      sourcePageUrl: "https://ex.test/p",
      caption: "图",
    },
    image(over),
    dataDir,
  );

const indexFile = () => path.join(researchAssetsDir(dataDir), "index.jsonl");

describe("鉴权", () => {
  it("未鉴权 → 403，即使 asset_id 完全合法", async () => {
    const asset = await seed();
    const res = await serveResearchAsset({ assetId: asset.assetId, authorized: false, dataDir });
    expect(res).toEqual({ ok: false, status: 403, error: "not authenticated" });
  });

  it("未鉴权时连存储层都不碰（dataDir 是坏的也照样 403，不冒出别的错）", async () => {
    const res = await serveResearchAsset({
      assetId: "rasset-1-abc",
      authorized: false,
      dataDir: "/nonexistent/definitely-not-here",
    });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });
});

describe("id 与存在性", () => {
  it.each([
    ["空", ""],
    ["路径穿越", "../../etc/passwd"],
    ["别的实体 id", "content-1-abc"],
    ["带斜杠", "rasset-1/abc"],
  ])("asset_id %s → 400，不进存储层", async (_label, assetId) => {
    const res = await serveResearchAsset({ assetId, authorized: true, dataDir });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("形状合法但库里没有 → 404", async () => {
    const res = await serveResearchAsset({ assetId: "rasset-1-abc", authorized: true, dataDir });
    expect(res).toMatchObject({ ok: false, status: 404 });
  });

  it("索引有记录但文件被删 → 404（不是 200 空响应）", async () => {
    const asset = await seed();
    await fs.rm(path.join(dataDir, asset.file));
    const res = await serveResearchAsset({ assetId: asset.assetId, authorized: true, dataDir });
    expect(res).toMatchObject({ ok: false, status: 404 });
  });
});

describe("越界", () => {
  it.each([
    ["上跳出 dataDir", "../../../etc/passwd"],
    ["跳出 assets 目录但仍在 dataDir 内", "research/briefs/topic-x.v1.json"],
    ["绝对路径", "/etc/passwd"],
    ["assets 目录的兄弟前缀", "research/assets-evil/x.png"],
  ])("索引被污染成 %s → 403，绝不吐字节", async (_label, file) => {
    const asset = await seed();
    await fs.appendFile(indexFile(), JSON.stringify({ ...asset, file }) + "\n", "utf-8");
    const res = await serveResearchAsset({ assetId: asset.assetId, authorized: true, dataDir });
    expect(res).toEqual({ ok: false, status: 403, error: "asset path out of bounds" });
  });
});

describe("happy", () => {
  it("回绝对路径 + 按 format 定的 content-type", async () => {
    const asset = await seed();
    const res = await serveResearchAsset({ assetId: asset.assetId, authorized: true, dataDir });
    expect(res).toEqual({
      ok: true,
      file: path.resolve(dataDir, asset.file),
      contentType: "image/png",
    });
  });

  it.each([
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ])("format %s → %s", async (format, contentType) => {
    const asset = await seed({
      format: format as FetchedImage["format"],
      finalUrl: `https://cdn.test/${format}.bin`,
    });
    const res = await serveResearchAsset({ assetId: asset.assetId, authorized: true, dataDir });
    expect(res).toMatchObject({ ok: true, contentType });
  });
});
