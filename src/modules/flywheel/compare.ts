/**
 * 「比平时」服务端口径（发布台 spec 吸收 1）：和数据页同一把尺子——
 * 每个平台取每行（一条视频）该平台作品的最新累计播放，中位数 = 平时；样本 ≥3 才比。
 * 数据页（frontend/src/views/data-lib.ts boldThresholds / data-answers.ts ratioText）本身不改，这里是同一算法的服务端版。
 */
import type { DataRow, Work } from "./data-rows.js";
import { latest } from "./data-rows.js";

export const MIN_SAMPLES = 3;
/** 0.9–1.05 = 和平时差不多（数据页 UP / DOWN） */
export const UP = 1.05, DOWN = 0.9;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const viewsOf = (w: Work): number | null => { const v = latest(w).metrics.views; return typeof v === "number" ? v : null; };

/** 每个平台的播放数（每行同平台只取第一条作品，与数据页单元格口径一致） */
export function viewsByPlatform(rows: DataRow[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const w of r.works) {
      const v = viewsOf(w);
      if (seen.has(w.platform) || v === null) continue;
      seen.add(w.platform);
      out.set(w.platform, [...(out.get(w.platform) ?? []), v]);
    }
  }
  return out;
}

export interface Baseline { median: number | null; samples: number }

export function platformBaselines(rows: DataRow[]): Map<string, Baseline> {
  const out = new Map<string, Baseline>();
  for (const [p, vs] of viewsByPlatform(rows)) out.set(p, { median: vs.length >= MIN_SAMPLES ? median(vs) : null, samples: vs.length });
  return out;
}

export type Comparison =
  | { kind: "ratio"; ratio: number; baseline: number; samples: number }
  | { kind: "thin"; samples: number };

export function compareViews(views: number, base: Baseline | undefined): Comparison {
  if (!base?.median) return { kind: "thin", samples: base?.samples ?? 0 };
  return { kind: "ratio", ratio: views / base.median, baseline: base.median, samples: base.samples };
}

/** 卡 / 行上的一句：「比你抖音的中位数高 40%」；样本不足「历史太少，不比」 */
export function comparisonText(c: Comparison, platformName: string): { text: string; tone: "up" | "down" | "flat" | "thin" } {
  if (c.kind === "thin") return { text: "历史太少，不比", tone: "thin" };
  const pct = Math.round(Math.abs(c.ratio - 1) * 100);
  if (c.ratio > UP) return { text: `比你${platformName}的中位数高 ${pct}%`, tone: "up" };
  if (c.ratio < DOWN) return { text: `比你${platformName}的中位数低 ${pct}%`, tone: "down" };
  return { text: `和你${platformName}的中位数差不多`, tone: "flat" };
}
