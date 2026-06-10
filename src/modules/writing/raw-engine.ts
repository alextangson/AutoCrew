/**
 * RAW Engine — Research-Augmented Writing
 *
 * Enhances content quality by:
 * 1. Gathering research context (search results, competitor patterns)
 * 2. Generating a structured outline
 * 3. Injecting real data points, examples, and quotes into writing
 * 4. Applying style transfer (not just regex de-AI)
 */
import { loadProfile, type CreatorProfile, type WritingRule } from "../profile/creator-profile.js";

export interface ResearchContext {
  /** Key data points extracted from research */
  dataPoints: string[];
  /** Structural patterns observed (hook types, CTA styles) */
  structuralPatterns: string[];
  /** Quotable insights or examples */
  examples: string[];
  /** Source URLs for attribution */
  sources: string[];
}

export interface ContentOutline {
  /** Hook type and draft text */
  hook: { type: string; draft: string };
  /** Body sections with key points */
  sections: Array<{ heading: string; keyPoint: string; supportingData?: string }>;
  /** CTA approach */
  cta: { style: string; draft: string };
  /** Estimated word count */
  estimatedLength: number;
}

export interface RAWContext {
  /** Research material gathered */
  research: ResearchContext;
  /** Generated outline */
  outline: ContentOutline;
  /** Writing rules from profile */
  writingRules: WritingRule[];
  /** Style notes from STYLE.md */
  styleNotes: string;
  /** Platform-specific constraints */
  platformConstraints: PlatformConstraints;
}

export interface PlatformConstraints {
  platform: string;
  minChars: number;
  maxChars: number;
  hashtagCount: { min: number; max: number };
  emojiUsage: "encouraged" | "moderate" | "minimal";
  structureNotes: string;
}

const PLATFORM_CONSTRAINTS: Record<string, PlatformConstraints> = {
  xiaohongshu: {
    platform: "xiaohongshu",
    minChars: 300,
    maxChars: 1000,
    hashtagCount: { min: 5, max: 15 },
    emojiUsage: "encouraged",
    structureNotes: "短段落，emoji 辅助阅读，hashtag 放末尾",
  },
  douyin: {
    platform: "douyin",
    minChars: 100,
    maxChars: 300,
    hashtagCount: { min: 3, max: 5 },
    emojiUsage: "moderate",
    structureNotes: "极短文案，前 3 秒是 hook，口语化",
  },
  wechat_mp: {
    platform: "wechat_mp",
    minChars: 1500,
    maxChars: 3000,
    hashtagCount: { min: 0, max: 0 },
    emojiUsage: "minimal",
    structureNotes: "每 300-500 字加小标题，结构化长文",
  },
  wechat_video: {
    platform: "wechat_video",
    minChars: 300,
    maxChars: 800,
    hashtagCount: { min: 3, max: 8 },
    emojiUsage: "moderate",
    structureNotes: "教育类内容，加文字摘要",
  },
  bilibili: {
    platform: "bilibili",
    minChars: 500,
    maxChars: 2000,
    hashtagCount: { min: 3, max: 8 },
    emojiUsage: "moderate",
    structureNotes: "年轻化表达，可以用梗，【】标注类型",
  },
};

/**
 * Get platform constraints for writing.
 */
export function getPlatformConstraints(platform?: string): PlatformConstraints {
  return PLATFORM_CONSTRAINTS[platform || "xiaohongshu"] || PLATFORM_CONSTRAINTS.xiaohongshu;
}

/**
 * Build research context from search results.
 * This processes raw search results into structured research material.
 */
export function buildResearchContext(searchResults: Array<{ title: string; snippet: string; url: string }>): ResearchContext {
  const dataPoints: string[] = [];
  const structuralPatterns: string[] = [];
  const examples: string[] = [];
  const sources: string[] = [];

  for (const result of searchResults) {
    sources.push(result.url);

    // Extract data points (numbers, percentages, statistics)
    const numbers = result.snippet.match(/\d+[%％万亿个条次天月年元块]/g);
    if (numbers) {
      for (const n of numbers) {
        const context = extractContext(result.snippet, n);
        if (context) dataPoints.push(context);
      }
    }

    // Extract examples (sentences with specific scenarios)
    const sentences = result.snippet.split(/[。！？]/).filter(s => s.trim().length > 10);
    for (const s of sentences) {
      if (/比如|例如|举个例子|案例|实测|亲测/.test(s)) {
        examples.push(s.trim());
      }
    }

    // Detect structural patterns from titles
    if (/\d+[个条种招步]/.test(result.title)) {
      structuralPatterns.push("listicle");
    }
    if (/如何|怎么|怎样/.test(result.title)) {
      structuralPatterns.push("how-to");
    }
    if (/为什么|真相|揭秘/.test(result.title)) {
      structuralPatterns.push("myth-busting");
    }
    if (/对比|vs|PK/.test(result.title)) {
      structuralPatterns.push("comparison");
    }
  }

  return {
    dataPoints: [...new Set(dataPoints)].slice(0, 10),
    structuralPatterns: [...new Set(structuralPatterns)],
    examples: [...new Set(examples)].slice(0, 5),
    sources: [...new Set(sources)].slice(0, 5),
  };
}

function extractContext(text: string, match: string): string | null {
  const idx = text.indexOf(match);
  if (idx === -1) return null;
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + match.length + 20);
  return text.slice(start, end).trim();
}

/**
 * Generate a content outline based on research context and topic.
 */
export function generateOutline(
  topic: string,
  research: ResearchContext,
  platform: string,
): ContentOutline {
  const constraints = getPlatformConstraints(platform);

  // Determine best hook type based on research patterns
  let hookType = "pain_point";
  if (research.structuralPatterns.includes("myth-busting")) hookType = "contrast";
  if (research.structuralPatterns.includes("listicle")) hookType = "ideal_state";
  if (research.dataPoints.length >= 3) hookType = "suspense";

  const hookDrafts: Record<string, string> = {
    pain_point: `关于${topic}，90%的人都踩过这个坑`,
    contrast: `你以为的${topic} vs 真实的${topic}`,
    ideal_state: `掌握这几点，${topic}不再是难题`,
    suspense: `${topic}的真相，可能和你想的不一样`,
  };

  // Build sections from research
  const sections: ContentOutline["sections"] = [];
  const sectionCount = platform === "douyin" ? 3 : platform === "wechat_mp" ? 6 : 4;

  for (let i = 0; i < sectionCount; i++) {
    sections.push({
      heading: `要点 ${i + 1}`,
      keyPoint: research.dataPoints[i] || `关于${topic}的关键洞察 ${i + 1}`,
      supportingData: research.examples[i] || undefined,
    });
  }

  // CTA style
  const ctaStyles: Record<string, string> = {
    xiaohongshu: "收藏型",
    douyin: "互动型",
    wechat_mp: "关注型",
    wechat_video: "分享型",
    bilibili: "三连型",
  };

  return {
    hook: { type: hookType, draft: hookDrafts[hookType] || hookDrafts.pain_point },
    sections,
    cta: {
      style: ctaStyles[platform] || "收藏型",
      draft: `觉得有用就${platform === "bilibili" ? "三连" : "收藏"}，下次用得上`,
    },
    estimatedLength: Math.round((constraints.minChars + constraints.maxChars) / 2),
  };
}

/**
 * Build the full RAW context for the writing skill.
 * This is the main entry point — called before writing begins.
 */
export async function buildRAWContext(params: {
  topic: string;
  platform?: string;
  searchResults?: Array<{ title: string; snippet: string; url: string }>;
  dataDir?: string;
}): Promise<RAWContext> {
  const { topic, platform = "xiaohongshu", searchResults = [], dataDir } = params;

  // 1. Build research context
  const research = buildResearchContext(searchResults);

  // 2. Generate outline
  const outline = generateOutline(topic, research, platform);

  // 3. Load writing rules from profile
  const profile = await loadProfile(dataDir);
  const writingRules = profile?.writingRules || [];

  // 4. Load style notes
  let styleNotes = "";
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const home = process.env.HOME || process.env.USERPROFILE || "~";
    const stylePath = path.join(dataDir || path.join(home, ".autocrew"), "STYLE.md");
    styleNotes = await fs.readFile(stylePath, "utf-8");
  } catch {
    styleNotes = "尚未校准风格，使用通用风格";
  }

  // 5. Get platform constraints
  const platformConstraints = getPlatformConstraints(platform);

  return {
    research,
    outline,
    writingRules,
    styleNotes,
    platformConstraints,
  };
}

/**
 * Format RAW context as a prompt injection for the writing LLM.
 * This is what gets prepended to the write-script prompt.
 */
export function formatRAWPrompt(ctx: RAWContext): string {
  const parts: string[] = [];

  // Research material
  if (ctx.research.dataPoints.length > 0 || ctx.research.examples.length > 0) {
    parts.push("## 调研素材（写作时引用）\n");
    if (ctx.research.dataPoints.length > 0) {
      parts.push("数据点：");
      for (const dp of ctx.research.dataPoints) {
        parts.push(`- ${dp}`);
      }
    }
    if (ctx.research.examples.length > 0) {
      parts.push("\n案例/实例：");
      for (const ex of ctx.research.examples) {
        parts.push(`- ${ex}`);
      }
    }
    parts.push("");
  }

  // Outline
  parts.push("## 内容大纲\n");
  parts.push(`Hook（${ctx.outline.hook.type}）：${ctx.outline.hook.draft}`);
  parts.push("");
  for (const section of ctx.outline.sections) {
    const data = section.supportingData ? ` — 佐证：${section.supportingData}` : "";
    parts.push(`- ${section.heading}：${section.keyPoint}${data}`);
  }
  parts.push("");
  parts.push(`CTA（${ctx.outline.cta.style}）：${ctx.outline.cta.draft}`);
  parts.push("");

  // Writing rules
  if (ctx.writingRules.length > 0) {
    parts.push("## 写作规则（必须遵守）\n");
    for (const rule of ctx.writingRules) {
      parts.push(`- ${rule.rule}`);
    }
    parts.push("");
  }

  // Platform constraints
  parts.push("## 平台约束\n");
  parts.push(`平台：${ctx.platformConstraints.platform}`);
  parts.push(`字数：${ctx.platformConstraints.minChars}-${ctx.platformConstraints.maxChars}`);
  parts.push(`Emoji：${ctx.platformConstraints.emojiUsage}`);
  parts.push(`结构：${ctx.platformConstraints.structureNotes}`);

  return parts.join("\n");
}
