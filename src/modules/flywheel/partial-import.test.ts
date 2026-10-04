/** 行已落盘、提交绑定时才失去写入权：导入报告不能丢，要带着已入账条数抛出去 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypedRow } from "../../adapters/browser/pull-types.js";

vi.mock("./outcome-store.js", async (orig) => ({
  ...(await orig<typeof import("./outcome-store.js")>()),
  commitResolvedBindings: vi.fn(async () => { throw new Error("library_writer_lost: 当前服务已失去资料库写入权；不会自动抢占。"); }),
}));

const { importPerformanceRows, PartialImportError } = await import("./row-import.js");
const { listOutcomes } = await import("./outcome-store.js");

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-partial-import-"));
  vi.stubEnv("AUTOCREW_LOCAL_DIR", path.join(dir, "machine"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

const row: TypedRow = { title: "作品", publishedAt: "2026-08-01T12:00:00Z", platformItemId: "7500000000000000001", metricDate: "2026-09-26", metrics: { views: 1000 } };

describe("提交绑定时失去写入权", () => {
  it("抛 PartialImportError，携带已入账报告；行确实已落盘", async () => {
    const err = await importPerformanceRows("douyin", [row], { source: "auto", dataDir: dir }).catch((e) => e);
    expect(err).toBeInstanceOf(PartialImportError);
    expect(err.message).toMatch(/library_writer_lost/);
    expect(err.report.imported).toBe(1);
    expect(await listOutcomes(dir)).toHaveLength(1);
  });
});
