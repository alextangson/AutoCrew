import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getRadarStatus, doRadarRefresh, setRadarSources } from "./radar-status.js";

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
    expect(sources[0]).toHaveProperty("tracks");
    expect(sources[0]).toHaveProperty("url"); // IA v4.2 §A1:源管理 UI 要编辑 url,出境（本地单用户）
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
