import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getRadarStatus,
  doRadarRefresh,
  collectMoreRadarTopics,
  rescoreRadarTopics,
  setRadarSources,
} from "./radar-status.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-radarstatus-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const RSS = `<rss><channel><item><title>T1</title><link>https://a.com/1</link><pubDate>Thu, 11 Jun 2026 01:00:00 GMT</pubDate></item></channel></rss>`;

describe("getRadarStatus", () => {
  it("returns sources list and null cache state when never fetched", async () => {
    const res = await getRadarStatus({ _dataDir: testDir });
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    const sources = d.sources as Array<Record<string, unknown>>;
    expect(sources.length).toBeGreaterThanOrEqual(2);
    expect(sources[0]).toHaveProperty("name");
    expect(sources[0]).toHaveProperty("kind"); // 统一情报层 v2:kind + enabled + config
    expect(sources[0]).toHaveProperty("enabled");
    expect((sources[0].config as Record<string, unknown>).url).toMatch(/^https?:/); // 管理 UI 要编辑 url
    expect(d.fetchedAt).toBeNull();
    expect(d.itemCount).toBe(0);
  });

  it("setRadarSources persists a user list that getRadarStatus then returns", async () => {
    const set = await setRadarSources({
      _dataDir: testDir,
      sources: [{ id: "", name: "量子位", type: "rss", url: "https://www.qbitai.com/feed", tracks: [] }],
    });
    expect(set.ok).toBe(true);

    const res = await getRadarStatus({ _dataDir: testDir });
    const sources = (res.data as Record<string, unknown>).sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe("量子位");
  });

  it("setRadarSources rejects a non-array payload", async () => {
    const res = await setRadarSources({ _dataDir: testDir, sources: "not-array" });
    expect(res.ok).toBe(false);
  });

  it("returns cache stats after a refresh", async () => {
    const fetchImpl = vi.fn(async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
    await doRadarRefresh({ _dataDir: testDir }, fetchImpl);
    const res = await getRadarStatus({ _dataDir: testDir });
    const d = res.data as Record<string, unknown>;
    expect(typeof d.fetchedAt).toBe("string");
    expect(d.itemCount).toBeGreaterThan(0);
  });
});

describe("doRadarRefresh", () => {
  it("refreshes and reports counts and failed sources", async () => {
    // 固定两个 RSS 源,与「默认开哪些海外源」解耦——本用例只测 RSS 单源失败的容错
    await setRadarSources({
      _dataDir: testDir,
      sources: [
        { id: "36kr", name: "36氪", type: "rss", url: "https://36kr.com/feed", tracks: [] },
        { id: "ifanr", name: "爱范儿", type: "rss", url: "https://www.ifanr.com/feed", tracks: [] },
      ],
    });
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes("36kr")) return new Response(RSS, { status: 200 });
      throw new Error("down");
    }) as unknown as typeof fetch;
    const res = await doRadarRefresh({ _dataDir: testDir }, fetchImpl);
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.itemCount).toBe(1);
    expect(d.failedSources).toEqual(["爱范儿"]);
  });
});

describe("continue collection / rescore handlers", () => {
  it("collectMore passes the requested batch size and returns counts", async () => {
    const intakeImpl = vi.fn(async (_dir, options) => ({
      saved: Array.from({ length: options?.limit ?? 0 }, (_, i) => ({ id: `t${i}` })),
      skippedDuplicates: 2,
      qualified: 8,
      filter: "llm" as const,
    })) as unknown as typeof import("../modules/radar/radar-intake.js").intakeRadarTopics;
    const refreshImpl = vi.fn(async () => ({ ok: true, itemCount: 50, failedSources: [] })) as unknown as typeof import("../modules/radar/topic-radar.js").refreshTopicRadar;
    const res = await collectMoreRadarTopics(
      { _dataDir: testDir, limit: 5, refresh: true },
      globalThis.fetch,
      { intakeImpl, refreshImpl },
    );
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).savedCount).toBe(5);
    expect(intakeImpl).toHaveBeenCalledWith(testDir, { limit: 5, poolSize: 24 });
  });

  it("rescore exposes updated count", async () => {
    const rescoreImpl = vi.fn(async () => ({ updated: [{ id: "t1" }, { id: "t2" }], examined: 3 })) as unknown as typeof import("../modules/radar/radar-intake.js").rescoreExistingTopics;
    const res = await rescoreRadarTopics({ _dataDir: testDir }, { rescoreImpl });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ updatedCount: 2, examined: 3 });
  });
});
