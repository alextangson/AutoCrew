/**
 * autocrew_review tool — content review integrating:
 * 1. Sensitive word scanning
 * 2. De-AI check (humanizer-zh dry-run)
 * 3. Quality scoring (info density, hook strength, CTA clarity, readability)
 * 4. Auto-fix (apply suggestions)
 *
 * PRD §6: "autocrew review 命令整合敏感词检测"
 */
import { Type } from "@sinclair/typebox";
import { scanText, type ScanResult } from "../modules/filter/sensitive-words.js";
import { humanizeZh, type HumanizeZhResult } from "../modules/humanizer/zh.js";
import { getContent, updateContent, transitionStatus, normalizeLegacyStatus } from "../storage/local-store.js";

// --- Types ---

export interface QualityScore {
  /** 0-100 overall */
  total: number;
  /** Sub-scores, each 0-25 */
  infoDensity: number;
  hookStrength: number;
  ctaClarity: number;
  readability: number;
  /** Per-dimension notes */
  notes: string[];
}

export interface ReviewReport {
  ok: boolean;
  /** Did the content pass all checks? */
  passed: boolean;
  sensitiveWords: ScanResult;
  aiCheck: { hasAiTraces: boolean; changeCount: number; changes: string[] };
  qualityScore: QualityScore;
  /** Combined summary */
  summary: string;
  /** Suggested fixes */
  fixes: string[];
  /** Auto-fixed text (if available) */
  autoFixedText?: string;
}

// --- Schema ---

export const reviewSchema = Type.Object({
  action: Type.Unsafe<"full_review" | "scan_only" | "quality_score" | "auto_fix">({
    type: "string",
    enum: ["full_review", "scan_only", "quality_score", "auto_fix"],
    description:
      "Action: 'full_review' runs all checks, 'scan_only' runs sensitive word scan only, " +
      "'quality_score' returns quality score only, 'auto_fix' applies all auto-fixable suggestions and saves.",
  }),
  content_id: Type.Optional(Type.String({ description: "AutoCrew content id to review." })),
  text: Type.Optional(Type.String({ description: "Raw text to review directly (if no content_id)." })),
  platform: Type.Optional(Type.String({ description: "Target platform for platform-specific checks." })),
});

// --- Quality Scoring ---

function scoreQuality(text: string, platform?: string): QualityScore {
  const notes: string[] = [];

  // --- Info Density (0-25) ---
  // Penalize filler, reward concrete data points
  const charCount = text.length;
  const sentences = text.split(/[。！？\n]/).filter((s) => s.trim().length > 0);
  const avgSentenceLen = charCount / Math.max(sentences.length, 1);
  const dataPoints = (text.match(/\d+[%％万亿个条次天月年]/g) || []).length;
  let infoDensity = 15; // baseline
  if (dataPoints >= 3) infoDensity += 5;
  else if (dataPoints >= 1) infoDensity += 2;
  if (avgSentenceLen > 80) {
    infoDensity -= 5;
    notes.push("句子偏长，建议拆分");
  }
  if (avgSentenceLen < 15 && sentences.length > 3) {
    infoDensity += 3;
  }
  // Penalize filler phrases
  const fillerCount = (text.match(/值得一提|需要注意|综上所述|总而言之|可以说/g) || []).length;
  if (fillerCount > 0) {
    infoDensity -= Math.min(5, fillerCount * 2);
    notes.push(`发现 ${fillerCount} 处套话，建议删除`);
  }
  infoDensity = clamp(infoDensity, 0, 25);

  // --- Hook Strength (0-25) ---
  const firstLine = sentences[0]?.trim() || "";
  let hookStrength = 10;
  // Question hook
  if (/[？?]/.test(firstLine)) {
    hookStrength += 5;
    notes.push("开头用了提问式 hook ✓");
  }
  // Number hook
  if (/\d/.test(firstLine)) {
    hookStrength += 4;
  }
  // Emotional trigger
  if (/别再|千万|后悔|真相|没想到|居然|竟然|震惊|绝了/.test(firstLine)) {
    hookStrength += 5;
  }
  // Short punchy opening
  if (firstLine.length <= 20 && firstLine.length > 0) {
    hookStrength += 3;
  }
  // Penalty: generic opening
  if (/大家好|今天我们|在当今社会|随着.*的发展/.test(firstLine)) {
    hookStrength -= 8;
    notes.push("开头太泛，建议用具体场景或数据切入");
  }
  hookStrength = clamp(hookStrength, 0, 25);

  // --- CTA Clarity (0-25) ---
  const lastThird = text.slice(Math.floor(text.length * 0.7));
  let ctaClarity = 10;
  // Explicit CTA
  if (/关注|收藏|点赞|转发|评论|私信|留言|试试|赶紧|快去/.test(lastThird)) {
    ctaClarity += 8;
    notes.push("结尾有明确 CTA ✓");
  }
  // Question CTA
  if (/[？?]/.test(lastThird)) {
    ctaClarity += 4;
  }
  // No CTA at all
  if (ctaClarity === 10) {
    notes.push("结尾缺少 CTA，建议加引导互动的句子");
  }
  // Platform-specific CTA
  if (platform === "xhs" || platform === "xiaohongshu") {
    if (/收藏|关注/.test(lastThird)) ctaClarity += 3;
  }
  if (platform === "douyin") {
    if (/关注|点赞/.test(lastThird)) ctaClarity += 3;
  }
  ctaClarity = clamp(ctaClarity, 0, 25);

  // --- Readability (0-25) ---
  let readability = 15;
  // Paragraph count
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  if (paragraphs.length >= 3 && paragraphs.length <= 8) {
    readability += 3;
  }
  // Emoji usage
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount >= 1 && emojiCount <= 10) {
    readability += 3;
  } else if (emojiCount > 15) {
    readability -= 3;
    notes.push("emoji 过多，建议精简");
  }
  // Line breaks
  if (paragraphs.some((p) => p.length > 300)) {
    readability -= 5;
    notes.push("有段落超过 300 字，建议拆分");
  }
  // Short paragraphs bonus
  const shortParas = paragraphs.filter((p) => p.length <= 100).length;
  if (shortParas / Math.max(paragraphs.length, 1) > 0.5) {
    readability += 4;
  }
  readability = clamp(readability, 0, 25);

  const total = infoDensity + hookStrength + ctaClarity + readability;

  return { total, infoDensity, hookStrength, ctaClarity, readability, notes };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// --- Execute ---

export async function executeReview(params: Record<string, unknown>) {
  const action = (params.action as string) || "full_review";
  const dataDir = (params._dataDir as string) || undefined;
  const platform = (params.platform as string) || undefined;
  const contentId = params.content_id as string | undefined;

  // Resolve text
  let text = (params.text as string) || "";
  let title = "";
  if (!text && contentId) {
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, error: `Content ${contentId} not found` };
    text = content.body;
    title = content.title;
  }
  if (!text) return { ok: false, error: "text or content_id is required" };

  const fullText = title ? `${title}\n\n${text}` : text;

  // --- scan_only ---
  if (action === "scan_only") {
    const scanResult = await scanText(fullText, platform, dataDir);
    return { ok: true, action, sensitiveWords: scanResult };
  }

  // --- quality_score ---
  if (action === "quality_score") {
    const score = scoreQuality(fullText, platform);
    return { ok: true, action, qualityScore: score };
  }

  // --- auto_fix ---
  if (action === "auto_fix") {
    // 1. Sensitive word auto-fix
    const scanResult = await scanText(fullText, platform, dataDir);
    let fixedText = scanResult.autoFixedText || fullText;

    // 2. Humanizer pass
    const humanResult = humanizeZh({ text: fixedText });
    fixedText = humanResult.humanizedText;

    // Save back if content_id provided
    if (contentId) {
      await updateContent(contentId, { body: fixedText }, dataDir);
    }

    return {
      ok: true,
      action,
      autoFixedText: fixedText,
      sensitiveWordsFixed: scanResult.hits.filter((h) => h.suggestion).length,
      aiFixesApplied: humanResult.changeCount,
      saved: !!contentId,
    };
  }

  // --- full_review ---
  // 1. Sensitive words
  const sensitiveWords = await scanText(fullText, platform, dataDir);

  // 2. AI check (dry-run humanizer)
  const humanResult = humanizeZh({ text: fullText });
  const aiCheck = {
    hasAiTraces: humanResult.changeCount > 0,
    changeCount: humanResult.changeCount,
    changes: humanResult.changes,
  };

  // 3. Quality score
  const qualityScore = scoreQuality(fullText, platform);

  // 4. Build fixes list
  const fixes: string[] = [];
  if (sensitiveWords.hitCount > 0) {
    fixes.push(`修复 ${sensitiveWords.hitCount} 个敏感词`);
    for (const hit of sensitiveWords.hits.slice(0, 10)) {
      const fix = hit.suggestion ? `"${hit.word}" → "${hit.suggestion}"` : `删除"${hit.word}"`;
      // Show surrounding context for each hit
      const pos = hit.positions[0];
      const contextStart = Math.max(0, pos - 10);
      const contextEnd = Math.min(fullText.length, pos + hit.word.length + 10);
      const context = fullText.slice(contextStart, contextEnd).replace(/\n/g, " ");
      fixes.push(`  - ${fix} (${hit.category}) — "...${context}..."`);
    }
  }
  if (aiCheck.hasAiTraces) {
    fixes.push(`去 AI 味：${aiCheck.changeCount} 处需要修改`);
    for (const change of aiCheck.changes.slice(0, 5)) {
      fixes.push(`  - ${change}`);
    }
  }
  for (const note of qualityScore.notes) {
    fixes.push(note);
  }

  // 5. Determine pass/fail
  const passed =
    sensitiveWords.hitCount === 0 &&
    !aiCheck.hasAiTraces &&
    qualityScore.total >= 60;

  // 6. Build summary
  const parts: string[] = [];
  parts.push(passed ? "✅ 审核通过" : "⚠️ 审核未通过");
  parts.push(`敏感词: ${sensitiveWords.hitCount === 0 ? "✓ 无" : `✗ ${sensitiveWords.hitCount} 个`}`);
  parts.push(`AI 痕迹: ${aiCheck.hasAiTraces ? `✗ ${aiCheck.changeCount} 处` : "✓ 无"}`);
  parts.push(`质量评分: ${qualityScore.total}/100 (信息密度${qualityScore.infoDensity} Hook${qualityScore.hookStrength} CTA${qualityScore.ctaClarity} 可读性${qualityScore.readability})`);
  const summary = parts.join("\n");

  // 7. Auto-transition if content_id provided
  if (contentId) {
    const targetStatus = passed ? "approved" : "revision";
    const diffNote = passed ? undefined : fixes.join("; ");
    await transitionStatus(
      contentId,
      normalizeLegacyStatus(targetStatus),
      { diffNote },
      dataDir,
    ).catch(() => {
      /* transition may fail if not in reviewing state — that's ok */
    });
  }

  const report: ReviewReport = {
    ok: true,
    passed,
    sensitiveWords,
    aiCheck,
    qualityScore,
    summary,
    fixes,
    autoFixedText: sensitiveWords.autoFixedText,
  };

  return report;
}
