/**
 * 选题会简报的原料读取（选题会 spec §3 / 边界 12）。
 *
 * 与账号洞察不同：洞察可以带着「某源缺失」继续出报告；选题会的每个数字都要被引用来下注，
 * 所以除「文件还不存在」（= 真的没有）外，任何读失败都直接抛出原始错误，让技能停下报告，
 * 不凭记忆开会。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir, listContents, listTopics, type Content, type Topic } from "../../storage/local-store.js";
import { loadProfile, type CreatorProfile } from "../profile/creator-profile.js";
import { listOutcomes } from "../flywheel/outcome-store.js";
import { normalizePlatform, type PerformanceOutcome } from "../flywheel/outcome-schema.js";
import { groupByEntity, type EntityGroup } from "../flywheel/metrics-window.js";
import { readPullState, type MetricsPullState } from "../flywheel/pull-state.js";
import { readWorkTags, type WorkTag } from "../flywheel/platform-items.js";
import { loadPlanEntries, matchPlanEntry, type PlanEntry } from "../flywheel/plan-binding.js";
import { listHypotheses, type Hypothesis } from "../retro/hypotheses.js";
import { validOutcome } from "../insights/facts.js";
import { reviewedRow } from "../insights/metric-review.js";
import { listMeetingDates, readMeeting, type MeetingRecord } from "./meeting-store.js";

export interface BriefInputs {
  outcomes: PerformanceOutcome[];
  invalidRows: number;
  /** 指标级复核后的作品分组；未绑定的已按发布计划补上 contentId（boundVia 标出来） */
  groups: Array<EntityGroup & { boundVia: "outcome" | "plan" | null }>;
  contents: Content[];
  topics: Topic[];
  profile: CreatorProfile | null;
  hypotheses: Hypothesis[];
  pull: MetricsPullState;
  tags: Record<string, WorkTag>;
  plans: PlanEntry[];
  meetings: MeetingRecord[];
  /** 读的过程中发现、但不至于停会的问题（如回流状态文件坏了被重建）——简报顶部照写 */
  warnings: string[];
}

async function strictJson(file: string): Promise<void> {
  try { JSON.parse(await fs.readFile(file, "utf8")); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`${path.basename(file)} 读不出：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** JSONL 每行必须可解析：坏一行就报错，不把半份账本当完整数据开会 */
async function strictJsonl(file: string): Promise<void> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  raw.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try { JSON.parse(line); } catch { throw new Error(`${path.basename(file)} 第 ${i + 1} 行不是合法 JSON`); }
  });
}

async function loadMeetings(dataDir: string): Promise<MeetingRecord[]> {
  const dates = await listMeetingDates(dataDir);
  const records = await Promise.all(dates.map((d) => readMeeting(d, dataDir)));
  return records.filter((r): r is MeetingRecord => r !== null);
}

function boundGroups(rows: PerformanceOutcome[], plans: PlanEntry[]): BriefInputs["groups"] {
  const reviewed = rows.flatMap((r) => reviewedRow(r) ?? []);
  return groupByEntity(reviewed).map((g) => {
    if (g.contentId) return { ...g, boundVia: "outcome" as const };
    const planned = matchPlanEntry(plans, g.platform, g.title, g.publishedAt);
    return planned ? { ...g, contentId: planned, boundVia: "plan" as const } : { ...g, boundVia: null };
  });
}

export async function loadBriefInputs(dataDir?: string): Promise<BriefInputs> {
  const root = getDataDir(dataDir);
  await Promise.all([strictJsonl(path.join(root, "outcomes.jsonl")), strictJsonl(path.join(root, "hypotheses.jsonl")),
    strictJson(path.join(root, "creator-profile.json"))]);
  const warnings: string[] = [];
  const [rawOutcomes, contents, topics, profile, hypotheses, pull, tags, meetings] = await Promise.all([
    listOutcomes(root), listContents(root), listTopics(root), loadProfile(root), listHypotheses(root),
    readPullState(root, (msg) => warnings.push(msg)), readWorkTags(root), loadMeetings(root),
  ]);
  const plans = await loadPlanEntries(root, contents);
  const outcomes = rawOutcomes.filter(validOutcome).map((r) => ({ ...r, platform: normalizePlatform(r.platform) }));
  return {
    outcomes, invalidRows: rawOutcomes.length - outcomes.length, groups: boundGroups(outcomes, plans),
    contents, topics, profile, hypotheses, pull, tags, plans, meetings, warnings,
  };
}
