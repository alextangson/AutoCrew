/**
 * 共享常量与领域类型(B 期)。平台目录/看板列/状态文案与 vanilla(dom.js/board.js)
 * 同源同值——D 期清场前两边手动同步,清场后这里是唯一事实源。
 */

export const PLATFORM_CATALOG = [
  { id: "wechat_mp", label: "公众号", group: "cn", gen: true },
  { id: "douyin", label: "抖音", group: "cn", gen: true },
  { id: "xiaohongshu", label: "小红书", group: "cn", gen: true },
  { id: "wechat_video", label: "视频号", group: "cn", gen: true },
  { id: "bilibili", label: "B站", group: "cn", gen: true },
  { id: "toutiao", label: "头条", group: "cn", gen: true },
  { id: "twitter", label: "X (Twitter)", group: "en", gen: true },
  { id: "reddit", label: "Reddit", group: "en", gen: true },
  { id: "instagram", label: "Instagram", group: "en", gen: false },
] as const;

export function platformLabel(p: string | null | undefined): string {
  return PLATFORM_CATALOG.find((c) => c.id === p)?.label ?? p ?? "—";
}

export const BOARD_COLUMNS = [
  { key: "idea", label: "灵感库", statuses: [] as string[] },
  { key: "writing", label: "在写", statuses: ["topic_saved", "drafting", "draft_ready", "revision"] },
  { key: "review", label: "待审", statuses: ["reviewing", "cover_pending"] },
  { key: "ready", label: "待发布", statuses: ["approved", "publish_ready", "publishing"] },
  { key: "published", label: "已发布", statuses: ["published"] },
] as const;

export const STATUS_COLUMN: Record<string, number> = {};
BOARD_COLUMNS.forEach((c, i) => c.statuses.forEach((s) => (STATUS_COLUMN[s] = i)));

/** 拖到某列 = 流转到该列代表状态(状态机校验,非法拒绝) */
export const DROP_TARGET_STATUS: Record<string, string> = {
  writing: "draft_ready",
  review: "reviewing",
  ready: "publish_ready",
  published: "published",
};

export const VARIANT_STATUS: Record<string, string> = {
  topic_saved: "选题", drafting: "写中", draft_ready: "草稿", revision: "修订",
  reviewing: "待审", cover_pending: "待封面", approved: "已过审",
  publish_ready: "待发", publishing: "发布中", published: "已发", archived: "归档",
};

export interface Topic {
  id: string;
  title: string;
  description?: string;
  reason?: string;
  source?: string;
  link?: string;
  createdAt: string;
}

export interface Content {
  id: string;
  title: string;
  body: string;
  platform: string;
  status: string;
  topicId?: string;
  hashtags: string[];
  lastError?: string | null;
  adoption?: { verdict: string; reason?: string; reasonNote?: string };
  videoKit?: { postTitle: string; caption: string; storyboard: unknown[]; coverText: string };
  performanceData?: Record<string, number>;
  versions?: Array<{ version: number; note?: string; savedAt: string }>;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 原子分组(与 vanilla 同构):topicId 为脊椎;孤稿自成原子;纯灵感单列 */
export interface Atom {
  key: string;
  topic: Topic | null;
  members: Content[];
}

export function groupAtoms(topics: Topic[], contents: Content[]): Atom[] {
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const byTopic = new Map<string, Content[]>();
  const solo: Content[] = [];
  for (const c of contents) {
    if (c.topicId && topicById.has(c.topicId)) {
      const list = byTopic.get(c.topicId) ?? [];
      list.push(c);
      byTopic.set(c.topicId, list);
    } else {
      solo.push(c);
    }
  }
  const atoms: Atom[] = [];
  for (const [topicId, members] of byTopic) {
    atoms.push({ key: "t-" + topicId, topic: topicById.get(topicId) ?? null, members });
  }
  for (const c of solo) atoms.push({ key: "c-" + c.id, topic: null, members: [c] });
  for (const t of topics) {
    if (!byTopic.has(t.id)) atoms.push({ key: "t-" + t.id, topic: t, members: [] });
  }
  return atoms;
}

/** 原子代表稿 = 推进最远的成员(决定它落在哪一列) */
export function atomRep(atom: Atom): Content | null {
  let rep: Content | null = null;
  for (const m of atom.members) {
    if (!rep || (STATUS_COLUMN[m.status] ?? 0) > (STATUS_COLUMN[rep.status] ?? 0)) rep = m;
  }
  return rep;
}

export const VIDEO_PLATFORMS = new Set(["douyin", "wechat_video", "xiaohongshu", "bilibili"]);
