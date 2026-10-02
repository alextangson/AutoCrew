/**
 * 选题会会议记录 `<dataDir>/meetings/<YYYY-MM-DD>.json`（选题会 spec §4）。
 *
 * 只存会议本身：片单、毙题与理由、对账回答。下注在 hypotheses.jsonl（同一条假设台账），
 * 选题上的 meetingSlot 只是指针。同日重开 = 带着读到的 revision 写回（CAS）：
 * 对不上就报冲突让后来者重读，绝不静默覆盖另一个会话刚落的片单。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";

export const PERSONA_TIER_KEYS = ["core", "adjacent", "surprise"] as const;
export type PersonaTierKey = (typeof PERSONA_TIER_KEYS)[number];
export const MEETING_FORMATS = ["教学", "观点", "亲历", "案例", "测评"] as const;
export type MeetingFormat = (typeof MEETING_FORMATS)[number];

export interface MeetingWatch { platform: string; metric: string; day: 3 | 7 }

export interface MeetingSlot {
  slotId: string;
  topicId: string;
  /** 选题标题快照（选题改名或进回收站后纪要仍可读） */
  title: string;
  hypothesisId: string;
  /** 画像 key + 当时的名字快照：档案改名后旧下注仍按快照展示（边界 10） */
  persona: { key: PersonaTierKey; name: string };
  /** 观众拿走什么：看完能做的事或能下的判断 */
  payoff: string;
  format: MeetingFormat;
  /** 内容线：自由文本 */
  line?: string;
  whyNow: string;
  /** 数据依据：引简报作品与数字；没有就写「无数据依据，纯判断」 */
  dataBasis: string;
  bet: string;
  watch: MeetingWatch;
  probability: number;
  premortem: string;
  /** 已有立意卡/选中角度时创始人的决定（边界 7） */
  angleDecision?: "rerun" | "accept_deviation";
}

export interface MeetingRecord {
  date: string;
  revision: number;
  savedAt: string;
  slots: MeetingSlot[];
  rejected: Array<{ topicId?: string; title: string; reason: string }>;
  reviews: Array<{ hypothesisId: string; verdict: string; wouldRepeat: string }>;
  notes?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCK_STALE_MS = 30_000;

export function meetingsDir(dataDir?: string): string {
  return path.join(getDataDir(dataDir), "meetings");
}

/** 日期进路径前必须先过这一关（模型给的 date 可能是 "/../../x"） */
export function assertMeetingDate(date: unknown): string {
  if (typeof date !== "string" || !DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`会议日期必须是 YYYY-MM-DD：${String(date).slice(0, 40)}`);
  }
  return date;
}

function meetingFile(date: string, dataDir?: string): string {
  assertMeetingDate(date);
  return path.join(meetingsDir(dataDir), `${date}.json`);
}

/** 不存在 → null；读坏/格式不对直接抛（不把坏记录当「没开过会」） */
export async function readMeeting(date: string, dataDir?: string): Promise<MeetingRecord | null> {
  let raw: string;
  try { raw = await fs.readFile(meetingFile(date, dataDir), "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as MeetingRecord;
  if (!parsed || parsed.date !== date || typeof parsed.revision !== "number" || !Array.isArray(parsed.slots)) {
    throw new Error(`会议记录 meetings/${date}.json 格式不对，请人工检查，不会覆盖`);
  }
  return { ...parsed, rejected: parsed.rejected ?? [], reviews: parsed.reviews ?? [] };
}

/** 全部会议日期，新到旧 */
export async function listMeetingDates(dataDir?: string): Promise<string[]> {
  let names: string[];
  try { names = await fs.readdir(meetingsDir(dataDir)); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 10)).sort().reverse();
}

/**
 * 在本周片单里 = 会议位指向最近一次会议。进片单的选题豁免 3 天过期、看板置顶；
 * 下次开会没再选中（指针停在更早的会）就失效（选题会 spec 边界 8）。
 */
export function inCurrentSlate(topic: { meetingSlot?: { meetingDate: string } }, latestMeeting: string | null): boolean {
  return !!topic.meetingSlot && !!latestMeeting && topic.meetingSlot.meetingDate >= latestMeeting;
}

export async function latestMeetingDate(dataDir?: string): Promise<string | null> {
  return (await listMeetingDates(dataDir))[0] ?? null;
}

/** 跨进程互斥：mkdir 是原子的；锁超过 30 秒视为崩溃残留 */
async function withLock<T>(date: string, dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  assertMeetingDate(date);
  const lock = path.join(meetingsDir(dataDir), `.${date}.lock`);
  await fs.mkdir(meetingsDir(dataDir), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.mkdir(lock); break; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) { await fs.rm(lock, { recursive: true, force: true }); continue; }
      if (attempt >= 20) throw new Error(`会议记录 ${date} 正被另一个会话写入，稍后重读再试`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { await fs.rm(lock, { recursive: true, force: true }); }
}

export class MeetingConflictError extends Error {
  constructor(public readonly current: number, expected: number) {
    super(`会议记录已被另一个会话更新（当前 revision ${current}，你基于 ${expected}）——先 meeting_get 重读再改，不会覆盖`);
  }
}

/**
 * CAS 写：expectedRevision 必须等于盘上当前 revision（新会 = 0）。
 * `apply` 在锁内拿到写入后的记录做后续落库（假设、选题指针），失败照样抛给调用方。
 */
export async function saveMeetingCas(
  next: Omit<MeetingRecord, "revision" | "savedAt">,
  expectedRevision: number,
  dataDir?: string,
): Promise<{ record: MeetingRecord; previous: MeetingRecord | null }> {
  return withLock(next.date, dataDir, async () => {
    const previous = await readMeeting(next.date, dataDir);
    const current = previous?.revision ?? 0;
    if (current !== expectedRevision) throw new MeetingConflictError(current, expectedRevision);
    const record: MeetingRecord = { ...next, revision: current + 1, savedAt: new Date().toISOString() };
    await writeJsonAtomic(meetingFile(next.date, dataDir), record);
    return { record, previous };
  });
}
