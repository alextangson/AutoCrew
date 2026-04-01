export type SupportedPlatform =
  | "xiaohongshu"
  | "douyin"
  | "wechat_mp"
  | "wechat_video"
  | "bilibili";

export interface AdaptPlatformOptions {
  title: string;
  body: string;
  targetPlatform: SupportedPlatform;
  tags?: string[];
}

export interface AdaptPlatformResult {
  ok: boolean;
  platform: SupportedPlatform;
  title: string;
  body: string;
  notes: string[];
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

function splitParagraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureSentenceEnding(text: string): string {
  if (!text) return text;
  if (/[。！？.!?]$/.test(text)) return text;
  return `${text}。`;
}

function trimTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) return title;
  return `${title.slice(0, maxLength - 1)}…`;
}

function hashtags(tags: string[] = []): string {
  if (tags.length === 0) return "";
  return tags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ");
}

function adaptForXiaohongshu(title: string, body: string, tags: string[]): AdaptPlatformResult {
  const paragraphs = splitParagraphs(body).map((paragraph) => {
    const parts = paragraph
      .replace(/([。！？])/g, "$1\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return parts.slice(0, 2).join("\n");
  });

  const bodyWithTags = [...paragraphs];
  const tagLine = hashtags(tags);
  if (tagLine) bodyWithTags.push(tagLine);

  return {
    ok: true,
    platform: "xiaohongshu",
    title: trimTitle(cleanTitle(title), 20),
    body: bodyWithTags.join("\n\n"),
    notes: [
      "按小红书习惯压成短段落和短句。",
      "保留标签行，适合直接做图文文案基底。",
    ],
  };
}

function adaptForDouyin(title: string, body: string, tags: string[]): AdaptPlatformResult {
  const paragraphs = splitParagraphs(body);
  const hook = ensureSentenceEnding(paragraphs[0] || title);
  const voiceover = paragraphs.slice(1).join("\n\n") || paragraphs[0] || body;
  const tagLine = hashtags(tags.slice(0, 5));

  return {
    ok: true,
    platform: "douyin",
    title: trimTitle(cleanTitle(title), 30),
    body: [
      "[3秒开头]",
      hook,
      "",
      "[口播]",
      voiceover,
      "",
      "[字幕重点]",
      trimTitle(cleanTitle(title), 18),
      "",
      "[互动引导]",
      "你最卡的是哪一步？评论区告诉我。",
      tagLine ? `\n${tagLine}` : "",
    ]
      .join("\n")
      .trim(),
    notes: [
      "改成短视频脚本结构，先给 3 秒钩子。",
      "默认附带一条互动引导，方便评论区承接。",
    ],
  };
}

function adaptForWechatMp(title: string, body: string): AdaptPlatformResult {
  const paragraphs = splitParagraphs(body);
  const intro = paragraphs[0] || body;
  const middle = paragraphs.slice(1);

  const sections = ["先说结论", "为什么这件事会卡住", "真正值得做的动作"];
  const blocks: string[] = [trimTitle(cleanTitle(title), 64), "", ensureSentenceEnding(intro), ""];

  middle.forEach((paragraph, index) => {
    const section = sections[index % sections.length];
    blocks.push(section, "", ensureSentenceEnding(paragraph), "");
  });

  return {
    ok: true,
    platform: "wechat_mp",
    title: trimTitle(cleanTitle(title), 64),
    body: blocks.join("\n").trim(),
    notes: [
      "改成更适合公众号长文继续扩写的结构。",
      "自动补了分节标题，方便后续加案例和配图。",
    ],
  };
}

function adaptForWechatVideo(title: string, body: string, tags: string[]): AdaptPlatformResult {
  const paragraphs = splitParagraphs(body);
  const description = [trimTitle(cleanTitle(title), 40), ...paragraphs.slice(0, 2)].join("\n");
  const tagLine = hashtags(tags.slice(0, 5));
  return {
    ok: true,
    platform: "wechat_video",
    title: trimTitle(cleanTitle(title), 40),
    body: `${description}${tagLine ? `\n\n${tagLine}` : ""}`.trim(),
    notes: [
      "压成视频号创作描述格式。",
      "保留简洁摘要，避免正文过长。",
    ],
  };
}

function adaptForBilibili(title: string, body: string, tags: string[]): AdaptPlatformResult {
  const paragraphs = splitParagraphs(body);
  const description = paragraphs.join("\n\n");
  const tagLine = hashtags(tags.slice(0, 10));
  return {
    ok: true,
    platform: "bilibili",
    title: trimTitle(cleanTitle(title), 80),
    body: `${description}${tagLine ? `\n\n${tagLine}` : ""}`.trim(),
    notes: [
      "保留信息密度，适合 B 站视频简介或动态文案。",
    ],
  };
}

export function adaptPlatformDraft(options: AdaptPlatformOptions): AdaptPlatformResult {
  const title = options.title || "未命名内容";
  const body = options.body || "";
  const tags = options.tags || [];

  switch (options.targetPlatform) {
    case "xiaohongshu":
      return adaptForXiaohongshu(title, body, tags);
    case "douyin":
      return adaptForDouyin(title, body, tags);
    case "wechat_mp":
      return adaptForWechatMp(title, body);
    case "wechat_video":
      return adaptForWechatVideo(title, body, tags);
    case "bilibili":
      return adaptForBilibili(title, body, tags);
    default:
      return {
        ok: false,
        platform: options.targetPlatform,
        title,
        body,
        notes: ["Unsupported platform"],
      };
  }
}
