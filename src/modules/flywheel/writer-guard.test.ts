/** 资料库单写锁：回流/飞轮写路径没写入权就拒绝，且一个字节都不落（真锁，不 mock） */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLibraryLock, WRITER_LOCK } from "../../storage/library-lock.js";
import { saveContent } from "../../storage/local-store.js";
import { appendOutcomes, commitResolvedBindings } from "./outcome-store.js";
import { importPerformanceRows } from "./row-import.js";
import { bindWorkManually, createHistoryRecord, deleteHistoryRecord } from "./work-binding.js";
import { pullPlatformNow, writeRefusalFor } from "../../desktop/metrics-pull-cycle.js";
import { pullStatusHandler } from "../../desktop/metrics-pull-handlers.js";
import type { PerformanceOutcome } from "./outcome-schema.js";
import type { TypedRow } from "../../adapters/browser/pull-types.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

let temp: string, lib: string, data: string;
let release: () => void = () => {};

const outcome = (): PerformanceOutcome => ({
  contentId: null, platform: "douyin", platformTitle: "作品", publishedAt: "2026-08-01T20:00:00+08:00", metricDate: "2026-09-26",
  metrics: { views: 1000 }, source: "csv", recordedAt: "2026-09-26T00:00:00Z", needsReview: false, reviewReasons: [],
});
const typedRow: TypedRow = { title: "作品", publishedAt: "2026-08-01T12:00:00Z", platformItemId: "7500000000000000001", metricDate: "2026-09-26", metrics: { views: 1000 } };

async function foreignLock(): Promise<void> {
  await fs.mkdir(path.join(lib, WRITER_LOCK));
  await fs.writeFile(path.join(lib, WRITER_LOCK, "owner.json"), JSON.stringify({ host: "other-mac", pid: 1, nonce: "foreign" }));
}
const read = (f: string) => fs.readFile(path.join(data, f), "utf-8").catch(() => null);

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-writer-guard-"));
  const machine = path.join(temp, "machine");
  lib = path.join(temp, "library");
  data = path.join(lib, "workspaces/default");
  vi.stubEnv("AUTOCREW_LOCAL_DIR", machine);
  await fs.mkdir(machine, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(machine, "storage.json"), JSON.stringify({ version: 1, id: "lib-deadbeef", root: lib }));
  await fs.writeFile(path.join(lib, "autocrew-library.json"), JSON.stringify({ version: 1, id: "lib-deadbeef" }));
});

afterEach(async () => {
  release();
  release = () => {};
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(temp, { recursive: true, force: true });
});

describe("非持锁进程", () => {
  beforeEach(foreignLock);

  it("appendOutcomes 被拒，outcomes.jsonl 不建", async () => {
    await expect(appendOutcomes([outcome()], data)).rejects.toThrow(/library_writer_lost/);
    expect(await read("outcomes.jsonl")).toBeNull();
  });

  it("importPerformanceRows 被拒，零写入", async () => {
    await expect(importPerformanceRows("douyin", [typedRow], { source: "auto", dataDir: data })).rejects.toThrow(/library_writer_lost/);
    expect(await read("outcomes.jsonl")).toBeNull();
    expect(await read("platform-items.json")).toBeNull();
  });

  it("commitResolvedBindings 把失去写入权抛出去，不吞成 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(commitResolvedBindings([{ platform: "douyin", itemId: "1", contentId: "c1", via: "manual" }], data))
      .rejects.toThrow(/library_writer_lost/);
    expect(warn).not.toHaveBeenCalled();
  });

  it("pullPlatformNow 不调抓取器、不写状态；只发不落盘的刷新事件", async () => {
    const fetcher = vi.fn();
    const emit = vi.fn(async () => ({}) as never);
    const attempt = await pullPlatformNow("douyin", { dataDir: data, registry: { douyin: fetcher }, emit });
    expect(attempt).toMatchObject({ status: "error", rowCount: 0, errorCode: "library_writer_lost" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "metrics_pull" }), data, { persist: false });
    expect(await read("metrics-pull.json")).toBeNull();
    expect(await read("events.jsonl")).toBeNull();
  });

  it("拒绝看得见：默认 warn 进 console、内存里记一笔、pull_status 带出来；拿回锁后清掉", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pullPlatformNow("douyin", { dataDir: data, registry: { douyin: vi.fn() }, emit: vi.fn() });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("library_writer_lost"));
    expect(writeRefusalFor(data, "douyin")).toMatchObject({ code: "library_writer_lost", at: expect.any(String) });
    const status = await pullStatusHandler({ _dataDir: data });
    const rows = (status.data as { platforms: Array<Record<string, unknown>> }).platforms;
    expect(rows[0].writeRefusal).toMatchObject({ code: "library_writer_lost" });
    expect(rows[1].writeRefusal).toBeUndefined();
    expect(await read("metrics-pull.json")).toBeNull();

    await fs.rm(path.join(lib, WRITER_LOCK), { recursive: true });
    release = acquireLibraryLock(lib);
    await pullPlatformNow("douyin", { dataDir: data, registry: { douyin: async () => ({ status: "ok", rows: [typedRow] }) }, emit: vi.fn(async () => ({}) as never), warn: () => {} });
    expect(writeRefusalFor(data, "douyin")).toBeNull();
  });
});

describe("多文件写的整体预检", () => {
  it("bindWorkManually / createHistoryRecord / deleteHistoryRecord 非持锁 → ok:false，文件不动", async () => {
    release = acquireLibraryLock(lib);
    const draft = await saveContent({ _provenance: HUMAN_WRITE, title: "稿", body: "正文", platform: "douyin", status: "drafting", tags: [] }, data);
    const history = await createHistoryRecord({ title: "旧作", published_date: "2025-01-01", items: [{ platform: "douyin", item_id: "7500000000000000002" }] }, data);
    expect(history.ok).toBe(true);
    await appendOutcomes([outcome()], data);
    const before = [await read("platform-items.json"), await read("outcomes.jsonl")];
    release();
    release = () => {};
    await foreignLock();

    const bound = await bindWorkManually(draft.id, "douyin", "7500000000000000003", data);
    expect(bound).toMatchObject({ ok: false, error: expect.stringMatching(/library_writer_lost/) });
    expect("partial" in bound).toBe(false);
    const created = await createHistoryRecord({ title: "另一条", published_date: "2025-02-01", items: [{ platform: "douyin", item_id: "7500000000000000004" }] }, data);
    expect(created).toMatchObject({ ok: false, error: expect.stringMatching(/library_writer_lost/) });
    const deleted = await deleteHistoryRecord((history as { contentId: string }).contentId, data);
    expect(deleted).toMatchObject({ ok: false, error: expect.stringMatching(/library_writer_lost/) });
    expect([await read("platform-items.json"), await read("outcomes.jsonl")]).toEqual(before);
  });
});

describe("持锁进程", () => {
  it("appendOutcomes / importPerformanceRows 照常写", async () => {
    release = acquireLibraryLock(lib);
    await appendOutcomes([outcome()], data);
    const report = await importPerformanceRows("douyin", [{ ...typedRow, title: "另一条" }], { source: "auto", dataDir: data });
    expect(report.imported).toBe(1);
    expect((await read("outcomes.jsonl"))!.trim().split("\n")).toHaveLength(2);
  });
});

describe("没配资料库", () => {
  it("不在资料库里的目录照旧可写；绑定表其他错误仍只 warn", async () => {
    vi.stubEnv("AUTOCREW_LOCAL_DIR", path.join(temp, "no-library"));
    const plain = path.join(temp, "plain");
    await appendOutcomes([outcome()], plain);
    expect(await fs.readFile(path.join(plain, "outcomes.jsonl"), "utf-8")).toContain("作品");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.writeFile(path.join(temp, "a-file"), "x");
    await commitResolvedBindings([{ platform: "douyin", itemId: "1", contentId: "c1", via: "manual" }], path.join(temp, "a-file", "sub"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("平台作品绑定写入失败"));
  });
});
