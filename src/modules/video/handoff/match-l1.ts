/**
 * 认稿 L1：文件名比标题（P6 §12.4-B，codex 评审 #12）。
 *
 * 归一化写死：NFKC（顺带全角转半角）、小写、去扩展名，只去掉已识别的**拍摄尾缀**
 * （aroll / a-roll / a roll / 口播 / 原片 / take N / 第 N 条 / 8 位日期），标题里有语义的数字
 * （「GPT-5」「第 12 期」）不动。比较时只看字母和数字，标点空白不投票。
 *
 * 强命中只认**当前标题全文**（含「｜」后的副标题）。短标题（<6 字）、只对上系列前缀、
 * 多条同时强命中都降成弱命中，交给 L2；历史标题、选题标题对上只算提示，并标「可能录的是旧版」。
 */

export type L1Kind = "strong" | "weak" | "none";

export interface L1Hit {
  kind: L1Kind;
  /** strong 1；weak 0.5；none 0 */
  score: number;
  reason?: "current_title" | "short_title" | "series_prefix" | "partial_title" | "old_title" | "multiple_hits";
  possibly_old_version?: boolean;
}

export interface L1Subject {
  title: string;
  /** 历史标题（版本记录里的旧标题）与选题标题 */
  oldTitles: string[];
}

export const MIN_STRONG_TITLE_CHARS = 6;

const EXT = /\.[a-z0-9]{1,5}$/;
const SEP = "[\\s_\\-.·,，、()（）\\[\\]【】]*";
const SUFFIXES = [
  "(?<![a-z0-9])a[\\s_-]?roll",
  "口播",
  "原片",
  "(?<![a-z0-9])take[\\s_-]?\\d+",
  "第\\s*\\d+\\s*条",
  "(?<!\\d)\\d{8}",
];
const TRAILING = new RegExp(`${SEP}(?:${SUFFIXES.join("|")})${SEP}$`, "u");

/** 文件名 → 去掉扩展名和拍摄尾缀后的名字（还保留原字符） */
export function stripRecordingSuffixes(fileName: string): string {
  let s = fileName.normalize("NFKC").toLowerCase().replace(EXT, "");
  for (let i = 0; i < 8; i++) {
    const next = s.replace(TRAILING, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

/** 比较键：只留字母与数字 */
export function compareKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function mainTitle(title: string): string {
  return title.normalize("NFKC").split(/[｜|]/)[0] ?? title;
}

function single(fileKey: string, subject: L1Subject): L1Hit {
  const full = compareKey(subject.title);
  const main = compareKey(mainTitle(subject.title));
  if (fileKey && fileKey === full) {
    return [...full].length >= MIN_STRONG_TITLE_CHARS
      ? { kind: "strong", score: 1, reason: "current_title" }
      : { kind: "weak", score: 0.5, reason: "short_title" };
  }
  if (fileKey && main !== full && fileKey === main) return { kind: "weak", score: 0.5, reason: "series_prefix" };
  if (fileKey && subject.oldTitles.some((t) => compareKey(t) === fileKey)) {
    return { kind: "weak", score: 0.5, reason: "old_title", possibly_old_version: true };
  }
  if ([...fileKey].length >= 2 && full.length >= 2 && (full.includes(fileKey) || fileKey.includes(full))) {
    return { kind: "weak", score: 0.5, reason: "partial_title" };
  }
  return { kind: "none", score: 0 };
}

/** 对整组候选打 L1；多于一条强命中 → 全部降成弱命中（进 L2） */
export function matchL1(fileName: string, subjects: readonly L1Subject[]): L1Hit[] {
  const fileKey = compareKey(stripRecordingSuffixes(fileName));
  const hits = subjects.map((s) => single(fileKey, s));
  const strong = hits.filter((h) => h.kind === "strong").length;
  if (strong <= 1) return hits;
  return hits.map((h) => (h.kind === "strong" ? { kind: "weak", score: 0.5, reason: "multiple_hits" } : h));
}
