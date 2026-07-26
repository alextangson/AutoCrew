import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePipeline } from "./pipeline.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pipeline-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("pipeline filesystem boundary", () => {
  it("creates and reads a valid pipeline", async () => {
    const created = await executePipeline({
      action: "create",
      name: "每日推广",
      schedule: "0 9 * * *",
      _dataDir: dataDir,
    });
    expect(created.ok).toBe(true);
    const id = (created as { pipeline: { id: string } }).pipeline.id;
    expect(await executePipeline({ action: "get", id, _dataDir: dataDir })).toMatchObject({ ok: true });
  });

  it.each(["../secret", "pipeline-1/../../secret", "pipeline\\secret"])(
    "rejects traversal id %s",
    async (id) => {
      expect(await executePipeline({ action: "get", id, _dataDir: dataDir })).toEqual({
        ok: false,
        error: "Invalid pipeline id",
      });
      expect(await executePipeline({ action: "delete", id, _dataDir: dataDir })).toEqual({
        ok: false,
        error: "Invalid pipeline id",
      });
    },
  );
});
