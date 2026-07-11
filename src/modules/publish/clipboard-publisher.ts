/**
 * Clipboard-First Publisher — format content for manual publishing.
 *
 * For each platform, generates copy-ready text with proper formatting,
 * emoji placement, hashtag positioning, and platform-specific structure.
 */

export type ClipboardPlatform =
  | "xiaohongshu"
  | "douyin"
  | "wechat_mp"
  | "wechat_video"
  | "bilibili"
  | "twitter"
  | "reddit"
  | "toutiao";

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
  twitter: "https://x.com/compose/post",
  reddit: "https://www.reddit.com/submit",
  toutiao: "https://mp.toutiao.com/profile_v4/graphic/publish",
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

/** X 帖长权重:CJK 计 2 单位、其余计 1,上限 280(X 官方口径的近似,超限自动分楼) */
function xUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += /[一-鿿\u3000-〿＀-￯]/.test(ch) ? 2 : 1;
  return units;
}

function formatForTwitter(title: string, body: string, hashtags: string[]): ClipboardOutput {
  // X 无独立标题:标题即首行钩子。超 280 单位自动按段落分楼(thread),编号前缀
  const hashtagStr = hashtags.slice(0, 2).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  const full = [title, body].filter(Boolean).join("\n\n") + (hashtagStr ? `\n\n${hashtagStr}` : "");
  let formattedBody: string;
  if (xUnits(full) <= 280) {
    formattedBody = full;
  } else {
    const paras = [title, ...body.split(/\n{2,}/)].filter((p) => p.trim());
    const posts: string[] = [];
    let cur = "";
    for (const p of paras) {
      const candidate = cur ? `${cur}\n\n${p}` : p;
      if (cur && xUnits(candidate) > 252) { // 留 ~28 单位给「n/」编号与空白
        posts.push(cur);
        cur = p;
      } else {
        cur = candidate;
      }
    }
    if (cur) posts.push(cur);
    formattedBody = posts
      .map((p, i) => `${i + 1}/ ${p}${i === posts.length - 1 && hashtagStr ? `\n\n${hashtagStr}` : ""}`)
      .join("\n\n─── 下一楼 ───\n\n");
  }
  return {
    platform: "twitter",
    formattedTitle: title,
    formattedBody,
    copyText: formattedBody,
    publishUrl: PUBLISH_URLS.twitter,
    tips: [
      "首行就是钩子:时间线只展示前两行",
      "单帖上限 280 单位(中文按 2 计,约 140 字);超限已按「1/ 2/」分楼,逐楼回复自己发",
      "Hashtag 最多 1-2 个,多了降触达",
      "配图/图表能显著提升转发",
    ],
  };
}

function formatForReddit(title: string, body: string, _hashtags: string[]): ClipboardOutput {
  // Reddit:无 hashtag 文化;标题决定生死;正文 markdown 原样
  return {
    platform: "reddit",
    formattedTitle: title,
    formattedBody: body,
    copyText: `${title}\n\n${body}`,
    publishUrl: PUBLISH_URLS.reddit,
    tips: [
      "先选对 subreddit,读它的置顶规则(很多社区禁自我推广)",
      "标题即全部:具体、诚实、不标题党——Reddit 反感营销腔",
      "正文支持 markdown;分享经验/数据/教训比观点更受欢迎",
      "发布后头 1 小时留在评论区回复,能显著影响热度",
      "无 hashtag 文化,已忽略话题标签",
    ],
  };
}

function formatForToutiao(title: string, body: string, _hashtags: string[]): ClipboardOutput {
  // 头条:信息流分发,标题即推荐权重;正文段落短
  return {
    platform: "toutiao",
    formattedTitle: title,
    formattedBody: body,
    copyText: `${title}\n\n${body}`,
    publishUrl: PUBLISH_URLS.toutiao,
    tips: [
      "标题 20-30 字,带具体数字/冲突/悬念(信息流靠标题拿推荐)",
      "正文 1000-2000 字,每段 2-3 行,小标题分节",
      "至少 2 张配图(首图决定信息流卡片)",
      "文末引导关注;避免外链(影响推荐)",
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
    case "twitter": return formatForTwitter(title, body, hashtags);
    case "reddit": return formatForReddit(title, body, hashtags);
    case "toutiao": return formatForToutiao(title, body, hashtags);
    default: return formatForXiaohongshu(title, body, hashtags);
  }
}
