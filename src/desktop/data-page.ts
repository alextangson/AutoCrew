/**
 * 数据页读数（数据页规格 §F / §G）：一次读出平台数据、稿件、发布记录、手动决定，拼成「一行一条视频」。
 * 月份切换、中位数、加粗都是前端对这份数据的纯计算（views/data-lib.ts）。
 */
import { listContents, type Content } from "../storage/local-store.js";
import { firstPublishTime, readPublishRecord, type PublishRecord } from "../storage/publish-record.js";
import { listOutcomes } from "../modules/flywheel/outcome-store.js";
import { readDecisions } from "../modules/flywheel/outcome-links.js";
import { buildWorks, shanghaiDay, type ContentRef, type DataRow } from "../modules/flywheel/data-rows.js";
import { buildRows } from "../modules/flywheel/data-assemble.js";
import { loadProfile } from "../modules/profile/creator-profile.js";

/** 短视频四个平台的默认列顺序（§39） */
export const DEFAULT_COLUMNS = ["douyin", "wechat_video", "xiaohongshu", "bilibili"];
const PUBLISH_STATUSES = new Set(["publish_ready", "publishing", "published"]);
const LIVE_STATES = new Set(["public", "manual", "overdue"]);

export interface DataPage {
  columns: string[];
  rows: DataRow[];
  /** 「关联到…」可选的稿件 */
  contents: Array<{ id: string; title: string; day: string | null }>;
  /** 最新一次数据日期 */
  asOf: string | null;
  /** 最新快照里出现过的来源（csv / auto_pull / …） */
  sources: string[];
}

function contentRef(c: Content, record: PublishRecord | null): ContentRef {
  const platforms = record && record.kind !== "none" ? record.platforms.map((p) => ({
    platform: p.platform, title: p.title ?? null, postId: p.postId ?? null,
    day: shanghaiDay(p.time), published: LIVE_STATES.has(p.state),
  })) : [];
  const first = record ? firstPublishTime(record) : null;
  return { id: c.id, title: c.title, day: shanghaiDay(c.publishedAt ?? first), platforms };
}

/** 列：账号在画像里登记的平台里，默认四个短视频平台按固定顺序；画像里别的平台有数据才加列 */
export function pickColumns(profilePlatforms: string[] | null, withData: Set<string>): string[] {
  if (!profilePlatforms?.length) return DEFAULT_COLUMNS;
  const base = DEFAULT_COLUMNS.filter((p) => profilePlatforms.includes(p));
  const extra = profilePlatforms.filter((p) => !DEFAULT_COLUMNS.includes(p) && withData.has(p));
  const cols = [...base, ...extra];
  return cols.length ? cols : DEFAULT_COLUMNS;
}

export async function dataPage(dataDir: string): Promise<DataPage> {
  const [outcomes, contents, decisions, profile] = await Promise.all([
    listOutcomes(dataDir), listContents(dataDir), readDecisions(dataDir), loadProfile(dataDir).catch(() => null),
  ]);
  const refs: ContentRef[] = [];
  for (const c of contents) {
    const record = PUBLISH_STATUSES.has(c.status) ? await readPublishRecord(c.id, c.manualPublications, dataDir) : null;
    refs.push(contentRef(c, record));
  }
  const works = buildWorks(outcomes.map((o) => ({ ...o, metrics: o.metrics as unknown as Record<string, number | null> })));
  const asOf = outcomes.map((o) => o.metricDate).sort().pop() ?? null;
  const sources = [...new Set(works.map((w) => w.snapshots[w.snapshots.length - 1].source))].sort();
  return {
    columns: pickColumns(profile?.platforms ?? null, new Set(works.map((w) => w.platform))),
    rows: buildRows(works, refs, decisions),
    contents: refs.map((r) => ({ id: r.id, title: r.title, day: r.day })).sort((a, b) => (b.day ?? "").localeCompare(a.day ?? "")),
    asOf, sources,
  };
}
