import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  format: "png";
}

export interface Viewport {
  width: number;
  height: number;
}

export class PuppeteerScreenshot {
  private browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

  private async getBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({ headless: true });
    }
    return this.browser;
  }

  async capture(html: string, viewport: Viewport, outputPath: string): Promise<ScreenshotResult> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setViewport(viewport);
      await page.setContent(html, { waitUntil: "networkidle0" });
      await mkdir(dirname(outputPath), { recursive: true });
      await page.screenshot({ path: outputPath, type: "png" });
      return { path: outputPath, width: viewport.width, height: viewport.height, format: "png" };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
