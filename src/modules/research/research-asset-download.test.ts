/**
 * research-asset-download.test.ts — 下载段的两件事（管线级矩阵在 deep-research.test.ts）：
 * 1. 每个 errorCode 都要有**说得出口的**人话，没有一个漏进兜底；
 * 2. 顺序/长度不变（降级 ≠ 删除）与单张超时按剩余墙钟收窄。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ASSET_DOWNLOAD_DEADLINE_MS,
  ASSET_DOWNLOAD_MAX_COUNT,
  ASSET_DOWNLOAD_MAX_TOTAL_BYTES,
  downloadBriefAssets,
} from "./research-asset-download.js";
import {
  FetchImageError,
  type FetchImageErrorCode,
  type FetchImageOptions,
  type FetchedImage,
  type fetchExternalImage,
} from "./fetch-image.js";
import type { BriefAssetPick } from "./brief-store.js";

let dataDir: string;
const TOPIC = "topic-abc123";

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-asset-download-"));
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

const pick = (n: number): BriefAssetPick => ({
  url: `https://cdn.test/${n}.png`,
  sourcePageUrl: `https://ex.test/p${n}`,
  caption: `图 ${n}`,
});

const okImpl = (async (url: string): Promise<FetchedImage> => ({
  bytes: pngBytes(url),
  format: "png",
  width: 800,
  height: 600,
  finalUrl: url,
})) as unknown as typeof fetchExternalImage;

const throwing = (code: FetchImageErrorCode): typeof fetchExternalImage =>
  (async () => {
    throw new FetchImageError(code, "桩");
  }) as unknown as typeof fetchExternalImage;

// 预算是对外承诺（spec §7），改它要连这条一起改——不许悄悄放宽
it("预算常量锁定：12 张 / 30MB / 3 分钟", () => {
  expect(ASSET_DOWNLOAD_MAX_COUNT).toBe(12);
  expect(ASSET_DOWNLOAD_MAX_TOTAL_BYTES).toBe(30 * 1024 * 1024);
  expect(ASSET_DOWNLOAD_DEADLINE_MS).toBe(180_000);
});

describe("errorCode → 人话", () => {
  it.each<[FetchImageErrorCode, string]>([
    ["invalid_url", "地址不合法"],
    ["unsupported_protocol", "地址不合法"],
    ["ssrf_blocked", "内网"],
    ["too_many_redirects", "跳转"],
    ["svg_rejected", "SVG"],
    ["unsupported_format", "格式不收"],
    ["bad_image", "坏图"],
    ["image_too_large", "像素尺寸"],
    ["body_too_large", "5MB"],
    ["timeout", "超时"],
    ["fetch_failed", "下载失败"],
    ["http_403", "防盗链"],
    ["http_401", "防盗链"],
    ["http_404", "已失效"],
    ["http_500", "返回 500"],
  ])("%s → 含「%s」", async (code, phrase) => {
    const res = await downloadBriefAssets([pick(1)], {
      dataDir,
      topicId: TOPIC,
      fetchImageImpl: throwing(code),
    });
    expect(res.picks[0].downloadError).toContain(phrase);
    expect(res.picks[0].assetId).toBeUndefined();
    expect(res.storedCount).toBe(0);
  });

  it("非 FetchImageError（存盘炸了）也降级这一张，不冒泡", async () => {
    await fs.mkdir(path.join(dataDir, "research"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "research", "assets"), "占位文件", "utf-8");
    const res = await downloadBriefAssets([pick(1)], { dataDir, topicId: TOPIC, fetchImageImpl: okImpl });
    expect(res.picks[0].downloadError).toBe("存入素材库失败，只保留链接");
  });
});

describe("不变量", () => {
  it("空清单：不产 gap，也不报错", async () => {
    const res = await downloadBriefAssets([], { dataDir, topicId: TOPIC, fetchImageImpl: okImpl });
    expect(res).toEqual({ picks: [], storedCount: 0 });
  });

  it("同序同长：三张里挂一张，返回的还是三张、顺序不变", async () => {
    const impl = (async (url: string) => {
      if (url.includes("2.png")) throw new FetchImageError("timeout", "桩");
      return { bytes: pngBytes(url), format: "png" as const, width: 800, height: 600, finalUrl: url };
    }) as unknown as typeof fetchExternalImage;

    const res = await downloadBriefAssets([pick(1), pick(2), pick(3)], {
      dataDir,
      topicId: TOPIC,
      fetchImageImpl: impl,
    });
    expect(res.picks.map((p) => p.url)).toEqual([pick(1).url, pick(2).url, pick(3).url]);
    expect(res.storedCount).toBe(2);
    expect(res.gap).toBeUndefined(); // 有存下来的就不算全军覆没
  });

  it("单张超时按剩余墙钟收窄（一个吊死的连接拖不垮整段预算）", async () => {
    const timeouts: number[] = [];
    let clock = 0;
    const impl = (async (url: string, opts: FetchImageOptions = {}) => {
      timeouts.push(opts.timeoutMs ?? -1);
      return { bytes: pngBytes(url), format: "png" as const, width: 800, height: 600, finalUrl: url };
    }) as unknown as typeof fetchExternalImage;

    await downloadBriefAssets([pick(1), pick(2)], {
      dataDir,
      topicId: TOPIC,
      fetchImageImpl: impl,
      deadlineMs: 5_000,
      now: () => (clock += 1_000),
    });
    expect(timeouts).toHaveLength(2);
    expect(timeouts.every((t) => t > 0 && t <= 5_000)).toBe(true);
    expect(timeouts[1]).toBeLessThan(timeouts[0]); // 时间在走，配额跟着缩
  });
});
