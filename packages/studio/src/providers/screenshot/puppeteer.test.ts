import { describe, it, expect, vi } from "vitest";
import { PuppeteerScreenshot } from "./puppeteer.js";

vi.mock("puppeteer", () => {
  const mockPage = {
    setViewport: vi.fn(),
    setContent: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    close: vi.fn(),
  };
  const mockBrowser = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn(),
  };
  return {
    default: { launch: vi.fn().mockResolvedValue(mockBrowser) },
  };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe("PuppeteerScreenshot", () => {
  it("screenshots HTML to file", async () => {
    const ss = new PuppeteerScreenshot();
    const result = await ss.capture(
      "<html><body><h1>Test</h1></body></html>",
      { width: 1080, height: 1920 },
      "/tmp/card.png"
    );
    expect(result.path).toBe("/tmp/card.png");
    expect(result.format).toBe("png");
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
  });
});
