/**
 * Cover Prompt Builder — generates 3 differentiated cover prompt sets
 * from a content topic.
 *
 * Each set produces a different visual style while sharing the same
 * core subject matter and title text.
 */

// --- Types ---

export type CoverStyle = "cinematic" | "minimalist" | "bold-impact";

export interface CoverPromptSet {
  label: "A" | "B" | "C";
  style: CoverStyle;
  /** Full English image generation prompt */
  imagePrompt: string;
  /** Chinese title text for the cover (2-8 chars) */
  titleText: string;
  /** Layout description for reference */
  layoutHint: string;
}

export interface PromptBuilderInput {
  /** Content title */
  title: string;
  /** Content body (first ~200 chars used for context) */
  body: string;
  /** Target platform */
  platform?: string;
  /** Whether personal IP reference photos are available */
  hasReferencePhotos: boolean;
  /** Optional custom title override (user-specified cover title) */
  customTitle?: string;
}

// --- Title extraction ---

/**
 * Extract a short, punchy cover title (2-8 Chinese chars) from the content title.
 * Strips filler words and picks the most impactful segment.
 */
export function extractCoverTitle(title: string, customTitle?: string): string {
  if (customTitle && customTitle.length >= 2 && customTitle.length <= 8) {
    return customTitle;
  }

  // Remove common filler patterns
  let cleaned = title
    .replace(/[【】《》「」『』""'']/g, "")
    .replace(/[!！?？。，,.:：;；\s]+/g, " ")
    .trim();

  // If already short enough, use as-is
  if (cleaned.length <= 8) return cleaned;

  // Try to find a punchy segment: split by common delimiters
  const segments = cleaned.split(/[，,：:！!？?|｜—\-\/、]/);
  const best = segments
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 8)
    .sort((a, b) => b.length - a.length)[0];

  if (best) return best;

  // Fallback: take first 6 chars
  return cleaned.slice(0, 6);
}

// --- Subject analysis ---

type SubjectType = "person" | "concept" | "event";

function analyzeSubject(title: string, body: string): SubjectType {
  const text = title + " " + body.slice(0, 200);
  const personKeywords = /我|你|他|她|创始人|CEO|老板|博主|达人|明星|网红|自己|个人|人物/;
  const eventKeywords = /事件|新闻|发布|上线|爆|热|突发|刚刚|今天|昨天|最新/;

  if (personKeywords.test(text)) return "person";
  if (eventKeywords.test(text)) return "event";
  return "concept";
}

// --- Mood analysis ---

function analyzeMood(title: string, body: string): string {
  const text = title + " " + body.slice(0, 200);

  if (/危|险|警|崩|暴|怒|恐|慌|焦虑|失败/.test(text)) return "tense, dramatic";
  if (/赚|钱|财|富|增长|暴涨|翻倍/.test(text)) return "ambitious, golden";
  if (/美|好|幸福|温暖|治愈|舒适|放松/.test(text)) return "warm, soft";
  if (/科技|AI|未来|数字|智能|技术/.test(text)) return "futuristic, cool-toned";
  if (/干货|方法|技巧|攻略|教程|秘诀/.test(text)) return "clean, professional";
  return "cinematic, atmospheric";
}

// --- Style templates ---

const STYLE_CONFIGS: Record<CoverStyle, {
  styleDesc: string;
  lightingDesc: string;
  colorDesc: string;
  layoutForPerson: string;
  layoutForConcept: string;
  layoutForEvent: string;
}> = {
  cinematic: {
    styleDesc: "cinematic movie poster style, photorealistic, film grain texture",
    lightingDesc: "dramatic chiaroscuro lighting with strong shadows and highlights, Rembrandt lighting",
    colorDesc: "deep contrast, desaturated with selective color accent",
    layoutForPerson: "person positioned in the lower 2/3 of the frame, looking slightly off-camera, title text in bold sans-serif at the top 1/3 with dark gradient overlay",
    layoutForConcept: "strong visual metaphor centered in frame, title text overlaid at upper 1/3 with semi-transparent dark band",
    layoutForEvent: "most dramatic moment frozen in time, title text at top with heavy dark vignette ensuring readability",
  },
  minimalist: {
    styleDesc: "minimalist editorial style, clean composition, large negative space",
    lightingDesc: "soft diffused studio lighting, even and clean",
    colorDesc: "muted palette with one bold accent color, high-key or low-key depending on mood",
    layoutForPerson: "person small in frame with vast negative space, title text large and dominant occupying 40% of frame",
    layoutForConcept: "single iconic object or symbol centered, surrounded by clean space, title text as the primary visual element",
    layoutForEvent: "abstract representation of the event, geometric shapes, title text centered and oversized",
  },
  "bold-impact": {
    styleDesc: "bold high-impact visual, saturated colors, dynamic composition",
    lightingDesc: "high-contrast dramatic lighting with neon or colored light accents",
    colorDesc: "vibrant saturated colors, complementary color scheme, eye-catching",
    layoutForPerson: "close-up or medium shot with intense expression, title text integrated into the composition with bold color block behind it",
    layoutForConcept: "explosive or dynamic visual with motion blur or energy effects, title text large and bold with drop shadow",
    layoutForEvent: "action-packed composition with diagonal lines and movement, title text at an angle or with perspective effect",
  },
};

// --- Core prompt builder ---

function buildImagePrompt(
  titleText: string,
  subject: SubjectType,
  mood: string,
  style: CoverStyle,
  hasReferencePhotos: boolean,
): string {
  const config = STYLE_CONFIGS[style];
  const layout = subject === "person"
    ? config.layoutForPerson
    : subject === "event"
      ? config.layoutForEvent
      : config.layoutForConcept;

  const parts: string[] = [
    // Core visual
    `Vertical 3:4 portrait orientation cover image.`,
    config.styleDesc + ".",
    `Mood: ${mood}.`,
    config.lightingDesc + ".",
    config.colorDesc + ".",

    // Layout
    `Composition: ${layout}.`,

    // Title text on image
    `The image MUST include the Chinese text "${titleText}" as a prominent visual element.`,
    `Text style: bold sans-serif font, large size, high contrast against background, clearly readable.`,
    `Text must be sharp, correctly spelled, and not distorted.`,

    // Reference photo handling
    ...(hasReferencePhotos && subject === "person"
      ? ["Feature the person from the reference photo as the main subject, maintaining their likeness."]
      : []),

    // Prohibitions
    "No watermarks, no logos, no URLs.",
    "No white or light solid color backgrounds.",
    "No cartoon or illustration style — photorealistic only.",
    "No blurry, warped, or misspelled text.",
  ];

  return parts.join(" ");
}

// --- Public API ---

/**
 * Generate 3 cover prompt sets (A/B/C) from content metadata.
 */
export function buildCoverPrompts(input: PromptBuilderInput): CoverPromptSet[] {
  const titleText = extractCoverTitle(input.title, input.customTitle);
  const subject = analyzeSubject(input.title, input.body);
  const mood = analyzeMood(input.title, input.body);

  const styles: Array<{ label: "A" | "B" | "C"; style: CoverStyle }> = [
    { label: "A", style: "cinematic" },
    { label: "B", style: "minimalist" },
    { label: "C", style: "bold-impact" },
  ];

  return styles.map(({ label, style }) => {
    const config = STYLE_CONFIGS[style];
    const layout = subject === "person"
      ? config.layoutForPerson
      : subject === "event"
        ? config.layoutForEvent
        : config.layoutForConcept;

    return {
      label,
      style,
      imagePrompt: buildImagePrompt(titleText, subject, mood, style, input.hasReferencePhotos),
      titleText,
      layoutHint: layout,
    };
  });
}
