/**
 * Legacy review entry: deterministic word-list and reading-format diagnostics.
 * Semantic quality, factual correctness and creator approval require separate review.
 */
import { Type } from "@sinclair/typebox";
import { scanText, type ScanResult } from "../modules/filter/sensitive-words.js";
import { humanizeZh } from "../modules/humanizer/zh.js";
import { getContent, updateContent } from "../storage/local-store.js";
import { aiContentWriteRefusal } from "../modules/research/angle-gate.js";
import { isModelCall } from "../storage/stage-guard.js";

const REVIEW_SCOPE = {
  quality_status: "mechanical_checks_only",
  semantic_review: false,
} as const;

export interface QualityScore {
  /** Legacy name retained; 0–100 reading-format reference only, never a quality gate. */
  total: number;
  metric: "readability_only";
  /** These dimensions cannot be inferred with a word-count heuristic. */
  infoDensity: null;
  hookStrength: null;
  ctaClarity: null;
  /** Reading-format reference, 0–25. */
  readability: number;
  notes: string[];
}

export type ReviewReport = {
  ok: boolean;
  /** Only the deterministic word-list check; not semantic approval. */
  passed: boolean;
  quality_status: "mechanical_checks_only";
  semantic_review: false;
  sensitiveWords: ScanResult;
  aiCheck: { assessed: false; hasAiTraces: null; changeCount: 0; changes: string[]; note: string };
  formatting: { changeCount: number; changes: string[] };
  qualityScore: QualityScore;
  summary: string;
  fixes: string[];
  suggestions: string[];
  autoFixedText?: string;
};

export const reviewSchema = Type.Object({
  action: Type.Unsafe<"full_review" | "scan_only" | "quality_score" | "auto_fix">({
    type: "string",
    enum: ["full_review", "scan_only", "quality_score", "auto_fix"],
    description:
      "Read-only mechanical diagnostics: 'full_review' scans sensitive words and reading format; " +
      "'scan_only' scans words; 'quality_score' reports reading format only. These do not perform semantic review or approve content. " +
      "'auto_fix' only normalizes whitespace and saves; wording suggestions are never applied automatically.",
  }),
  content_id: Type.Optional(Type.String({ description: "AutoCrew content id to inspect." })),
  text: Type.Optional(Type.String({ description: "Raw text to inspect directly (if no content_id)." })),
  platform: Type.Optional(Type.String({ description: "Target platform for platform-specific word-list checks." })),
});

/** Formatting observations cannot grade the thesis, opening or ending. */
function scoreReadability(text: string): QualityScore {
  const notes: string[] = [];
  const sentences = text.split(/[。！？\n]/).filter((sentence) => sentence.trim().length > 0);
  const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim());
  let readability = 25;
  if (text.length / Math.max(sentences.length, 1) > 80) {
    readability -= 5;
    notes.push("平均句长超过 80 字，可检查是否需要拆分；按文体和创作者要求判断。");
  }
  if (paragraphs.some((paragraph) => paragraph.length > 300)) {
    readability -= 5;
    notes.push("有段落超过 300 字，可检查阅读负担；这不代表内容质量未通过。");
  }
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 15) {
    readability -= 3;
    notes.push("表情符号较多，可按目标平台检查是否干扰阅读。");
  }
  return {
    total: readability * 4,
    metric: "readability_only",
    infoDensity: null,
    hookStrength: null,
    ctaClarity: null,
    readability,
    notes,
  };
}

export async function executeReview(params: Record<string, unknown>) {
  const action = (params.action as string) || "full_review";
  const dataDir = (params._dataDir as string) || undefined;
  const platform = (params.platform as string) || undefined;
  const contentId = params.content_id as string | undefined;
  if (!["full_review", "scan_only", "quality_score", "auto_fix"].includes(action)) {
    return { ok: false, ...REVIEW_SCOPE, error: `Unsupported review action: ${action}` };
  }

  let text = (params.text as string) || "";
  let title = "";
  if (!text && contentId) {
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, ...REVIEW_SCOPE, error: `Content ${contentId} not found` };
    text = content.body;
    title = content.title;
  }
  if (!text) return { ok: false, ...REVIEW_SCOPE, error: "text or content_id is required" };
  const fullText = title ? `${title}\n\n${text}` : text;

  if (action === "scan_only") {
    const sensitiveWords = await scanText(fullText, platform, dataDir);
    return { ok: true, action, ...REVIEW_SCOPE, sensitiveWords, summary: "仅完成词表扫描，尚未评估事实、表达质量或创作者规划。" };
  }

  if (action === "quality_score") {
    return {
      ok: true,
      action,
      ...REVIEW_SCOPE,
      qualityScore: scoreReadability(fullText),
      summary: "仅提供阅读格式参考分；不评价立意、信息密度或开头结尾，不作为审稿通过依据。",
    };
  }

  if (action === "auto_fix") {
    const scanResult = await scanText(fullText, platform, dataDir);
    // Only normalize the body. The title participates in scans, never gets copied into body.
    const humanResult = humanizeZh({ text });
    const fixedText = humanResult.humanizedText;
    if (contentId && fixedText !== text) {
      const refused = isModelCall(params) ? await aiContentWriteRefusal(contentId, dataDir) : null;
      if (refused) return refused;
      await updateContent(contentId, { body: fixedText }, dataDir);
    }
    return {
      ok: true,
      action,
      ...REVIEW_SCOPE,
      autoFixedText: fixedText,
      sensitiveWordsFixed: 0,
      unfixedSensitiveWords: scanResult.hits.map((hit) => hit.word),
      sensitiveWords: scanResult,
      aiFixesApplied: 0,
      formatFixesApplied: humanResult.changeCount,
      suggestions: humanResult.suggestions,
      saved: Boolean(contentId),
      summary: "仅清理正文空白和换行，未自动改人称、术语或敏感词。词表命中和表达建议需结合语境核对，尚未进行语义审稿。",
    };
  }

  const sensitiveWords = await scanText(fullText, platform, dataDir);
  const humanResult = humanizeZh({ text: fullText });
  const qualityScore = scoreReadability(fullText);
  const fixes = sensitiveWords.hits.map((hit) =>
    `核对词表命中「${hit.word}」${hit.suggestion ? `（可参考替代表达「${hit.suggestion}」，未自动应用）` : "（需结合上下文判断）"}`,
  );
  if (humanResult.changeCount > 0) fixes.push("可清理首尾或行尾空白；空白变化不代表 AI 痕迹。");
  fixes.push(...qualityScore.notes);
  const passed = sensitiveWords.hitCount === 0;
  const report: ReviewReport = {
    ok: true,
    passed,
    ...REVIEW_SCOPE,
    sensitiveWords,
    aiCheck: {
      assessed: false,
      hasAiTraces: null,
      changeCount: 0,
      changes: [],
      note: "未评估 AI 痕迹；词表和空白规则不能判断文本作者或自然程度。",
    },
    formatting: { changeCount: humanResult.changeCount, changes: humanResult.changes },
    qualityScore,
    summary: [
      passed ? "机械检查未发现词表命中。" : `机械检查发现 ${sensitiveWords.hitCount} 项词表命中，需核对。`,
      `阅读格式参考分：${qualityScore.total}/100，仅供排版与句长检查。`,
      "尚未进行事实、立意、表达自然度或规划遵循的语义审稿；未更改稿件状态，不代表创作者认可。",
    ].join("\n"),
    fixes,
    suggestions: humanResult.suggestions,
    autoFixedText: humanResult.humanizedText,
  };
  return report;
}
