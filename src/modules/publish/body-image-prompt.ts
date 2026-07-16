/**
 * 正文配图 house-style —— 把 suggest-images 写的一句话画面统一包成同一套视觉系统的生图
 * prompt。风格由代码固定,保证同一篇文章的几张图像出自一套(而不是每张各自即兴);
 * suggest-images 只负责「画什么」,「怎么统一好看」交给这里。
 *
 * 借鉴 guizang-material-illustration 的分诊思路:结构化内容(画面里带「标签:」声明)出带
 * 中文标签的解释图,其余出无字的编辑风氛围图。两种都套同一基调 + 同一套反 AI-slop 约束,
 * 与封面 prompt-builder 保持同一视觉语言。
 */

const HOUSE_STYLE =
  "Style: clean Swiss editorial illustration, off-white studio background, refined matte surfaces, " +
  "soft studio light with gentle contact shadows, one restrained vivid accent color used consistently across the set, " +
  "calm and credible mood.";

const NO_SLOP =
  "No watermarks, no logos, no URLs, no UI chrome, no stock-photo look. " +
  "Avoid glowing keyboards, server rooms, blue-purple neural networks, holographic code, robot brains and generic split-screen technology imagery.";

/** suggest-images 用「标签:a、b、c」声明要印在图里的中文标签 → 走解释图模式 */
const LABEL_CLAUSE = /标签\s*[:：]\s*(.+)$/;

/** 已带 house-style 的成品 prompt 不再二次包裹(保护人工重做/粘贴路径) */
const STYLE_SENTINEL = "Swiss editorial illustration";

/**
 * 把一条正文配图画面描述扩成完整生图 prompt。
 * 带「标签:…」→ 解释图(把这些中文标签印进图里);否则 → 无字氛围图。
 */
export function enrichBodyImagePrompt(hint: string): string {
  const raw = hint.trim();
  if (raw.includes(STYLE_SENTINEL)) return raw;

  const labelMatch = raw.match(LABEL_CLAUSE);
  if (labelMatch) {
    const scene = raw.slice(0, labelMatch.index).replace(/[，,。.、\s]+$/, "").trim();
    const labels = labelMatch[1]
      .split(/[、,，/|]/)
      .map((label) => label.trim())
      .filter(Boolean);
    const labelList = labels.map((label) => `「${label}」`).join("、");
    return [
      "16:9 horizontal composition, full subject visible, generous safe margins, no crop.",
      `Illustrate this idea from a Chinese article: ${scene}.`,
      `Print these short Chinese labels as large, high-contrast, horizontal callouts on quiet off-white plates, each placed next to the object it names and away from edges: ${labelList}. Show no other text besides these labels.`,
      HOUSE_STYLE,
      "Chinese characters must be sharp, correctly spelled and legible at thumbnail size.",
      NO_SLOP,
    ].join(" ");
  }

  return [
    "16:9 horizontal composition, full subject visible, generous safe margins, no crop.",
    `Illustrate this scene from a Chinese article: ${raw}.`,
    "The image must contain no text, letters, numbers or watermark of any kind.",
    HOUSE_STYLE,
    NO_SLOP,
  ].join(" ");
}
