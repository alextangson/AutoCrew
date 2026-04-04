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
  async capture(
    html: string,
    viewport: Viewport,
    outputPath: string
  ): Promise<ScreenshotResult> {
    const browser = await puppeteer.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setViewport(viewport);
      await page.setContent(html, { waitUntil: "networkidle0" });

      await mkdir(dirname(outputPath), { recursive: true });
      await page.screenshot({ path: outputPath, type: "png" });
      await page.close();

      return {
        path: outputPath,
        width: viewport.width,
        height: viewport.height,
        format: "png",
      };
    } finally {
      await browser.close();
    }
  }
}
