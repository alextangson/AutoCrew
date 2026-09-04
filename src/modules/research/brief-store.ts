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
import type { PersonaKey } from "./personas.js";
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

/**
 * 无来源的受众推断（P1c spec §3.6）：凭经验而非页面得出的心理/行为判断。
 * **只有受众视角能产**，且与 `insights` 严格分家——洞察必须挂来源，推断明确不可作证据，
 * 渲染时一律带「无来源」标签。它是立意 pass 要的「误区」原料（P0 可发稿的共同起点）。
 */
export interface PerspectiveInference {
  text: string;
  /** 这条推断针对哪个画像；模型给不出就缺席，不硬猜 */
  persona?: PersonaKey;
}

export interface PerspectiveOutput {
  name: PerspectiveName;
  insights: PerspectiveInsight[];
  evidence: PerspectiveEvidence[];
  assetPicks: PerspectiveAssetPick[];
  /** 这一路自己点名的材料缺口（配额耗尽 / 找不到数据 / 页面反爬） */
  gaps: string[];
  /** 受众视角的无来源推断（§3.6）；其余视角缺席 */
  inferences?: PerspectiveInference[];
  /**
   * 校验剔除记录（§4.7）：这一路交回来但没通过校验、被**逐条剔除**的条目原因。
   * 有值 = 这份产出是「部分成功」的——整路不再因为几条坏条目被清零。
   * 新增全可选字段，**不 bump schemaVersion**（同 assetPicks / angleCards 先例）。
   */
  partialProblems?: string[];
}

// ─── 简报（§5 schema） ───────────────────────────────────────────────────────

/** 简报级证据：sourceId 已由代码解析成可点的 URL，写稿注入时直接带域名 */
export interface BriefEvidence {
  claim: string;
  quote: string;
  sourceUrl: string;
}

/**
 * 素材候选。R1a 只到链接级；R1b-B 起管线会尝试下载：
 * - `assetId` 有值 = 已入研究素材库（可显缩略图、可导入配图）；
 * - `downloadError` 有值 = 这一张降级成「仅链接」，附**人话**原因（§7「单张下载失败 → 仅链接」）。
 * 两者互斥；都没有 = 这份简报出自 R1a（没跑过下载）。**schemaVersion 保持 1**：
 * 新字段全可选，旧简报读进来逐字有效，读侧不需要分支。
 */
export interface BriefAssetPick {
  url: string;
  sourcePageUrl: string;
  caption: string;
  assetId?: string;
  downloadError?: string;
}

/**
 * 角度卡 v2（角度卡 spec §1.2）：写前「角度决策」的结构化载体，随简报的 revision 走。
 * 一张卡约束的是**全稿**，不只是开头——thesis 是必须论证的论点，antiScope 是禁区。
 *
 * 新产地（立意 pass）只产 v3；v2 留作**只读兼容**——存量简报里的卡逐字有效。
 */
export interface AngleCardV2 {
  /** "angle-1"…（版本内稳定：简报不可覆盖，位置就是身份） */
  id: string;
  /** 切入点一句话 */
  angle: string;
  /** 本稿核心论点——写稿师必须论证它，不是复述简报 */
  thesis: string;
  /** 支撑论点的证据引用（"ev-2" = brief.evidence 第 2 条）；≥1，产地校验存在性防编造 */
  coreEvidenceIds: string[];
  /** 依托的跨视角张力点（"tension-1"）；简报 tensions 允许为空，没有就不引 */
  tensionId?: string;
  /** 明确不写什么——深度的一半是舍弃 */
  antiScope: string;
  audiencePain: string;
  holdTrigger: string;
  /** 开头钩子草稿（给创始人预览手感，写稿师可改写） */
  hookDraft: string;
}

/** 网感元素（P1 spec §3.1）：一张卡至少命中 2 个，且不能全靠「新奇点」 */
export const ANGLE_ELEMENTS = ["新奇点", "爽点", "痛点→理想状态", "笑点", "泪点", "美点"] as const;
export type AngleElement = (typeof ANGLE_ELEMENTS)[number];

/** 结构骨架的**枚举**（说明文案在 angle-stage：那是提示词材料，不是落盘 schema） */
export const ANGLE_STRUCTURES = ["myth-busting", "story", "single-point", "claim-case-claim"] as const;
export type AngleStructure = (typeof ANGLE_STRUCTURES)[number];

/**
 * 第一手锚点（P1 spec §3.1）：**结构化引用**，不是一句自由文本。
 * `excerptHash` 由代码算（被引片段正文的 sha256 前 16），模型给不出也改不动——
 * 它是「这句引文当初确实出自那段材料」的唯一凭据（codex #8）。
 */
export interface FirsthandAnchor {
  kind: "transcript" | "approved_draft" | "brief_evidence";
  /** transcript / approved_draft：内容 id；brief_evidence 不用 */
  contentId?: string;
  /** transcript 的版本号（数值） */
  sourceRevision?: number;
  /** 片段 id；brief_evidence 时就是简报证据引用 "ev-N" */
  chunkId?: string;
  excerptHash: string;
  /** 必须在被引片段里**逐字**存在 */
  quote: string;
}

/**
 * 角度卡 v3（P1 spec §3.1）：立意 pass 的产出。判别字段 `cardVersion: 3`（v2 卡没有）。
 *
 * **schemaVersion 不 bump**（沿用 2026-08-24 的裁决）：卡是可选字段，两版是联合类型，
 * 旧简报读进来逐字有效；升版本等于把存量简报全部变成「无简报」。
 */
export interface AngleCardV3 {
  cardVersion: 3;
  id: string;
  angle: string;
  thesis: string;
  /** grounded = 有简报证据撑着；overview = 综述级，必须写够证据需求（§5 无证据也要能出卡） */
  evidenceLevel: "grounded" | "overview";
  /** grounded 必填 ≥1；overview 允许空 */
  coreEvidenceIds: string[];
  tensionId?: string;
  antiScope: string;
  hookDraft: string;
  /** 这一稿对谁说（账号的三项工作之一） */
  primaryPersona: PersonaKey;
  /** 他走进来时信的那个错的东西——前 3 秒要点它 */
  misconception: string;
  /** 一句话说清「为什么会这样」的因果；是不是比喻由审稿判，代码只校形状（codex #20） */
  mechanism: string;
  /** 收获感：大白话讲清为什么 + 一个他今天能做的方案/启发 */
  payoff: string;
  nextAction: string;
  counterResponse: string;
  personaGains: Record<PersonaKey, string>;
  elements: AngleElement[];
  firsthandAnchor?: FirsthandAnchor;
  /** 这个主张要落地还缺什么证据（1–3 条），写稿前定向补证按它去找 */
  evidenceNeeds: string[];
  structure: AngleStructure;
  /** 代码打的分，**只用于展示与排序**，永不写 selectedAngle（codex #7） */
  score?: number;
  scoreReasons?: string[];
}

/** 落盘类型：两版并存，读侧都认，UI 都渲染 */
export type AngleCard = AngleCardV2 | AngleCardV3;

export function isAngleCardV3(card: AngleCard | null | undefined): card is AngleCardV3 {
  return !!card && (card as AngleCardV3).cardVersion === 3;
}

/** 证据的稳定引用 id：按位置编（1-based）。同版简报永不改写，位置即身份 */
export function evidenceRefId(index: number): string {
  return `ev-${index + 1}`;
}

/** 张力点的稳定引用 id：同上 */
export function tensionRefId(index: number): string {
  return `tension-${index + 1}`;
}

/** "ev-2" → 1；格式不对返回 null（越界由调用方按数组长度判） */
function refIndex(id: unknown, prefix: string): number | null {
  if (typeof id !== "string") return null;
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n - 1 : null;
}

/** "ev-2" → evidence[1]；解析不到/越界一律 null（调用方决定打回还是省略） */
export function evidenceByRef(evidence: BriefEvidence[], id: unknown): BriefEvidence | null {
  const i = refIndex(id, "ev");
  return i !== null && i < evidence.length ? evidence[i] : null;
}

/** "tension-1" → tensions[0]；同上 */
export function tensionByRef(tensions: string[], id: unknown): string | null {
  const i = refIndex(id, "tension");
  return i !== null && i < tensions.length ? tensions[i] : null;
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
  /**
   * 结构化角度卡 2-4 张（角度卡 spec §1.3「角度是简报的一部分」）。
   *
   * **schemaVersion 保持 1**（2026-08-24 裁决，否决 spec §1.2 的升版本要求）：读侧对
   * 不认识的版本一律按「无简报」处理，升版本 = 存量简报当场全部隐身，代价远大于收益。
   * 沿用 `BriefAssetPick` 的既有先例——新增**全可选**字段不 bump，旧简报读进来逐字有效。
   *
   * spec 升版本本是为了「证据/张力点有可引用的稳定 id」（P1-10）：简报按 revision 落盘
   * 且不可覆盖（saveBrief 的 BriefExistsError 保证），所以按位置编的 `ev-N` / `tension-N`
   * 在版本内天然稳定，不需要往每条证据里塞一个存下来的 id。
   */
  angleCards?: AngleCard[];
  /**
   * 立意 pass 实际读到的内部语料片段（P1 spec §3.2 归因）：`{片段 id, excerptHash}`。
   * 写手那一侧另记 `Content.usedOwnMaterial`——两处分记，才看得出「立意用了但写手没用」。
   * P1a 还没接内部语料，字段先立好：新增全可选字段不 bump schemaVersion（同 assetPicks 先例）。
   */
  ownMaterialRefs?: { id: string; excerptHash: string }[];
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

/**
 * 形状体检：只查「注入与展示要用到的字段在不在」，不做全字段深校验。
 *
 * **卡的版本不进体检**（P1 spec §3.1）：v2 与 v3 是联合类型，一份简报里两版混着也合法，
 * 没有卡同样合法——这里只保证 `angleCards` 要么缺席、要么是个数组（读侧全按数组遍历）。
 * 逐张卡的合法性由消费方各自判：一张坏卡不该让整份简报隐身。
 */
function isBriefShape(value: unknown): value is ResearchBrief {
  const b = value as Partial<ResearchBrief> | null;
  return (
    !!b &&
    typeof b === "object" &&
    typeof b.summary === "string" &&
    Array.isArray(b.perspectives) &&
    Array.isArray(b.tensions) &&
    Array.isArray(b.angleSuggestions) &&
    (b.angleCards === undefined || Array.isArray(b.angleCards)) &&
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
