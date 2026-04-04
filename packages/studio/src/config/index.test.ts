import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig, type StudioConfig } from "./index.js";
import { readFile } from "node:fs/promises";

vi.mock("node:fs/promises");

describe("loadConfig", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads config from file", async () => {
    const cfg: StudioConfig = {
      tts: {
        provider: "doubao",
        doubao: { appId: "app1", accessToken: "tok1", voiceType: "BV700_V2_streaming" },
      },
      screenshot: { provider: "puppeteer" },
      compositor: { provider: "jianying", jianying: { draftDir: "/tmp/drafts" } },
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(cfg));
    const result = await loadConfig("/fake/.autocrew");
    expect(result.tts.provider).toBe("doubao");
    expect(result.tts.doubao?.appId).toBe("app1");
  });

  it("returns defaults when file missing", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const result = await loadConfig("/fake/.autocrew");
    expect(result.tts.provider).toBe("doubao");
    expect(result.compositor.provider).toBe("jianying");
  });
});
