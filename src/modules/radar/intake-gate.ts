/**
 * 灵感入库的「机械门」——查重 + 7 天落选记忆 + 落库，纯确定性:无 LLM 调用、无关键词降级、无批量上限。
 *
 * 谁在用:雷达批量路径（radar-intake，语义判定在它自己那层）与收件箱单条路径（语义判定由分流模块做）。
 * 两条路共用同一套口径,才不会出现「雷达挡住的灵感从收件箱还魂」——查重与落选记忆只应有一份实现。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { saveTopic, listTopics, listTrash, getDataDir } from "../../storage/local-store.js";
import type { Topic } from "../../storage/local-store.js";

// 落选记忆:粗筛排序是确定性的(关键词+热度),LLM 评过但没过关的候选若无记忆,每轮都
// 霸占评判池、被反复重评——池子永远是老面孔,新灵感进不来(这就是「扫了几轮灵感不增加」)。
// 记 7 天:时效过了的老候选自然出清,偶有误杀的好题一周后还有机会回池。
const REJECT_FILE = "radar-rejects.json";
const REJECT_TTL_MS = 7 * 24 * 3600_000;

export interface RejectEntry {
  title: string;
  link: string;
  at: string;
}

/** 读落选记忆,只返回 7 天窗口内的条目(过期即视为不存在,不做写回清理)。 */
export async function loadRejects(dataDir?: string): Promise<RejectEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(getDataDir(dataDir), REJECT_FILE), "utf-8")) as {
      entries?: RejectEntry[];
    };
    const cutoff = Date.now() - REJECT_TTL_MS;
    return (raw.entries ?? []).filter((e) => new Date(e.at).getTime() > cutoff);
  } catch {
    return [];
  }
}

export async function saveRejects(entries: RejectEntry[], dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, REJECT_FILE), JSON.stringify({ entries }, null, 2) + "\n", "utf-8");
}

/** 落选记忆的命中键:标题与链接任一撞上即算「评过没过关」。 */
export function rejectKeySet(rejects: RejectEntry[]): Set<string> {
  return new Set(rejects.flatMap((r) => [r.title, r.link].filter(Boolean)));
}

/**
 * 既有灵感索引:标题(含 originalTitle)与链接 → topic id,**含回收站**——
 * 用户删过的灵感不许次日还魂。
 */
export interface DedupeIndex {
  /** 任一标题或链接命中即返回既有 topic id;都没命中返回 undefined。 */
  findDuplicate(titles: Array<string | undefined>, link?: string): string | undefined;
  /** 把刚落库的 topic 并入索引(同一批内后续候选立即可查重)。 */
  remember(topic: Pick<Topic, "id" | "title" | "link">): void;
}

export async function loadDedupeIndex(dataDir?: string): Promise<DedupeIndex> {
  const [active, trash] = await Promise.all([listTopics(dataDir), listTrash(dataDir)]);
  const byTitle = new Map<string, string>();
  const byLink = new Map<string, string>();
  for (const t of [...active, ...trash.topics]) {
    for (const title of [t.title, t.originalTitle]) {
      if (title) byTitle.set(title, t.id);
    }
    if (t.link) byLink.set(t.link, t.id);
  }
  return {
    findDuplicate(titles, link) {
      for (const title of titles) {
        const hit = title ? byTitle.get(title) : undefined;
        if (hit) return hit;
      }
      return link ? byLink.get(link) : undefined;
    },
    // 只登记 title/link:originalTitle 是入库时才产生的加工痕迹,批内不参与查重
    // (下一轮 loadDedupeIndex 会从落盘数据里带上它)。
    remember(topic) {
      byTitle.set(topic.title, topic.id);
      if (topic.link) byLink.set(topic.link, topic.id);
    },
  };
}

/** 单条候选:语义判定(是否值得写)由调用方完成,门只管机械校验与落库。 */
export interface TopicCandidate {
  title: string;
  /** 落库为 topic.description */
  summary: string;
  /** 可写角度(单条);有则落库为 angles[0] */
  angle?: string;
  link?: string;
  /** 来源标识,形如 `radar:36氪` / `inbox:telegram`;冒号前的段落同时作为 tag */
  source: string;
  /** 入库理由——「为什么值得你写」(契约 §4:无理由的灵感库 = RSS 收件箱) */
  reason: string;
}

export type GateResult =
  | { saved: true; topicId: string }
  | { saved: false; code: "duplicate" | "reject_memory"; existingId?: string };

function sourceKind(source: string): string {
  return source.split(":")[0] || source;
}

/**
 * 单条入库门:查重(含回收站) → 落选记忆(7 天) → 落库。
 * 不判语义、不降级、不限批量——那些是调用方的事。
 */
export async function gateTopicCandidate(candidate: TopicCandidate, dataDir?: string): Promise<GateResult> {
  const index = await loadDedupeIndex(dataDir);
  const existingId = index.findDuplicate([candidate.title], candidate.link);
  if (existingId) return { saved: false, code: "duplicate", existingId };

  const rejectKeys = rejectKeySet(await loadRejects(dataDir));
  if (rejectKeys.has(candidate.title) || (candidate.link ? rejectKeys.has(candidate.link) : false)) {
    return { saved: false, code: "reject_memory" };
  }

  const topic = await saveTopic(
    {
      title: candidate.title,
      description: candidate.summary,
      tags: [sourceKind(candidate.source)],
      source: candidate.source,
      reason: candidate.reason,
      ...(candidate.link ? { link: candidate.link } : {}),
      ...(candidate.angle ? { angles: [candidate.angle] } : {}),
    },
    dataDir,
  );
  return { saved: true, topicId: topic.id };
}
