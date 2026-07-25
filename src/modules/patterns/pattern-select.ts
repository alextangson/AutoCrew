/**
 * Pattern Select — 写稿组装前按相关性挑对标拆解卡（灵感收件箱设计 §3.5）。
 *
 * 相关性 = applicablePlatforms 含当前目标平台 AND themes 与选题文本有交集。
 * 「取最近 N 张」被否掉：不相关的卡进 prompt 就是污染写稿方向（codex 评审第 17 条）。
 * 无匹配返回空数组——调用方据此整槽省略，不注入空块。
 *
 * 错误纪律：patterns 目录/文件不存在是正常空态（store 内已按 ENOENT 返回 []）；
 * 其余读失败照抛，不在这里吞——静默降级会让「卡没生效」查无可查。
 */
import { listPatternCards, type PatternCard } from "./pattern-store.js";
import type { ClipboardPlatform } from "../publish/clipboard-publisher.js";

/** 上限 3 张：再多会挤掉写稿本身的上下文，也让模型在几套骨架之间摇摆 */
export const MAX_SCRIPT_PATTERNS = 3;

/** 反向匹配的最小重合长度：单字（「的」「a」）跟什么都能撞上，2 字起才算主题信号 */
const MIN_OVERLAP_CHARS = 2;

export interface PatternSelectQuery {
  /** 当前写稿的目标平台（输出平台枚举，不是拆解来源平台） */
  platform: ClipboardPlatform;
  /** 选题标题 + 角度拼成的自由文本 */
  topicText: string;
}

/** 比较口径与大小写、空白无关：「AI 工具」与「ai工具」视为同一串 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/**
 * 反向：选题里的词落在主题里（「副业」⊂「副业赚钱方法论」）。中文没有空格，
 * 只能扫主题的定长窗口回查选题——等价于「两串有 ≥2 字的共同子串」，
 * 不引词典、不做分词（§3.5 明示）。主题最长几个字，扫描代价可忽略。
 */
function sharesRun(themeNorm: string, topicNorm: string): boolean {
  for (let i = 0; i + MIN_OVERLAP_CHARS <= themeNorm.length; i++) {
    if (topicNorm.includes(themeNorm.slice(i, i + MIN_OVERLAP_CHARS))) return true;
  }
  return false;
}

/** 双向子串：主题整体出现在选题里（「内容创作」⊂「内容创作者选题」），或反向重合 */
function matchesTopic(themes: string[], topicNorm: string): boolean {
  return themes.some((theme) => {
    const t = normalize(theme);
    if (!t) return false;
    return topicNorm.includes(t) || sharesRun(t, topicNorm);
  });
}

/**
 * 选卡。已排墓碑、按 updatedAt 降序稳定排序（listPatternCards 的口径），截断到上限 3 张。
 */
export async function selectPatternsForScript(
  query: PatternSelectQuery,
  dataDir?: string,
): Promise<PatternCard[]> {
  const topicNorm = normalize(query.topicText);
  if (!topicNorm) return [];
  const cards = await listPatternCards({}, dataDir);
  return cards
    .filter(
      (card) =>
        (card.applicablePlatforms ?? []).includes(query.platform) &&
        matchesTopic(card.themes ?? [], topicNorm),
    )
    .slice(0, MAX_SCRIPT_PATTERNS);
}
