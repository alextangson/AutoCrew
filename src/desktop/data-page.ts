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
import { findCover } from "../modules/flywheel/data-covers.js";
import { coverOf } from "./board-data.js";

/** 短视频四个平台的默认列顺序（§39） */
export const DEFAULT_COLUMNS = ["douyin", "wechat_video", "xiaohongshu", "bilibili"];
const PUBLISH_STATUSES = new Set(["publish_ready", "publishing", "published"]);
const LIVE_STATES = new Set(["public", "manual", "overdue"]);
/** 「下一条」：定时了还没到 / 到点了还没确认公开 / 审核中 */
const PENDING_STATES = new Set(["scheduled", "overdue", "reviewing"]);

/** 一行的封面（§I）：手动补的 > AutoCrew 里选的 3:4 封面 > 自动回流抓的；key = 手动补 / 移除用的标识 */
export type RowCover =
  | { kind: "manual"; file: string; key: string }
  | { kind: "autocrew"; contentId: string; path: string; sha256: string }
  | { kind: "auto"; file: string };

export interface Upcoming { contentId: string; title: string; time: string | null; state: string; platforms: string[] }

export interface DataPage {
  columns: string[];
  rows: DataRow[];
  /** 「关联到…」可选的稿件 */
  contents: Array<{ id: string; title: string; day: string | null }>;
  /** 最新一次数据日期 */
  asOf: string | null;
  /** 最新快照里出现过的来源（csv / auto_pull / …） */
  sources: string[];
  /** 行 id → 封面；没有封面的行不在里面 */
  covers: Record<string, RowCover>;
  upcoming: Upcoming | null;
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

/** 手动补的先按行找，再按行里每条作品找（合并 / 关联之后，原来那行补的封面还跟着作品走） */
export async function rowCover(row: DataRow, dataDir: string): Promise<RowCover | null> {
  for (const key of [row.id, ...row.works.map((w) => `w:${w.key}`)]) {
    const file = await findCover(dataDir, "manual", key);
    if (file) return { kind: "manual", file, key };
  }
  if (row.contentId) {
    const c = await coverOf(row.contentId, dataDir).catch(() => null);
    if (c) return { kind: "autocrew", contentId: row.contentId, ...c };
  }
  for (const w of row.works) {
    const file = await findCover(dataDir, "auto", w.key);
    if (file) return { kind: "auto", file };
  }
  return null;
}

/** 最早的一条「定时 / 待公开」 */
export function pickUpcoming(items: Array<{ c: Content; record: PublishRecord | null }>): Upcoming | null {
  const cands: Upcoming[] = [];
  for (const { c, record } of items) {
    if (!record || record.kind === "none") continue;
    const pending = record.platforms.filter((p) => PENDING_STATES.has(p.state));
    if (!pending.length) continue;
    const times = pending.map((p) => p.time).filter((t): t is string => Boolean(t)).sort();
    cands.push({ contentId: c.id, title: c.title, time: times[0] ?? null, state: pending[0].state, platforms: pending.map((p) => p.platform) });
  }
  return cands.sort((a, b) => (a.time ?? "9999").localeCompare(b.time ?? "9999"))[0] ?? null;
}

export async function dataPage(dataDir: string): Promise<DataPage> {
  const [outcomes, contents, decisions, profile] = await Promise.all([
    listOutcomes(dataDir), listContents(dataDir), readDecisions(dataDir), loadProfile(dataDir).catch(() => null),
  ]);
  const refs: ContentRef[] = [];
  const records: Array<{ c: Content; record: PublishRecord | null }> = [];
  for (const c of contents) {
    const record = PUBLISH_STATUSES.has(c.status) ? await readPublishRecord(c.id, c.manualPublications, dataDir) : null;
    refs.push(contentRef(c, record));
    records.push({ c, record });
  }
  const works = buildWorks(outcomes.map((o) => ({ ...o, metrics: o.metrics as unknown as Record<string, number | null> })));
  const asOf = outcomes.map((o) => o.metricDate).sort().pop() ?? null;
  const sources = [...new Set(works.map((w) => w.snapshots[w.snapshots.length - 1].source))].sort();
  const rows = buildRows(works, refs, decisions);
  const covers: Record<string, RowCover> = {};
  for (const r of rows) { const cv = await rowCover(r, dataDir); if (cv) covers[r.id] = cv; }
  return {
    columns: pickColumns(profile?.platforms ?? null, new Set(works.map((w) => w.platform))),
    rows,
    contents: refs.map((r) => ({ id: r.id, title: r.title, day: r.day })).sort((a, b) => (b.day ?? "").localeCompare(a.day ?? "")),
    asOf, sources, covers, upcoming: pickUpcoming(records),
  };
}
