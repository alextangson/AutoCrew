/**
 * 内部语料：创作者**自己产出过**的东西，按与选题的相关度挑出来给写手。
 *
 * 这是「自动调研第二条腿」的最小实现（spec v3 §3.4）：创作者不写事实包，但他的口播
 * 转写、他审过的稿子都躺在磁盘上。写手在聊天里能写出「像他」的稿，靠的正是这些。
 *
 * 只读生产目录，不写。两类来源：
 *   1. 视频转写 `contents/<id>/video/transcript.v*.json`——他真正说出口的话，最纯的第一手。
 *   2. 人审过的稿子（approved / publish_ready / publishing / published）——AI 起草但他放行了。
 *      同选题的稿子**一律排除**：拿本选题的 AI 旧稿喂写手等于让它改写，那是泄漏不是调研。
 *
 * 相关度 = 选题 bigram 被文档覆盖的比例（recall）。不用 Dice：语料只有几篇、每篇几千字，
 * Dice 被文档长度稀释到 0.00x，排不出序。转写永远排在审定稿前面——亲口说的优先于放行的。
 * 不上模型。
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface CorpusChunk {
  kind: "transcript" | "approved_draft";
  contentId: string;
  title: string;
  /** 选题 bigram 被该文档覆盖的比例 */
  score: number;
  /** 这份材料出自本选题（只有转写会带着这个标记进来）——盲评解读时要知道 */
  sameTopic: boolean;
  text: string;
}

export interface InternalCorpus {
  text: string;
  chunks: Array<Omit<CorpusChunk, "text"> & { chars: number }>;
  scanned: { transcripts: number; approvedDrafts: number; excludedSameTopic: number };
}

const HUMAN_VETTED = new Set(["approved", "publish_ready", "publishing", "published"]);

function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

function recall(query: Set<string>, doc: Set<string>): number {
  if (query.size === 0 || doc.size === 0) return 0;
  let hit = 0;
  for (const g of query) if (doc.has(g)) hit++;
  return hit / query.size;
}

const PER_CHUNK_MAX = 4500;

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}

async function transcriptText(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await fs.readdir(path.join(dir, "video"))).filter((n) => /^transcript\.v\d+\.json$/.test(n)).sort();
  } catch {
    return null;
  }
  const latest = names.at(-1);
  if (!latest) return null;
  const t = (await readJson(path.join(dir, "video", latest))) as { segments?: Array<{ text?: string }> } | null;
  const text = (t?.segments ?? []).map((s) => (s.text ?? "").trim()).filter(Boolean).join("");
  return text || null;
}

export async function collectInternalCorpus(
  sourceDataDir: string,
  topic: { id: string; title: string; description?: string },
  maxChars = 8000,
): Promise<InternalCorpus> {
  const contentsDir = path.join(sourceDataDir, "contents");
  const query = bigrams(`${topic.title}${topic.description ?? ""}`);
  const chunks: CorpusChunk[] = [];
  const scanned = { transcripts: 0, approvedDrafts: 0, excludedSameTopic: 0 };

  let ids: string[] = [];
  try {
    ids = (await fs.readdir(contentsDir)).filter((n) => !n.startsWith("."));
  } catch {
    return { text: "", chunks: [], scanned };
  }

  for (const id of ids) {
    const dir = path.join(contentsDir, id);
    const meta = (await readJson(path.join(dir, "meta.json"))) as
      | { topicId?: string; title?: string; status?: string }
      | null;
    if (!meta) continue;
    const title = meta.title ?? id;

    const transcript = await transcriptText(dir);
    if (transcript) {
      scanned.transcripts++;
      // 转写永远收：那是他亲口说的，同选题也不算泄漏
      chunks.push({
        kind: "transcript",
        contentId: id,
        title,
        score: recall(query, bigrams(transcript)),
        sameTopic: meta.topicId === topic.id,
        text: transcript,
      });
    }

    if (meta.status && HUMAN_VETTED.has(meta.status)) {
      if (meta.topicId === topic.id) {
        scanned.excludedSameTopic++;
        continue;
      }
      let draft: string;
      try {
        draft = await fs.readFile(path.join(dir, "draft.md"), "utf-8");
      } catch {
        continue;
      }
      scanned.approvedDrafts++;
      chunks.push({
        kind: "approved_draft",
        contentId: id,
        title,
        score: recall(query, bigrams(draft)),
        sameTopic: false,
        text: draft.trim(),
      });
    }
  }

  chunks.sort((a, b) => (a.kind === b.kind ? b.score - a.score : a.kind === "transcript" ? -1 : 1));
  const picked: CorpusChunk[] = [];
  let used = 0;
  for (const c of chunks) {
    if (c.score <= 0) continue;
    const room = Math.min(maxChars - used, PER_CHUNK_MAX);
    if (room < 400) break;
    const text = c.text.length > room ? `${c.text.slice(0, room)}…（截断）` : c.text;
    picked.push({ ...c, text });
    used += text.length;
  }

  const label = (c: CorpusChunk): string => (c.kind === "transcript" ? "创作者口播转写" : "创作者审定稿");
  const text = picked.length
    ? [
        "<<<CREATOR_OWN_MATERIAL>>>",
        "以下是创作者本人此前说过/审定过的内容，是第一手材料；引用时保留他的口吻，不要把它当成外部资料转述。",
        "",
        ...picked.map((c) => `### ${label(c)}：${c.title}\n${c.text}\n`),
        "<<<END_CREATOR_OWN_MATERIAL>>>",
      ].join("\n")
    : "";

  return {
    text,
    chunks: picked.map(({ text: t, ...rest }) => ({ ...rest, chars: t.length })),
    scanned,
  };
}
