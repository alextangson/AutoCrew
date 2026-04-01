/**
 * Rule Distiller — automatically extracts writing rules from accumulated edit patterns
 *
 * When a pattern appears 5+ times in user edits, it gets distilled into a
 * WritingRule and written to creator-profile.json.
 *
 * PRD §7: "累积 5+ 次同类修改后，自动提炼为规则"
 */
import { getPatternFrequency } from "./diff-tracker.js";
import {
  loadProfile,
  addWritingRule,
  type WritingRule,
} from "../profile/creator-profile.js";

export interface DistillResult {
  /** Number of new rules distilled this run */
  newRulesCount: number;
  /** The new rules that were added */
  newRules: WritingRule[];
  /** Patterns that are close to threshold (3-4 occurrences) */
  emerging: Array<{ pattern: string; count: number; remaining: number }>;
  /** Summary for display */
  summary: string;
}

/** Minimum occurrences before a pattern becomes a rule */
const DISTILL_THRESHOLD = 5;

/** Map pattern IDs to human-readable rule descriptions */
const PATTERN_TO_RULE: Record<string, string> = {
  remove_progression_words: "禁用顺序词（首先/其次/最后/第一/第二/第三）",
  break_long_paragraphs: "长段落拆分为短段落，每段不超过 3-4 行",
  remove_ai_phrases: "删除 AI 味套话（值得一提、综上所述、赋能、闭环等）",
  add_colloquial_tone: "适当加入口语化表达（说白了、讲真、你想啊）",
  reduce_we_pronoun: '减少"我们"开头，多用"你"拉近距离',
  shorten_content: "精简内容，删除冗余信息",
  add_emoji: "适当使用 emoji 增加可读性",
  casualize_tone: "用口语化词汇替代书面语（因此→所以，然而→但是）",
};

/**
 * Run the distillation process:
 * 1. Get pattern frequencies from diff tracker
 * 2. Check which patterns have reached the threshold
 * 3. Skip patterns that already have corresponding rules
 * 4. Add new rules to creator-profile.json
 */
export async function distillRules(dataDir?: string): Promise<DistillResult> {
  const frequencies = await getPatternFrequency(dataDir);
  const profile = await loadProfile(dataDir);
  const existingRules = profile?.writingRules || [];

  const newRules: WritingRule[] = [];
  const emerging: DistillResult["emerging"] = [];

  for (const { pattern, count } of frequencies) {
    const ruleText = PATTERN_TO_RULE[pattern];
    if (!ruleText) continue; // Unknown pattern, skip

    // Check if rule already exists
    const alreadyExists = existingRules.some(
      (r) => r.rule === ruleText || r.rule.includes(pattern),
    );
    if (alreadyExists) continue;

    if (count >= DISTILL_THRESHOLD) {
      // Distill into a rule
      const confidence = Math.min(0.95, 0.5 + count * 0.05);
      const rule = await addWritingRule(
        { rule: ruleText, source: "auto_distilled", confidence },
        dataDir,
      );
      const addedRule = rule.writingRules[rule.writingRules.length - 1];
      newRules.push(addedRule);
    } else if (count >= 3) {
      // Emerging pattern — close to threshold
      emerging.push({
        pattern,
        count,
        remaining: DISTILL_THRESHOLD - count,
      });
    }
  }

  const summary = buildSummary(newRules, emerging);
  return {
    newRulesCount: newRules.length,
    newRules,
    emerging,
    summary,
  };
}

/**
 * Check if distillation should run (called after each content edit).
 * Returns true if there are patterns at or above threshold that haven't been distilled.
 */
export async function shouldDistill(dataDir?: string): Promise<boolean> {
  const frequencies = await getPatternFrequency(dataDir);
  const profile = await loadProfile(dataDir);
  const existingRules = profile?.writingRules || [];

  for (const { pattern, count } of frequencies) {
    if (count < DISTILL_THRESHOLD) continue;
    const ruleText = PATTERN_TO_RULE[pattern];
    if (!ruleText) continue;
    const alreadyExists = existingRules.some(
      (r) => r.rule === ruleText || r.rule.includes(pattern),
    );
    if (!alreadyExists) return true;
  }
  return false;
}

function buildSummary(
  newRules: WritingRule[],
  emerging: DistillResult["emerging"],
): string {
  const parts: string[] = [];

  if (newRules.length > 0) {
    parts.push(`🎯 提炼了 ${newRules.length} 条新规则：`);
    for (const r of newRules) {
      parts.push(`  - ${r.rule}（置信度 ${r.confidence}）`);
    }
  }

  if (emerging.length > 0) {
    parts.push(`📊 接近提炼阈值的模式：`);
    for (const e of emerging) {
      parts.push(`  - ${PATTERN_TO_RULE[e.pattern] || e.pattern}（还差 ${e.remaining} 次）`);
    }
  }

  if (parts.length === 0) {
    return "暂无可提炼的规则";
  }

  return parts.join("\n");
}
