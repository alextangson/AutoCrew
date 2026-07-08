import type { TrackPack } from "./pack-schema.js";
import type { ClipboardPlatform } from "../publish/clipboard-publisher.js";
import { KOUBO_PACK } from "./koubo.js";
import { WECHAT_ARTICLE_PACK } from "./wechat-article.js";
import { TWITTER_POST_PACK } from "./twitter-post.js";
import { REDDIT_POST_PACK } from "./reddit-post.js";
import { TOUTIAO_ARTICLE_PACK } from "./toutiao-article.js";

export const DEFAULT_PACK_ID = KOUBO_PACK.id;

const REGISTRY: Record<string, TrackPack> = {
  [KOUBO_PACK.id]: KOUBO_PACK,
  [WECHAT_ARTICLE_PACK.id]: WECHAT_ARTICLE_PACK,
  [TWITTER_POST_PACK.id]: TWITTER_POST_PACK,
  [REDDIT_POST_PACK.id]: REDDIT_POST_PACK,
  [TOUTIAO_ARTICLE_PACK.id]: TOUTIAO_ARTICLE_PACK,
};

export function getPack(id: string): TrackPack {
  const pack = REGISTRY[id];
  if (!pack) {
    throw new Error(`赛道包 ${id} 未注册（已有：${Object.keys(REGISTRY).join("/")}）`);
  }
  return pack;
}

/** 平台默认包路由（PRD-v4 §4.3 + IA v5 V5.4）：图文平台各配专包,视频平台 → 口播。显式 packId 可覆盖 */
export function getPackForPlatform(platform: ClipboardPlatform): TrackPack {
  switch (platform) {
    case "wechat_mp": return WECHAT_ARTICLE_PACK;
    case "twitter": return TWITTER_POST_PACK;
    case "reddit": return REDDIT_POST_PACK;
    case "toutiao": return TOUTIAO_ARTICLE_PACK;
    default: return KOUBO_PACK;
  }
}

export type { TrackPack, PlatformReward, MetricKey } from "./pack-schema.js";
