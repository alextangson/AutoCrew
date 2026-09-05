/**
 * 内部语料（P1 spec §3.2）：创作者**自己产出过**的东西，按与选题的相关度挑出来喂给立意与写手。
 *
 * 这是「自动调研第二条腿」：创作者不写事实包，但他的口播转写、他审过的稿子都躺在磁盘上。
 * P1a 的三个选题 12 张卡**一张第一手锚点都没有**——本模块就是那一刀缺的地基。
 *
 * 只读生产目录，一个字节都不写。两类来源：
 *   1. 视频转写 `contents/<id>/video/transcript.v<N>.json`——他真正说出口的话，最纯的第一手。
 *   2. 人审放行稿（approved / publish_ready / publishing / published）——AI 起草但他放行了。
 *      同选题的稿子**一律排除**：拿本选题的 AI 旧稿喂立意等于让它改写，那是泄漏不是调研。
 *
 * 三条纪律（P0b 实证 + codex #16/#27）：
 * 1. **版本号数值排序**：`transcript.v10` 比 `v9` 新，字符串排序会挑到 v9（codex #27）。
 * 2. **非本选题的转写最多进一段**：P0b 里两段转写全塞给每个选题，DeepSeek 插件的故事
 *    漏进了「入口之争」那一稿——第一手材料串味比没有更糟。
 * 3. **片段是被引用的单位**：`om:<contentId>:<kind>:<sourceRevision>:<chunkIndex>` + 正文指纹，
 *    立意的 firsthandAnchor 与写手的 usedOwnMaterial 都按它归因；渲染经消毒块，
 *    片段正文里写一行结束定界符也伪造不出块外（codex #16）。
 *
 * 相关度 = 选题 bigram 被文档覆盖的比例（recall）。不用 Dice：语料只有几篇、每篇几千字，
 * Dice 被文档长度稀释到 0.00x，排不出序。转写永远排在放行稿前面——亲口说的优先于放行的。
 * 不上模型。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { clampChars, externalBlock, sanitizeExternal } from "./research-prompt-kit.js";

// ─── 契约 ────────────────────────────────────────────────────────────────────

export type OwnMaterialKind = "transcript" | "approved_draft";

export interface OwnMaterialChunk {
  /** `om:<contentId>:<kind>:<sourceRevision>:<chunkIndex>`——立意与写手引用的就是它 */
  id: string;
  kind: OwnMaterialKind;
  contentId: string;
  /** transcript = ASR 版本号；approved_draft = 稿件版本号（读不到时 0） */
  sourceRevision: number;
  chunkIndex: number;
  title: string;
  /** 选题 bigram 被该文档覆盖的比例 */
  score: number;
  /** 这份材料出自本选题（只有转写会带着这个标记进来）——归因与盲评解读要知道 */
  sameTopic: boolean;
  /** 正文指纹（sha256 前 16）：引用「当初确实是这段材料」的唯一凭据 */
  excerptHash: string;
  /** **模型实际看到的形态**（已消毒）：quote 逐字校验就压这份正文 */
  text: string;
}

export interface OwnMaterialRef {
  id: string;
  excerptHash: string;
}

export interface OwnMaterialScan {
  transcripts: number;
  approvedDrafts: number;
  /** 同选题的 AI 稿：读到了但故意不给（泄漏防线） */
  excludedSameTopic: number;
  /** 撞上「非本选题转写最多 1 段」被让开的 */
  skippedForeignTranscripts: number;
}

export interface OwnMaterial {
  chunks: OwnMaterialChunk[];
  /** 装进消毒定界块的提示词材料；没有片段时为空串 */
  rendered: string;
  refs: OwnMaterialRef[];
  scanned: OwnMaterialScan;
}

export interface CollectOwnMaterialOptions {
  /** 所有片段正文合计上限 */
  maxChars?: number;
  /** 单段上限 */
  perChunkMax?: number;
}

export interface OwnMaterialTopicRef {
  id: string;
  title: string;
  description?: string;
}

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_PER_CHUNK_MAX = 4500;
/** 剩不到这么多就别再塞了：几十个字的残片对立意没有用，只会稀释块 */
const MIN_ROOM = 400;

/** 渲染块的硬上限（含标题与片段 id 的开销）；调用方可以给更紧的预算 */
export const OWN_MATERIAL_BLOCK_MAX = 9000;

/** 人审放行过的状态——AI 起草但他签了字，才算「他的东西」 */
const HUMAN_VETTED = new Set(["approved", "publish_ready", "publishing", "published"]);

export const EMPTY_OWN_MATERIAL: OwnMaterial = Object.freeze({
  chunks: [],
  rendered: "",
  refs: [],
  scanned: Object.freeze({
    transcripts: 0,
    approvedDrafts: 0,
    excludedSameTopic: 0,
    skippedForeignTranscripts: 0,
  }),
}) as OwnMaterial;

// ─── 指纹与相关度 ────────────────────────────────────────────────────────────

/**
 * 片段指纹：正文压空白后的 sha256 前 16。模型算不出也改不动，
 * 改写卡时用它验「还是那段材料」（codex #8/#9）。
 */
export function excerptHashOf(text: string): string {
  return crypto.createHash("sha256").update(text.replace(/\s+/g, " ").trim(), "utf-8").digest("hex").slice(0, 16);
}

function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 选题的 bigram 有多少被这份文档覆盖（recall） */
function recall(query: Set<string>, doc: Set<string>): number {
  if (query.size === 0 || doc.size === 0) return 0;
  let hit = 0;
  for (const g of query) if (doc.has(g)) hit++;
  return hit / query.size;
}

export function ownChunkId(contentId: string, kind: OwnMaterialKind, sourceRevision: number, chunkIndex: number): string {
  return `om:${contentId}:${kind}:${sourceRevision}:${chunkIndex}`;
}

export function ownChunkById(material: OwnMaterial | undefined, id: unknown): OwnMaterialChunk | null {
  if (!material || typeof id !== "string") return null;
  return material.chunks.find((c) => c.id === id.trim()) ?? null;
}

// ─── 扫盘（只读） ────────────────────────────────────────────────────────────

interface SourceDoc {
  kind: OwnMaterialKind;
  contentId: string;
  sourceRevision: number;
  title: string;
  score: number;
  sameTopic: boolean;
  text: string;
}

interface ContentMeta {
  topicId?: string;
  title?: string;
  status?: string;
  versions?: { version?: unknown }[];
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}

/** 版本号**数值**最大的那一版（`v10` > `v9`，字符串排序会挑错——codex #27） */
async function latestTranscript(dir: string): Promise<{ revision: number; text: string } | null> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(dir, "video"));
  } catch {
    return null;
  }
  let best = -1;
  let bestName = "";
  for (const name of names) {
    const m = /^transcript\.v(\d+)\.json$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > best) {
      best = n;
      bestName = name;
    }
  }
  if (best < 0) return null;
  const parsed = (await readJson(path.join(dir, "video", bestName))) as { segments?: { text?: unknown }[] } | null;
  const text = (parsed?.segments ?? [])
    .map((s) => (typeof s.text === "string" ? s.text.trim() : ""))
    .filter(Boolean)
    .join("");
  return text ? { revision: best, text } : null;
}

/** 稿件版本号：meta.versions 的最大值（读不到就 0——归因里 0 表示「说不清是第几版」） */
function draftRevision(meta: ContentMeta): number {
  let max = 0;
  for (const v of meta.versions ?? []) {
    const n = typeof v?.version === "number" ? v.version : Number.NaN;
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

async function scanContent(
  contentsDir: string,
  contentId: string,
  topic: OwnMaterialTopicRef,
  query: Set<string>,
  scanned: OwnMaterialScan,
): Promise<SourceDoc[]> {
  const dir = path.join(contentsDir, contentId);
  const meta = (await readJson(path.join(dir, "meta.json"))) as ContentMeta | null;
  if (!meta) return [];
  const title = typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : contentId;
  const sameTopic = meta.topicId === topic.id;
  const docs: SourceDoc[] = [];

  const transcript = await latestTranscript(dir);
  if (transcript) {
    scanned.transcripts++;
    // 转写永远收：那是他亲口说的，同选题也不算泄漏（但要带标记，用法有别）
    docs.push({
      kind: "transcript",
      contentId,
      sourceRevision: transcript.revision,
      title,
      score: recall(query, bigrams(transcript.text)),
      sameTopic,
      text: transcript.text,
    });
  }

  if (meta.status && HUMAN_VETTED.has(meta.status)) {
    if (sameTopic) {
      scanned.excludedSameTopic++;
      return docs;
    }
    let draft: string;
    try {
      draft = await fs.readFile(path.join(dir, "draft.md"), "utf-8");
    } catch {
      return docs;
    }
    scanned.approvedDrafts++;
    docs.push({
      kind: "approved_draft",
      contentId,
      sourceRevision: draftRevision(meta),
      title,
      score: recall(query, bigrams(draft)),
      sameTopic: false,
      text: draft.trim(),
    });
  }
  return docs;
}

// ─── 挑选与渲染 ──────────────────────────────────────────────────────────────

/**
 * 一份文档进一段。为什么不按 4500 字切成多段：总预算只有 8000，一篇长转写切三段就能
 * 把预算吃干、放行稿一段都进不来——第一手材料的价值在**跨来源**，不在同一篇的长度。
 * id 里仍带 chunkIndex：它是引用的稳定坐标，将来一篇出多段时不需要改引用格式。
 */
function pickChunks(docs: SourceDoc[], maxChars: number, perChunkMax: number, scanned: OwnMaterialScan): OwnMaterialChunk[] {
  const picked: OwnMaterialChunk[] = [];
  let used = 0;
  let foreignTranscripts = 0;
  for (const doc of docs) {
    if (doc.score <= 0) continue;
    if (doc.kind === "transcript" && !doc.sameTopic) {
      if (foreignTranscripts >= 1) {
        scanned.skippedForeignTranscripts++;
        continue;
      }
      foreignTranscripts++;
    }
    const room = Math.min(maxChars - used, perChunkMax);
    if (room < MIN_ROOM) break;
    // 消毒放在**建片段的时候**：chunk.text 就是模型看到的那份正文，
    // quote 逐字校验才有一个唯一的比对基准（broker 的 quoteCorpus 同款理由）
    const clean = sanitizeExternal(doc.text, Number.MAX_SAFE_INTEGER);
    const text = Array.from(clean).length > room ? `${clampChars(clean, room)}…（截断）` : clean;
    if (!text.trim()) continue;
    picked.push({
      id: ownChunkId(doc.contentId, doc.kind, doc.sourceRevision, 0),
      kind: doc.kind,
      contentId: doc.contentId,
      sourceRevision: doc.sourceRevision,
      chunkIndex: 0,
      title: sanitizeExternal(doc.title, 80),
      score: doc.score,
      sameTopic: doc.sameTopic,
      excerptHash: excerptHashOf(text),
      text,
    });
    used += Array.from(text).length;
  }
  return picked;
}

const KIND_LABEL: Record<OwnMaterialKind, string> = {
  transcript: "创作者口播转写",
  approved_draft: "创作者放行稿",
};

/** 用法规则：转写是他的**经历**，不是他的**讲义**（§3.2 注入规则） */
export const OWN_MATERIAL_USAGE_RULE =
  "转写可作『我亲身经历的转折』，不可作『讲解另一个主题』";

/**
 * 渲染成提示词材料。片段正文已消毒，块级再压一次总量——
 * 装不下的整段丢掉而不是截半，块永远是完整的一对定界符。
 */
export function renderOwnMaterial(chunks: OwnMaterialChunk[], maxChars = OWN_MATERIAL_BLOCK_MAX): string {
  if (chunks.length === 0) return "";
  const body: string[] = [];
  let used = 0;
  for (const c of chunks) {
    const head = `### ${KIND_LABEL[c.kind]}｜${c.title}${c.sameTopic ? "（就是本选题那条视频）" : ""}`;
    const block = `${head}\n片段 id：${c.id}\n${c.text}`;
    const cost = Array.from(block).length;
    if (used + cost > maxChars) break;
    used += cost;
    body.push(block, "");
  }
  if (body.length === 0) return "";
  return externalBlock([
    `以下是创作者本人此前说过 / 放行过的内容，是第一手材料：引用时保留他的口吻，不要当成外部资料转述。${OWN_MATERIAL_USAGE_RULE}。`,
    "每段前面的「片段 id」就是引用坐标（firsthandAnchor.chunk_id 写它），quote 必须从该段正文里逐字复制。",
    "",
    ...body,
  ]);
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 扫一遍工作区里创作者自己的东西，挑出与这条选题相关的片段。**只读**。
 * 目录不存在 / 文件坏了都当作「没有这份材料」——内部语料是加分项，不该阻断调研。
 */
export async function collectOwnMaterial(
  dataDir: string,
  topic: OwnMaterialTopicRef,
  opts: CollectOwnMaterialOptions = {},
): Promise<OwnMaterial> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const perChunkMax = opts.perChunkMax ?? DEFAULT_PER_CHUNK_MAX;
  const scanned: OwnMaterialScan = {
    transcripts: 0,
    approvedDrafts: 0,
    excludedSameTopic: 0,
    skippedForeignTranscripts: 0,
  };
  const contentsDir = path.join(dataDir, "contents");
  const query = bigrams(`${topic.title}${topic.description ?? ""}`);

  let ids: string[];
  try {
    ids = (await fs.readdir(contentsDir)).filter((n) => !n.startsWith("."));
  } catch {
    return { chunks: [], rendered: "", refs: [], scanned };
  }

  const docs: SourceDoc[] = [];
  for (const id of ids.sort()) {
    docs.push(...(await scanContent(contentsDir, id, topic, query, scanned)));
  }
  // 转写永远排在放行稿前面；同类按相关度降序，同分按 contentId 稳定排序
  docs.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "transcript" ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.contentId.localeCompare(b.contentId);
  });

  const chunks = pickChunks(docs, maxChars, perChunkMax, scanned);
  return {
    chunks,
    rendered: renderOwnMaterial(chunks),
    refs: chunks.map((c) => ({ id: c.id, excerptHash: c.excerptHash })),
    scanned,
  };
}
