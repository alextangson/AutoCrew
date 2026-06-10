/**
 * Clipboard-First Publisher — format content for manual publishing.
 *
 * For each platform, generates copy-ready text with proper formatting,
 * emoji placement, hashtag positioning, and platform-specific structure.
 */

export type ClipboardPlatform = "xiaohongshu" | "douyin" | "wechat_mp" | "wechat_video" | "bilibili";

export interface ClipboardOutput {
  platform: ClipboardPlatform;
  /** Formatted title ready to paste */
  formattedTitle: string;
  /** Formatted body ready to paste */
  formattedBody: string;
  /** Combined text (title + body + hashtags) for one-click copy */
  copyText: string;
  /** Platform publish URL to open */
  publishUrl: string;
  /** Platform-specific tips */
  tips: string[];
}

const PUBLISH_URLS: Record<ClipboardPlatform, string> = {
  xiaohongshu: "https://creator.xiaohongshu.com/publish/publish",
  douyin: "https://creator.douyin.com/creator-micro/content/upload",
  wechat_mp: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit",
  wechat_video: "https://channels.weixin.qq.com/platform/post/create",
  bilibili: "https://member.bilibili.com/platform/upload/text/edit",
};

function formatForXiaohongshu(title: string, body: string, hashtags: string[]): ClipboardOutput {
  const formattedTitle = title;
  // XHS: emoji-rich, short paragraphs, hashtags at end
  const lines = body.split(/\n{2,}/).filter(l => l.trim());
  const formattedBody = lines.join("\n\n");
  const hashtagStr = hashtags.length > 0
    ? "\n\n" + hashtags.map(h => h.startsWith("#") ? h : `#${h}`).join(" ")
    : "";
  const copyText = `${formattedTitle}\n\n${formattedBody}${hashtagStr}`;

  return {
    platform: "xiaohongshu",
    formattedTitle,
    formattedBody: formattedBody + hashtagStr,
    copyText,
    publishUrl: PUBLISH_URLS.xiaohongshu,
    tips: [
      "标题建议 15-25 字，可加 emoji 提升点击率",
      "正文建议 300-1000 字，短段落更易读",
      "封面图建议 3:4 比例",
      "Hashtag 建议 5-15 个，放在正文末尾",
    ],
  };
}

function formatForDouyin(title: string, body: string, hashtags: string[]): ClipboardOutput {
  const formattedTitle = title;
  // Douyin: short, punchy, hashtags inline
  const hashtagStr = hashtags.length > 0
    ? " " + hashtags.map(h => h.startsWith("#") ? h : `#${h}`).join(" ")
    : "";
  // Douyin text posts are short
  const trimmedBody = body.length > 300 ? body.slice(0, 297) + "..." : body;
  const formattedBody = trimmedBody + hashtagStr;
  const copyText = `${formattedTitle}\n\n${formattedBody}`;

  return {
    platform: "douyin",
    formattedTitle,
    formattedBody,
    copyText,
    publishUrl: PUBLISH_URLS.douyin,
    tips: [
      "文案建议 300 字以内",
      "前 3 秒是 hook，要抓人",
      "Hashtag 放在文案末尾，3-5 个即可",
      "如果是图文，建议 9 张图",
    ],
  };
}

function formatForWechatMp(title: string, body: string, _hashtags: string[]): ClipboardOutput {
  const formattedTitle = title;
  // WeChat MP: structured, subheadings, longer form
  const formattedBody = body;
  const copyText = `${formattedTitle}\n\n${formattedBody}`;

  return {
    platform: "wechat_mp",
    formattedTitle,
    formattedBody,
    copyText,
    publishUrl: PUBLISH_URLS.wechat_mp,
    tips: [
      "标题不超过 64 字符",
      "建议每 300-500 字加一个小标题",
      "公众号不支持 hashtag，可在文末加引导关注",
      "封面图建议 2.35:1 比例（900x383）",
    ],
  };
}

function formatForWechatVideo(title: string, body: string, hashtags: string[]): ClipboardOutput {
  const formattedTitle = title;
  const hashtagStr = hashtags.length > 0
    ? "\n" + hashtags.map(h => h.startsWith("#") ? h : `#${h}`).join(" ")
    : "";
  const formattedBody = body + hashtagStr;
  const copyText = `${formattedTitle}\n\n${formattedBody}`;

  return {
    platform: "wechat_video",
    formattedTitle,
    formattedBody,
    copyText,
    publishUrl: PUBLISH_URLS.wechat_video,
    tips: [
      "文案建议 300-800 字",
      "教育类内容表现好",
      "加文字摘要提升完播率",
    ],
  };
}

function formatForBilibili(title: string, body: string, hashtags: string[]): ClipboardOutput {
  const formattedTitle = title;
  const hashtagStr = hashtags.length > 0
    ? "\n\n" + hashtags.map(h => h.startsWith("#") ? h : `#${h}`).join(" ")
    : "";
  const formattedBody = body + hashtagStr;
  const copyText = `${formattedTitle}\n\n${formattedBody}`;

  return {
    platform: "bilibili",
    formattedTitle,
    formattedBody,
    copyText,
    publishUrl: PUBLISH_URLS.bilibili,
    tips: [
      "B站用户偏年轻，可以用梗和网络用语",
      "标题可以用【】标注内容类型",
      "正文 500-2000 字为佳",
    ],
  };
}

/**
 * Format content for clipboard publishing on a specific platform.
 */
export function formatForClipboard(
  platform: ClipboardPlatform,
  title: string,
  body: string,
  hashtags: string[] = [],
): ClipboardOutput {
  switch (platform) {
    case "xiaohongshu": return formatForXiaohongshu(title, body, hashtags);
    case "douyin": return formatForDouyin(title, body, hashtags);
    case "wechat_mp": return formatForWechatMp(title, body, hashtags);
    case "wechat_video": return formatForWechatVideo(title, body, hashtags);
    case "bilibili": return formatForBilibili(title, body, hashtags);
    default: return formatForXiaohongshu(title, body, hashtags);
  }
}
