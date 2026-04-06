import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeIntel } from "./intel.js";
import { listIntel } from "../storage/pipeline-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-intel-test-"));
  // Create a minimal creator profile so loadProfile doesn't fail
  await fs.writeFile(
    path.join(testDir, "creator-profile.json"),
    JSON.stringify({
      industry: "tech",
      platforms: ["xiaohongshu"],
      writingRules: [],
      styleCalibrated: false,
    }),
    "utf-8",
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("executeIntel – ingest action", () => {
  it("ingests text and saves as intel item", async () => {
    const result = (await executeIntel({
      action: "ingest",
      text: "AI video editing tools are transforming short-form content creation workflows for solo creators.",
      domain: "ai-tools",
      tags: ["ai", "video"],
      _dataDir: testDir,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.action).toBe("ingest");
    expect(result.mode).toBe("text");
    expect(result.saved).toBe(true);

    // Verify the item was actually saved
    const items = await listIntel("ai-tools", testDir);
    expect(items.length).toBe(1);
    expect(items[0].source).toBe("manual");
    expect(items[0].tags).toContain("ai");
  });

  it("rejects ingest without url or text", async () => {
    const result = (await executeIntel({
      action: "ingest",
      domain: "ai-tools",
      _dataDir: testDir,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ingest requires/i);
  });
});
