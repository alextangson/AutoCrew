/**
 * 调研简报存储（深调研 spec §5）：`<dataDir>/research/briefs/<topicId>.v<N>.json`。
 *
 * 三条硬约束：
 * 1. **版本不可变**：一个 revision 写下去就永不改写。`usedBriefRevision` 记在 run-log 与
 *    content 元数据里，回溯时必须能拿到**当初那份**输入（P1-12）；覆盖写等于毁证。
 *    发布用 `link(tmp → dest)`：目标已存在时内核直接 EEXIST，比「先 access 再 rename」
 *    少一个 TOCTOU 窗口，也不会像 rename 那样默默盖掉旧版本。
 * 2. **读侧永不抛**：坏 JSON / 未知 schemaVersion → 当作「没有简报」并从 onWarn 冒出来
 *    （§5「损坏可见降级，不崩」）——写稿宁可少一块材料，也不该整条链断掉。
 * 3. **dataDir 由调用方传入**：简报落在选题所在工作区，不跟随「当前工作区」。
 *
 * 类型归属：`PerspectiveOutput` 这组形状定义在本文件而不是 research-perspectives.ts——
 * 它是**落盘 schema 的一部分**（brief.perspectives 原样保留），schemaVersion 管的就是它，
 * 所以由存储层持有，运行层反过来引用。依赖方向单向：perspectives → brief-store。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isTopicId } from "../../storage/entity-id.js";
import type { PerspectiveName } from "./research-job-store.js";

/** 落盘契约版本。改字段语义必须 +1，读侧对不认识的版本一律降级成「无简报」 */
export const BRIEF_SCHEMA_VERSION = 1;

// ─── 视角产出（submit_perspective 的合法载荷，原样进简报） ───────────────────

export interface PerspectiveInsight {
  text: string;
  /** 至少一条：洞察必须挂在 broker 登记过的来源上（§4「成功判定」） */
  sourceIds: string[];
}

export interface PerspectiveEvidence {
  claim: string;
  /** 只能是已读页面（p*）——搜索摘要不足以支撑逐字引文 */
  sourceId: string;
  quote: string;
}

export interface PerspectiveAssetPick {
  assetId: string;
  caption: string;
}

export interface PerspectiveOutput {
  name: PerspectiveName;
  insights: PerspectiveInsight[];
  evidence: PerspectiveEvidence[];
  assetPicks: PerspectiveAssetPick[];
  /** 这一路自己点名的材料缺口（配额耗尽 / 找不到数据 / 页面反爬） */
  gaps: string[];
}

// ─── 简报（§5 schema） ───────────────────────────────────────────────────────

/** 简报级证据：sourceId 已由代码解析成可点的 URL，写稿注入时直接带域名 */
export interface BriefEvidence {
  claim: string;
  quote: string;
  sourceUrl: string;
}

/** R1a 只到链接级：不下载，assetId 已解析成图片 URL + 它所在的页面 */
export interface BriefAssetPick {
  url: string;
  sourcePageUrl: string;
  caption: string;
}

export interface ResearchBrief {
  schemaVersion: number;
  /** ≤200 字中文摘要 */
  summary: string;
  /** 四视角原样保留（含各自的 sourceId 引用），供回溯与调试 */
  perspectives: PerspectiveOutput[];
  /** 跨视角张力点 0-3 条；**空数组合法**——没有就是没有，不逼模型编（§5） */
  tensions: string[];
  angleSuggestions: string[];
  evidence: BriefEvidence[];
  assetPicks: BriefAssetPick[];
  /** 没跑成的视角，partial 时逐个点名 */
  missingPerspectives: PerspectiveName[];
  /** 材料缺口并集：各视角 gaps + 配额耗尽 + 代码侧解析不到而丢弃的条目（§9.4） */
  gaps: string[];
  generatedAt: string;
  revision: number;
  /** 触发时的选题 hash；与当前选题不符 = 简报已过期（§2） */
  topicHash: string;
}

/** 读到坏文件时的可见出口——读侧不抛，但也绝不静默 */
export type BriefWarn = (message: string) => void;

/** 同 revision 重复写：调用方拿到它说明 revision 分配错了，不是「再存一次」 */
export class BriefExistsError extends Error {
  readonly name = "BriefExistsError";
  constructor(readonly filePath: string) {
    super(`简报版本已存在，不可覆盖：${filePath}`);
  }
}

const RESEARCH_DIR = "research";
const BRIEFS_DIR = "briefs";

export function briefsDir(dataDir: string): string {
  return path.join(dataDir, RESEARCH_DIR, BRIEFS_DIR);
}

/** topicId 会成为路径片段：非法 id 直接拒，别让它拼出 `../` */
function assertTopicId(topicId: string): void {
  if (!isTopicId(topicId)) throw new Error(`非法选题 id：${topicId}`);
}

export function briefPath(topicId: string, revision: number, dataDir: string): string {
  assertTopicId(topicId);
  return path.join(briefsDir(dataDir), `${topicId}.v${revision}.json`);
}

/** 目录不存在 = 一份简报都没有，是正常空态 */
async function listRevisions(topicId: string, dataDir: string): Promise<number[]> {
  assertTopicId(topicId);
  let names: string[];
  try {
    names = await fs.readdir(briefsDir(dataDir));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const prefix = `${topicId}.v`;
  const revisions: number[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const raw = name.slice(prefix.length, -".json".length);
    // 只认纯数字：`.v1.tmp-123.json` 这类写一半的残留不许冒充版本
    if (!/^\d+$/.test(raw)) continue;
    revisions.push(Number(raw));
  }
  return revisions.sort((a, b) => a - b);
}

/**
 * 下一个可用版本号 = 已有最大值 + 1（首版 1）。**按文件名扫目录**而不是读 job.briefRevision：
 * 失败的那轮不推进指针，但它可能已经占了文件名（写盘成功、之后才炸），
 * 以指针为准会撞版本；以磁盘为准永远不会。
 */
export async function nextBriefRevision(topicId: string, dataDir: string): Promise<number> {
  const revisions = await listRevisions(topicId, dataDir);
  return revisions.length === 0 ? 1 : revisions[revisions.length - 1] + 1;
}

/**
 * 落一份简报。已存在同版本 → 抛 `BriefExistsError`，**绝不覆盖**。
 * 先写 tmp 再 `link` 发布：读者要么看不到文件，要么看到完整的一份。
 */
export async function saveBrief(
  topicId: string,
  brief: ResearchBrief,
  dataDir: string,
): Promise<string> {
  const dest = briefPath(topicId, brief.revision, dataDir);
  await fs.mkdir(briefsDir(dataDir), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(brief, null, 2), "utf-8");
    try {
      await fs.link(tmp, dest);
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") throw new BriefExistsError(dest);
      throw err;
    }
  } finally {
    await fs.unlink(tmp).catch(() => {
      /* best-effort：tmp 残留不影响正确性，版本扫描也不认它 */
    });
  }
  return dest;
}

/** 形状体检：只查「注入与展示要用到的字段在不在」，不做全字段深校验 */
function isBriefShape(value: unknown): value is ResearchBrief {
  const b = value as Partial<ResearchBrief> | null;
  return (
    !!b &&
    typeof b === "object" &&
    typeof b.summary === "string" &&
    Array.isArray(b.perspectives) &&
    Array.isArray(b.tensions) &&
    Array.isArray(b.angleSuggestions) &&
    typeof b.revision === "number"
  );
}

async function readBriefFile(
  filePath: string,
  onWarn?: BriefWarn,
): Promise<ResearchBrief | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    // 不存在 = 正常空态，不告警；读不动（权限等）才值得喊一声
    if ((err as { code?: string }).code !== "ENOENT") {
      onWarn?.(`简报读取失败（${filePath}）：${(err as Error).message}`);
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    onWarn?.(`简报文件损坏，已按「无简报」处理（${filePath}）：${(err as Error).message}`);
    return null;
  }
  const version = (parsed as { schemaVersion?: unknown })?.schemaVersion;
  if (version !== BRIEF_SCHEMA_VERSION) {
    onWarn?.(
      `简报 schemaVersion 不认识（${filePath}）：实得 ${String(version)}，本版只认 ${BRIEF_SCHEMA_VERSION}——按「无简报」处理`,
    );
    return null;
  }
  if (!isBriefShape(parsed)) {
    onWarn?.(`简报字段残缺，已按「无简报」处理（${filePath}）`);
    return null;
  }
  return parsed;
}

export async function loadBrief(
  topicId: string,
  revision: number,
  dataDir: string,
  onWarn?: BriefWarn,
): Promise<ResearchBrief | null> {
  return readBriefFile(briefPath(topicId, revision, dataDir), onWarn);
}

/**
 * 最新一版。**坏了就是没有**：不回落上一版——「最新版损坏」是要修的故障，
 * 悄悄拿旧版顶上会让人以为重跑生效了（job.briefRevision 才是「当前有效简报」指针，
 * 精确回溯请用 loadBrief）。
 */
export async function loadLatestBrief(
  topicId: string,
  dataDir: string,
  onWarn?: BriefWarn,
): Promise<ResearchBrief | null> {
  const revisions = await listRevisions(topicId, dataDir);
  if (revisions.length === 0) return null;
  return loadBrief(topicId, revisions[revisions.length - 1], dataDir, onWarn);
}
