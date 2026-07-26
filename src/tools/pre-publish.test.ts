import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveContent } from "../storage/local-store.js";
import { executePrePublish } from "./pre-publish.js";

vi.mock("./review.js", () => ({
  executeReview: vi.fn().mockResolvedValue({
    ok: true,
    passed: true,
    qualityScore: { total: 90 },
    summary: "通过",
  }),
}));

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-prepublish-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("executePrePublish platform-specific checks", () => {
  it("does not require hashtags for WeChat official-account articles", async () => {
    const content = await saveContent(
      {
        title: "一篇可以发布的公众号文章",
        body: "这是公众号正文。".repeat(120),
        platform: "wechat_mp",
        status: "approved",
        tags: [],
      },
      dataDir,
    );

    const result = await executePrePublish({ action: "check", content_id: content.id, _dataDir: dataDir });
    expect("checks" in result).toBe(true);
    if (!("checks" in result)) return;
    expect(result.checks.find((check) => check.name === "Hashtags")).toMatchObject({ status: "skip" });
    expect(result.allPassed).toBe(true);
  });
});
