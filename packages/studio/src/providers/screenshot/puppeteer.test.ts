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
    await ss.close();
  });

  it("reuses browser across captures", async () => {
    const puppeteer = await import("puppeteer");
    const launchMock = vi.mocked(puppeteer.default.launch);
    const callsBefore = launchMock.mock.calls.length;
    const ss = new PuppeteerScreenshot();
    await ss.capture("<h1>A</h1>", { width: 100, height: 100 }, "/tmp/a.png");
    await ss.capture("<h1>B</h1>", { width: 100, height: 100 }, "/tmp/b.png");
    // launch should only be called once due to browser reuse
    expect(launchMock.mock.calls.length - callsBefore).toBe(1);
    await ss.close();
  });
});
