import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PIPELINE_STAGES,
  initPipeline,
  pipelinePath,
  stagePath,
  slugify,
} from "../storage/pipeline-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "autocrew-pipeline-test-"),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ─── Pipeline Init ──────────────────────────────────────────────────────────

describe("Pipeline Init", () => {
  it("pipelinePath returns correct path", () => {
    expect(pipelinePath(testDir)).toBe(path.join(testDir, "pipeline"));
  });

  it("stagePath returns correct path", () => {
    expect(stagePath("intel", testDir)).toBe(
      path.join(testDir, "pipeline", "intel"),
    );
  });

  it("initPipeline creates all stage directories", async () => {
    await initPipeline(testDir);
    for (const stage of PIPELINE_STAGES) {
      const stat = await fs.stat(stagePath(stage, testDir));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it("initPipeline creates intel subdirectories", async () => {
    await initPipeline(testDir);
    const intelDir = stagePath("intel", testDir);
    const sources = await fs.stat(path.join(intelDir, "_sources"));
    const archive = await fs.stat(path.join(intelDir, "_archive"));
    expect(sources.isDirectory()).toBe(true);
    expect(archive.isDirectory()).toBe(true);
  });

  it("initPipeline is idempotent", async () => {
    await initPipeline(testDir);
    await initPipeline(testDir);
    for (const stage of PIPELINE_STAGES) {
      const stat = await fs.stat(stagePath(stage, testDir));
      expect(stat.isDirectory()).toBe(true);
    }
  });
});

// ─── Slugify ─────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("handles English text", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });

  it("handles Chinese text", () => {
    expect(slugify("AI内容创作趋势")).toBe("ai内容创作趋势");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });
});
