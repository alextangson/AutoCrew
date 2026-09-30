/**
 * 修法建议（spec §12-9）：看这版成片的字幕事实（srt，for_cut = 这版成片）。缝所在的时间里没有字幕 = 没在说话 →
 * 剪掉气口；有字幕 → 拖长前一段 B-roll 盖住；没有字幕或读不出 → 请人工判断。
 * 建议只是附带信息：算不出来不影响「有缝」的结论，绝不因此降成未检查（E27）。
 */
import type { Sliver } from "../../../storage/production-types.js";
import type { Fps } from "./snapshot-types.js";

export const SUGGEST = {
  trim: "剪掉这个气口，让两段 B-roll 接上",
  hold: "把前一段 B-roll 拖长（或补一帧定格）盖住",
  manual: "请人工判断：剪气口，或拖长前一段 B-roll",
} as const;

/** SRT → [开始秒, 结束秒)；一条都解析不出 → null */
export function parseSrt(text: string): Array<[number, number]> | null {
  const t = (h: string, m: string, s: string, ms: string) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
  const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(re)) out.push([t(m[1], m[2], m[3], m[4]), t(m[5], m[6], m[7], m[8])]);
  return out.length ? out : null;
}

export function suggestFor(s: Sliver, fps: Fps, cues: Array<[number, number]> | null): string {
  if (!cues) return SUGGEST.manual;
  const a = (s.start_frame * fps.den) / fps.num, b = (s.end_frame * fps.den) / fps.num;
  return cues.some(([x, y]) => x < b && y > a) ? SUGGEST.hold : SUGGEST.trim;
}

export function withSuggestions(slivers: Sliver[], fps: Fps | null, srtText: string | null): Sliver[] {
  const cues = srtText ? parseSrt(srtText) : null;
  return slivers.map((s) => ({ ...s, suggestion: fps ? suggestFor(s, fps, cues) : SUGGEST.manual }));
}
