/**
 * Cover Prompt Builder — generates 3 differentiated cover prompt sets
 * from a content topic.
 *
 * This is the no-engine fallback. It deliberately rotates through a broader
 * creative pool instead of reproducing the old cinematic/minimalist/bold trio.
 */
import { ORIENTATION_TEXT } from "../../adapters/image/relay-cover.js";
import { coverStylePrompt, type CoverStyleProfile } from "./style-profile.js";

// --- Types ---

export type CoverStyle =
  | "documentary-evidence"
  | "tactile-metaphor"
  | "editorial-collage"
  | "physical-typography"
  | "surreal-still-life"
  | "archival-dossier";

export interface CoverPromptSet {
  label: "A" | "B" | "C";
  style: CoverStyle;
  creativeConcept: string;
  visualMedium: string;
  palette: string;
  /** Full English image generation prompt */
  imagePrompt: string;
  /** Chinese title text for the cover (2-8 chars) */
  titleText: string;
  /** Layout description for reference */
  layoutHint: string;
  /** Why this content-specific idea may earn the click */
  designReason: string;
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
  targetAspect?: "3:4" | "2.35:1" | "16:9" | "4:3";
  /** 创作者确认过的封面身份、材质和图层规则 */
  styleProfile?: CoverStyleProfile | null;
}

// --- Title extraction ---

/**
 * Extract a short, punchy cover title (2-8 Chinese chars) from the content title.
 * Strips filler words and picks the most impactful segment.
 */
export function extractCoverTitle(title: string, customTitle?: string): string {
  if (customTitle && customTitle.length >= 2 && customTitle.length <= 9) {
    return customTitle;
  }

  // Remove common filler patterns
  const cleaned = title
    .replace(/[【】《》「」『』""'']/g, "")
    .replace(/[!！?？。，,.:：;；\s]+/g, " ")
    .trim();

  // If already short enough, use as-is
  if (cleaned.length <= 8) return cleaned;

  // Try to find a punchy segment: split by common delimiters
  const segments = cleaned.split(/[，,：:！!？?|｜—\-/、]/);
  const best = segments
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 8)
    .sort((a, b) => b.length - a.length)[0];

  if (best) return best;

  // Fallback: take first 6 chars
  return cleaned.slice(0, 6);
}

interface CreativeArchetype {
  style: CoverStyle;
  name: string;
  concept: string;
  medium: string;
  palette: string;
  scene: string;
  layout: string;
  titleTreatment: string;
}

const CREATIVE_POOL: CreativeArchetype[] = [
  {
    style: "documentary-evidence",
    name: "现场证物",
    concept: "把正文里最具体的一件物品拍成能证明观点的证物，而不是抽象科技背景",
    medium: "documentary editorial photography",
    palette: "natural daylight, paper white, graphite and one evidence-red accent",
    scene:
      "a real tabletop evidence scene built from one concrete object explicitly mentioned in the story, with human traces, annotations and believable imperfections",
    layout:
      "asymmetric overhead crop; the evidence object owns one edge while the headline is integrated as an evidence label or stamped note",
    titleTreatment: "printed on an evidence tag, stamped strip, or clipped annotation inside the scene",
  },
  {
    style: "tactile-metaphor",
    name: "触觉隐喻",
    concept: "把文章的核心交换或冲突变成一个可以摸到的荒诞物件",
    medium: "hand-built tactile still life photography",
    palette: "warm material colors, soft shadows, one unexpected saturated object",
    scene:
      "a surprising physical metaphor made from everyday materials, with no computer screen, no server rack and no hologram",
    layout:
      "one oversized handmade object breaks the frame; the headline belongs to its packaging, warning label or receipt",
    titleTreatment: "physically printed on the object, packaging, receipt or warning seal",
  },
  {
    style: "editorial-collage",
    name: "纸上拼贴",
    concept: "用正文里的地点、数字、物件和一句判断做有编辑观点的手工拼贴",
    medium: "hand-cut editorial paper collage and risograph texture",
    palette: "high-key off-white paper, ink black, cobalt and vermilion accents",
    scene:
      "layered torn paper fragments derived from the story's concrete details, visible tape, crop marks and tactile print texture",
    layout: "rhythmic editorial grid with deliberate overlaps; avoid the default left-image-right-text split",
    titleTreatment: "assembled from bold printed Chinese type strips woven into the collage",
  },
  {
    style: "physical-typography",
    name: "实体大字",
    concept: "让标题成为场景中的真实物体，而不是后期压在背景上的一层字",
    medium: "large-scale typographic installation photographed in a real environment",
    palette: "bright ambient light, restrained environment, one strong material color",
    scene:
      "the Chinese headline fabricated as tape, cardboard, projected shadow, road marking or hanging sign interacting with a story-specific place",
    layout: "type creates depth and perspective across the frame; the environment remains simple and believable",
    titleTreatment: "the exact Chinese headline is the physical installation itself",
  },
  {
    style: "surreal-still-life",
    name: "尺度错位",
    concept: "把核心矛盾通过尺度错位变成一眼就懂、但现实中不可能发生的静物场景",
    medium: "surreal studio still life with practical effects",
    palette: "clean high-key studio field, crisp object colors, controlled hard shadow",
    scene:
      "one impossible but instantly legible scale relationship between two concrete objects from the content, made to look physically photographed",
    layout: "central or diagonal object tension with generous breathing room; no generic futuristic decoration",
    titleTreatment: "set as a museum caption, measuring mark or product label that participates in the illusion",
  },
  {
    style: "archival-dossier",
    name: "档案解密",
    concept: "把文章处理成一页刚被揭开的档案，突出事实链而不是情绪灯光",
    medium: "archival dossier scan, contact sheet and annotated document design",
    palette: "aged paper, carbon black, faded blue, selective fluorescent marker",
    scene:
      "a dense but controlled dossier using a date, place, number or quote taken from the content, with redactions and handwritten connections",
    layout: "modular document composition; the headline acts as the case-file title, not a floating overlay",
    titleTreatment: "typed or stamped as the case-file heading with authentic print imperfections",
  },
];

function hashText(value: string): number {
  let hash = 2166136261;
  for (const ch of value) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function chooseArchetypes(input: PromptBuilderInput): CreativeArchetype[] {
  const start = hashText(input.title + input.body.slice(0, 120)) % CREATIVE_POOL.length;
  // 跨 2 取样能稳定覆盖照片/拼贴/实体字等不同媒介，不回到固定前三个。
  return [0, 2, 4].map((offset) => CREATIVE_POOL[(start + offset) % CREATIVE_POOL.length]);
}

function buildImagePrompt(input: PromptBuilderInput, titleText: string, archetype: CreativeArchetype): string {
  const aspect = input.targetAspect ?? "3:4";
  const context = `${input.title}. ${input.body.slice(0, 220)}`.replace(/\s+/g, " ");
  return [
    `${ORIENTATION_TEXT[aspect]}.`,
    `Creative direction: ${archetype.scene}.`,
    `Interpret these concrete Chinese story details rather than using generic AI imagery: ${context}.`,
    `Visual medium: ${archetype.medium}.`,
    `Palette and material: ${archetype.palette}.`,
    `Composition: ${archetype.layout}.`,
    ...(input.styleProfile ? [coverStylePrompt(input.styleProfile).trim()] : []),
    `The image MUST include the exact Chinese text "${titleText}"; ${archetype.titleTreatment}.`,
    "Chinese characters must be sharp, correctly spelled, readable at thumbnail size and naturally integrated into the scene.",
    ...(input.hasReferencePhotos
      ? [
          "If a person is included, feature the person from the reference photo and maintain their likeness; otherwise prefer story-specific objects.",
        ]
      : []),
    "No watermarks, no logos, no URLs, no unrelated English decoration.",
    "Avoid glowing keyboards, server rooms, blue-purple neural networks, holographic code, robot brains and generic split-screen technology imagery.",
  ].join(" ");
}

// --- Public API ---

/**
 * Generate 3 cover prompt sets (A/B/C) from content metadata.
 */
export function buildCoverPrompts(input: PromptBuilderInput): CoverPromptSet[] {
  const titleText = extractCoverTitle(input.title, input.customTitle);
  const archetypes = chooseArchetypes(input);
  return archetypes.map((archetype, index) => {
    const label = (["A", "B", "C"] as const)[index];
    return {
      label,
      style: archetype.style,
      creativeConcept: `${archetype.name}: ${archetype.concept}`,
      visualMedium: archetype.medium,
      palette: archetype.palette,
      imagePrompt: buildImagePrompt(input, titleText, archetype),
      titleText,
      layoutHint: archetype.layout,
      designReason: `${archetype.name}不是通用科技背景，而是把本文的具体事实转成${archetype.concept}。`,
    };
  });
}
