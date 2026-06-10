import type { TrackPack } from "./pack-schema.js";
import { KOUBO_PACK } from "./koubo.js";

export const DEFAULT_PACK_ID = KOUBO_PACK.id;

const REGISTRY: Record<string, TrackPack> = {
  [KOUBO_PACK.id]: KOUBO_PACK,
};

export function getPack(id: string): TrackPack {
  const pack = REGISTRY[id];
  if (!pack) {
    throw new Error(`赛道包 ${id} 未注册（已有：${Object.keys(REGISTRY).join("/")}）`);
  }
  return pack;
}

export type { TrackPack, PlatformReward, MetricKey } from "./pack-schema.js";
