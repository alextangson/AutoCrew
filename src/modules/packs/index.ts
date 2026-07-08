import type { TrackPack } from "./pack-schema.js";
import type { ClipboardPlatform } from "../publish/clipboard-publisher.js";
import { KOUBO_PACK } from "./koubo.js";
import { WECHAT_ARTICLE_PACK } from "./wechat-article.js";

export const DEFAULT_PACK_ID = KOUBO_PACK.id;

const REGISTRY: Record<string, TrackPack> = {
  [KOUBO_PACK.id]: KOUBO_PACK,
  [WECHAT_ARTICLE_PACK.id]: WECHAT_ARTICLE_PACK,
};

export function getPack(id: string): TrackPack {
  const pack = REGISTRY[id];
  if (!pack) {
    throw new Error(`赛道包 ${id} 未注册（已有：${Object.keys(REGISTRY).join("/")}）`);
  }
  return pack;
}

/** 平台默认包路由（PRD-v4 §4.3）：公众号 → 深度图文，其余 → 口播。显式 packId 可覆盖 */
export function getPackForPlatform(platform: ClipboardPlatform): TrackPack {
  return platform === "wechat_mp" ? WECHAT_ARTICLE_PACK : KOUBO_PACK;
}

export type { TrackPack, PlatformReward, MetricKey } from "./pack-schema.js";
