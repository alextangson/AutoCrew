import { ALL_VIDEO_PLATFORMS, PLATFORM_CAPS, type PlatformId } from "../platform-caps.js";

/**
 * 平台名词表（发布前把关 spec §4）：原话 / 指令里点名的平台按这张表认（含中英文别名），代码匹配，不问模型。
 * 平台清单、中文名与别名都来自平台能力表（platform-caps）。
 */
export const GATE_PLATFORMS = ALL_VIDEO_PLATFORMS;
export type GatePlatform = PlatformId;

export const PLATFORM_LABEL = Object.fromEntries(GATE_PLATFORMS.map((p) => [p, PLATFORM_CAPS[p].label])) as Record<GatePlatform, string>;

/** 精确认名的别名（小写比较） */
const ALIASES: Array<[string, GatePlatform]> = GATE_PLATFORMS.flatMap((p) => PLATFORM_CAPS[p].aliases.map((a): [string, GatePlatform] => [a, p]));
/** 在一段话里按子串认的别名：单字母的「x」不在里面，否则任何带 x 的词都会点名 X */
const TEXT_ALIASES: Array<[string, GatePlatform]> = GATE_PLATFORMS.flatMap((p) => PLATFORM_CAPS[p].textAliases.map((a): [string, GatePlatform] => [a, p]));

/** 计划里的平台值 → 规范名；认不出返回 null */
export function normalizePlatform(raw: unknown): GatePlatform | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return ALIASES.find(([alias]) => alias === v)?.[1] ?? null;
}

/** 一段文字里点名的平台（去重、按首次出现排序） */
export function platformsNamedIn(text: string): GatePlatform[] {
  const lower = text.toLowerCase();
  const hits: Array<[number, GatePlatform]> = [];
  for (const [alias, p] of TEXT_ALIASES) {
    const at = lower.indexOf(alias);
    if (at >= 0 && !hits.some(([, q]) => q === p)) hits.push([at, p]);
  }
  return hits.sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

export function platformLabel(p: string): string {
  return PLATFORM_LABEL[p as GatePlatform] ?? p;
}
