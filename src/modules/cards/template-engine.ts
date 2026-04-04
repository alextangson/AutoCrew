// Card template engine — renders HTML knowledge cards for video overlay

import type { AspectRatio, CardTemplate } from "../../types/timeline.js";
import { render as comparisonTable } from "./templates/comparison-table.js";
import { render as keyPoints } from "./templates/key-points.js";
import { render as flowChart } from "./templates/flow-chart.js";
import { render as dataChart } from "./templates/data-chart.js";

const DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
};

const renderers: Record<CardTemplate, (data: Record<string, unknown>) => string> = {
  "comparison-table": comparisonTable,
  "key-points": keyPoints,
  "flow-chart": flowChart,
  "data-chart": dataChart,
};

export interface RenderCardOptions {
  aspectRatio?: AspectRatio;
}

/**
 * Render a knowledge card as a complete HTML document.
 * The output is designed to be screenshotted by Puppeteer at the exact
 * pixel dimensions matching the chosen aspect ratio.
 */
export function renderCard(
  template: CardTemplate,
  data: Record<string, unknown>,
  options?: RenderCardOptions
): string {
  const renderer = renderers[template];
  if (!renderer) {
    throw new Error(`Unknown card template: ${template}`);
  }

  const ratio = options?.aspectRatio ?? "9:16";
  const { width, height } = DIMENSIONS[ratio];
  const body = renderer(data);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${width}">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
  }
  body {
    background: #ffffff;
    font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 80px;
    color: #1e293b;
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
