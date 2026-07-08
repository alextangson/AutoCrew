/**
 * 雷达自动入库（IA v4.2 §A1）— 候选经定位过滤 + 查重后写入灵感库（Topic）。
 *
 * 入库门槛：必须命中定位 token。宁缺勿滥——未命中定位的纯新鲜热点不入库，
 * 否则灵感库退化为 RSS 收件箱（契约 §4 点名的反模式）。
 * 查重口径：与全部既有 Topic（含回收站）比标题与链接——用户删过的灵感不许次日还魂。
 * 触发：app 启动雷达刷新后 + 手动扫榜后（真调度器随总监 L2 上，PRD-v4 §4）。
 */
import { loadTopicCache, rankCandidatesScored } from "./topic-radar.js";
import type { ScoredRadarItem } from "./topic-radar.js";
import { saveTopic, listTopics, listTrash } from "../../storage/local-store.js";
import type { Topic } from "../../storage/local-store.js";
import { loadProfile } from "../profile/creator-profile.js";

const INTAKE_LIMIT = 3;
const CANDIDATE_POOL = 20;

export interface RadarIntakeResult {
  saved: Topic[];
  skippedDuplicates: number;
  /** 通过定位过滤的候选数（含重复的） */
  qualified: number;
}

function ageHours(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3600_000));
}

function buildReason(s: ScoredRadarItem): string {
  return `命中定位「${s.matchedTokens.join("、")}」 · ${s.item.source} · ${ageHours(s.item.publishedAt)}h 前`;
}

export async function intakeRadarTopics(dataDir?: string): Promise<RadarIntakeResult> {
  const profile = await loadProfile(dataDir);
  const industry = profile?.industry?.trim() ?? "";
  // 无定位 = 无过滤器 = 不自动入库（首跑校准后管道自然开启）
  if (!industry) return { saved: [], skippedDuplicates: 0, qualified: 0 };

  const cache = await loadTopicCache(dataDir);
  if (!cache || cache.items.length === 0) return { saved: [], skippedDuplicates: 0, qualified: 0 };

  const qualified = rankCandidatesScored(cache.items, industry, CANDIDATE_POOL)
    .filter((s) => s.matchedTokens.length > 0);

  const [active, trash] = await Promise.all([listTopics(dataDir), listTrash(dataDir)]);
  const seenTitles = new Set([...active, ...trash.topics].map((t) => t.title));
  const seenLinks = new Set(
    [...active, ...trash.topics].map((t) => t.link).filter((l): l is string => Boolean(l)),
  );

  const saved: Topic[] = [];
  let skippedDuplicates = 0;
  for (const s of qualified) {
    if (saved.length >= INTAKE_LIMIT) break;
    if (seenTitles.has(s.item.title) || seenLinks.has(s.item.link)) {
      skippedDuplicates++;
      continue;
    }
    const topic = await saveTopic(
      {
        title: s.item.title,
        description: `雷达候选（自动入库）：${s.item.title}`,
        tags: ["radar"],
        source: `radar:${s.item.source}`,
        reason: buildReason(s),
        link: s.item.link,
      },
      dataDir,
    );
    saved.push(topic);
    seenTitles.add(topic.title);
    if (topic.link) seenLinks.add(topic.link);
  }

  return { saved, skippedDuplicates, qualified: qualified.length };
}
