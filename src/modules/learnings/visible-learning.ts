/**
 * Visible Learning Loop — make the learning system transparent to users.
 *
 * Three components:
 * 1. Instant Feedback: After each edit, tell user what was learned
 * 2. Learning Report: After N contents, summarize learned rules
 * 3. Rule Injection: Before writing, show which rules are being applied
 *
 * This module generates human-readable messages, not raw data.
 */
import { listDiffs, detectPatterns, type EditDiff } from "../learnings/diff-tracker.js";
import { loadProfile, type WritingRule } from "../profile/creator-profile.js";
import { listContents } from "../../storage/local-store.js";

// --- Pattern descriptions for user-facing messages ---

const PATTERN_DESCRIPTIONS: Record<string, string> = {
  remove_progression_words: "你把「首先/其次/最后」改成了并列句式",
  break_long_paragraphs: "你把长段落拆成了短段落",
  remove_ai_phrases: "你删掉了 AI 味套话",
  add_colloquial_tone: "你加入了口语化表达",
  reduce_we_pronoun: "你把「我们」改成了「你」",
  shorten_content: "你精简了内容长度",
  add_emoji: "你增加了 emoji 使用",
  casualize_tone: "你把书面语换成了口语",
};

// --- 1. Instant Feedback ---

export interface EditFeedback {
  /** Whether any patterns were detected */
  hasPatterns: boolean;
  /** Human-readable feedback message */
  message: string;
  /** Detected patterns */
  patterns: string[];
}

/**
 * Generate instant feedback after a user edit.
 * Called after diff-tracker records a diff.
 *
 * 定位：初步观察（零延迟 UX）——用正则即时识别编辑模式，展示给用户看。
 * 这里的 patterns 不产生 WritingRule；规则的唯一来源是 LLM 蒸馏（autocrew_style action=distill）。
 */
export function generateEditFeedback(before: string, after: string): EditFeedback {
  const patterns = detectPatterns(before, after);

  if (patterns.length === 0) {
    return { hasPatterns: false, message: "", patterns: [] };
  }

  const descriptions = patterns
    .map(p => PATTERN_DESCRIPTIONS[p])
    .filter(Boolean);

  if (descriptions.length === 0) {
    return { hasPatterns: false, message: "", patterns };
  }

  const message = descriptions.length === 1
    ? `📝 我注意到${descriptions[0]}，我记住了，下次会这样写。`
    : `📝 我注意到你做了这些调整：\n${descriptions.map(d => `  - ${d}`).join("\n")}\n我都记住了，下次会应用这些偏好。`;

  return { hasPatterns: true, message, patterns };
}

// --- 2. Learning Report ---

export interface LearningReport {
  /** Total content count */
  contentCount: number;
  /** Total edit count */
  editCount: number;
  /** New rules learned since last report */
  newRules: WritingRule[];
  /** All current rules */
  allRules: WritingRule[];
  /** Pattern frequency summary */
  topPatterns: Array<{ pattern: string; description: string; count: number }>;
  /** Human-readable report */
  report: string;
}

/**
 * Generate a learning report.
 * Called after every 5 content items, or on demand.
 */
export async function generateLearningReport(dataDir?: string): Promise<LearningReport> {
  const [contents, diffs, profile] = await Promise.all([
    listContents(dataDir),
    listDiffs(undefined, dataDir),
    loadProfile(dataDir),
  ]);

  const allRules = profile?.writingRules || [];

  // Count pattern frequencies
  const freq = new Map<string, number>();
  for (const diff of diffs) {
    for (const p of diff.patterns) {
      freq.set(p, (freq.get(p) || 0) + 1);
    }
  }

  const topPatterns = Array.from(freq.entries())
    .map(([pattern, count]) => ({
      pattern,
      description: PATTERN_DESCRIPTIONS[pattern] || pattern,
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Build report
  const parts: string[] = [];
  parts.push(`📊 学习报告`);
  parts.push(`已写 ${contents.length} 篇内容，记录了 ${diffs.length} 次编辑\n`);

  if (allRules.length > 0) {
    parts.push(`已学到 ${allRules.length} 条写作规则：`);
    for (const rule of allRules) {
      const source = rule.source === "auto_distilled" ? "自动提炼" : "你明确告诉我的";
      parts.push(`  - ${rule.rule}（${source}，置信度 ${Math.round(rule.confidence * 100)}%）`);
    }
    parts.push("");
  }

  if (topPatterns.length > 0) {
    parts.push(`你最常做的编辑：`);
    for (const p of topPatterns) {
      parts.push(`  - ${p.description}（${p.count} 次）`);
    }
  }

  if (allRules.length === 0 && topPatterns.length === 0) {
    parts.push("还没有积累足够的编辑数据。多写几篇，我就能学到你的风格偏好了。");
  }

  return {
    contentCount: contents.length,
    editCount: diffs.length,
    newRules: allRules.filter(r => {
      // Rules created in the last 7 days
      const created = new Date(r.createdAt);
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      return created >= weekAgo;
    }),
    allRules,
    topPatterns,
    report: parts.join("\n"),
  };
}

// --- 3. Rule Injection ---

export interface RuleInjection {
  /** Rules being applied */
  rules: WritingRule[];
  /** Human-readable message for the user */
  message: string;
  /** Prompt text to inject into the writing LLM */
  promptInjection: string;
}

/**
 * Prepare rule injection for a writing session.
 * Called before write-script generates content.
 */
export async function prepareRuleInjection(dataDir?: string): Promise<RuleInjection> {
  const profile = await loadProfile(dataDir);
  const rules = profile?.writingRules || [];

  if (rules.length === 0) {
    return {
      rules: [],
      message: "",
      promptInjection: "",
    };
  }

  // Sort by confidence, take top rules (disabled rules never injected — PRD §7.3)
  const activeRules = rules
    .filter(r => !r.disabled && r.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);

  const message = `这篇我会应用你的 ${activeRules.length} 条写作偏好：\n${activeRules.map(r => `  - ${r.rule}`).join("\n")}`;

  const promptInjection = [
    "## 用户写作规则（必须严格遵守）",
    "",
    ...activeRules.map(r => `- ${r.rule}`),
    "",
    "以上规则来自用户的历史编辑偏好，优先级高于默认写作风格。",
  ].join("\n");

  return { rules: activeRules, message, promptInjection };
}

/**
 * Check if a learning report should be triggered.
 * Returns true every 5 content items.
 */
export async function shouldShowReport(dataDir?: string): Promise<boolean> {
  const contents = await listContents(dataDir);
  return contents.length > 0 && contents.length % 5 === 0;
}
