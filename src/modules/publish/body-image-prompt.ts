/**
 * 正文配图 house-style —— 把 suggest-images 写的一句话画面统一包成同一套视觉系统的生图
 * prompt。风格由代码固定,保证同一篇文章的几张图像出自一套(而不是每张各自即兴);
 * suggest-images 只负责「画什么」,「怎么统一好看」交给这里。
 *
 * 借鉴 guizang-material-illustration 的分诊思路,三档:
 *  1) 带「标签:」→ 解释图,把这些中文标签印进图里(主路,标签干净可控);
 *  2) 没「标签:」但画面明显是图表/结构(流程/象限/坐标/层级…)→ 图解模式:渲染描述里点名的中文字,
 *     不主动禁字(安全网——suggest-images 偶尔漏写「标签:」时,别把该有的坐标轴/节点名压掉);
 *  3) 其余 → 无字氛围图。
 * 三档都套同一 house-style + 反 AI-slop 约束,与封面 prompt-builder 保持同一视觉语言。
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

/**
 * 画面明显是图表/结构图的信号——即便漏写「标签:」,也不该按无字处理(否则坐标轴/节点名被压掉)。
 * 覆盖流程/象限/坐标/层级/架构/循环/对比/常见图表类型。
 */
const STRUCTURE_HINT =
  /流程|步骤|象限|坐标|横轴|纵轴|轴线|层级|层结构|分层|架构|循环|回路|飞轮|前后对比|对照|示意图|图解|拆解|矩阵|漏斗|框图|结构图|关系图|时间线|时间轴|金字塔|甘特|桑基|热力|折线|柱状|饼图|流程图|节点/;

const COMMON_HEAD = "16:9 horizontal composition, full subject visible, generous safe margins, no crop.";

/** 已带 house-style 的成品 prompt 不再二次包裹(保护人工重做/粘贴路径) */
const STYLE_SENTINEL = "Swiss editorial illustration";

/**
 * 把一条正文配图画面描述扩成完整生图 prompt(三档分诊,见文件头)。
 */
export function enrichBodyImagePrompt(hint: string): string {
  const raw = hint.trim();
  if (raw.includes(STYLE_SENTINEL)) return raw;

  // 档 1:显式「标签:」→ 解释图,印这些标签,不许别的字
  const labelMatch = raw.match(LABEL_CLAUSE);
  if (labelMatch) {
    const scene = raw.slice(0, labelMatch.index).replace(/[，,。.、\s]+$/, "").trim();
    const labels = labelMatch[1]
      .split(/[、,，/|]/)
      .map((label) => label.trim())
      .filter(Boolean);
    const labelList = labels.map((label) => `「${label}」`).join("、");
    return [
      COMMON_HEAD,
      `Illustrate this idea from a Chinese article: ${scene}.`,
      `Print these short Chinese labels as large, high-contrast, horizontal callouts on quiet off-white plates, each placed next to the object it names and away from edges: ${labelList}. Show no other text besides these labels.`,
      HOUSE_STYLE,
      "Chinese characters must be sharp, correctly spelled and legible at thumbnail size.",
      NO_SLOP,
    ].join(" ");
  }

  // 档 2:漏写「标签:」但画面是图表/结构 → 图解模式,渲染描述里点名的中文字,不禁字
  if (STRUCTURE_HINT.test(raw)) {
    return [
      COMMON_HEAD,
      `Illustrate this diagram from a Chinese article: ${raw}.`,
      "Render the Chinese words named in the description (axis names, node names, layer names, quadrant/region callouts) as large, high-contrast, correctly-spelled labels placed on the elements they name; keep each label short and legible at thumbnail size; add no other text beyond those.",
      HOUSE_STYLE,
      NO_SLOP,
    ].join(" ");
  }

  // 档 3:纯氛围场景 → 无字
  return [
    COMMON_HEAD,
    `Illustrate this scene from a Chinese article: ${raw}.`,
    "The image must contain no text, letters, numbers or watermark of any kind.",
    HOUSE_STYLE,
    NO_SLOP,
  ].join(" ");
}
