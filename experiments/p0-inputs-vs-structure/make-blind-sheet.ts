#!/usr/bin/env npx tsx
/**
 * 盲评卷生成器：把 runs/ 下所有 draft.md 洗牌成 A/B/C…，答案单独存 key.json。
 *
 *   npx tsx experiments/p0-inputs-vs-structure/make-blind-sheet.ts [--topic <topicId>] [--seed <n>]
 *
 * 盲的定义是**打分的人看不到格子名**：所以 blind/<topicId>/<letter>.md 里
 * 只有正文，连标题里的「【冒烟】」这类痕迹都不做特殊处理（真跑不会有），
 * key.json 与 score-sheet.md 分开放——评分时只开 score-sheet 和字母稿。
 *
 * 洗牌用带种子的 RNG（mulberry32）：同一个 seed 洗出同一套字母，
 * 事后要复现「B 是哪一格」不必依赖当时的运气。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(HERE, "runs");
const BLIND_ROOT = path.join(HERE, "blind");

/** 26 个字母够用（一个选题最多 15 格） */
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

interface Entry {
  topicId: string;
  cellDir: string;
  cell: string;
  research: string;
  rep: string;
  draft: string;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 目录名形如 pipeline-full-rep2 → {cell, research, rep} */
function parseCellDir(name: string): { cell: string; research: string; rep: string } | null {
  const m = /^(.+)-(brief|full)-rep(\d+)$/.exec(name);
  return m ? { cell: m[1], research: m[2], rep: m[3] } : null;
}

async function collect(topicFilter: string | null): Promise<Entry[]> {
  const entries: Entry[] = [];
  let topics: string[];
  try {
    topics = (await fs.readdir(RUNS_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    throw new Error(`还没有跑过任何一格：${RUNS_ROOT} 不存在`);
  }
  for (const topicId of topics) {
    if (topicFilter && topicId !== topicFilter) continue;
    const cellDirs = (await fs.readdir(path.join(RUNS_ROOT, topicId), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("_data"))
      .map((d) => d.name)
      .sort();
    for (const cellDir of cellDirs) {
      const parsed = parseCellDir(cellDir);
      if (!parsed) continue;
      const draftPath = path.join(RUNS_ROOT, topicId, cellDir, "draft.md");
      try {
        entries.push({ topicId, cellDir, ...parsed, draft: await fs.readFile(draftPath, "utf-8") });
      } catch {
        console.warn(`[blind] 跳过 ${topicId}/${cellDir}：没有 draft.md（这格没跑成）`);
      }
    }
  }
  if (entries.length === 0) throw new Error("一份 draft.md 都没找到——先跑 run-cell.ts");
  return entries;
}

const DIMENSIONS = [
  ["事实性", "有多少**只有当事人才知道**的具体事实？编造/含糊的行业常识扣分。"],
  ["观点", "有没有一个能被反驳的主张？还是把材料复述了一遍。"],
  ["声音", "读起来像不像本人在说话？AI 腔、排比轰炸、万能开头都扣分。"],
  ["结构", "钩子—论证—收尾是否成立？读到一半会不会想划走。"],
] as const;

function scoreSheetHead(): string[] {
  return [
    "# 盲评卷",
    "",
    "四个维度各 1–5 分（1=很差，3=能发，5=我自己写也就这样）。",
    "**先把一个选题下的所有稿读完再打分**，逐篇打会被第一篇锚定。",
    "",
    ...DIMENSIONS.map(([name, how]) => `- **${name}**：${how}`),
    "",
    "打完分再看 `key.json` 对答案。看早了这轮就废了。",
    "",
  ];
}

function scoreSheetSection(topicId: string, letters: string[]): string[] {
  return [
    `## ${topicId}`,
    "",
    ...letters.map((l) => `- [${l}](./${topicId}/${l}.md)`),
    "",
    "| 稿 | 事实性 | 观点 | 声音 | 结构 | 一句话理由 |",
    "|---|---|---|---|---|---|",
    ...letters.map((l) => `| ${l} |  |  |  |  |  |`),
    "",
  ];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const topicFilter = get("--topic") ?? null;
  const seed = Number(get("--seed") ?? "20260902");
  if (!Number.isFinite(seed)) throw new Error("--seed 要是数字");

  const entries = await collect(topicFilter);
  const byTopic = new Map<string, Entry[]>();
  for (const e of entries) byTopic.set(e.topicId, [...(byTopic.get(e.topicId) ?? []), e]);

  await fs.rm(BLIND_ROOT, { recursive: true, force: true });
  await fs.mkdir(BLIND_ROOT, { recursive: true });

  const key: Record<string, Record<string, { cell: string; research: string; rep: string; dir: string }>> = {};
  const sheet: string[] = scoreSheetHead();

  for (const [topicId, list] of [...byTopic.entries()].sort()) {
    if (list.length > LETTERS.length) throw new Error(`${topicId} 有 ${list.length} 稿，超过 26 个字母`);
    // 每个选题一个独立子种子：加一个选题不该把已有选题的字母全洗一遍
    const rand = mulberry32(seed + [...topicId].reduce((a, c) => a + c.charCodeAt(0), 0));
    const shuffled = shuffle(list, rand);
    const dir = path.join(BLIND_ROOT, topicId);
    await fs.mkdir(dir, { recursive: true });
    key[topicId] = {};
    const letters: string[] = [];
    for (const [i, entry] of shuffled.entries()) {
      const letter = LETTERS[i];
      letters.push(letter);
      await fs.writeFile(path.join(dir, `${letter}.md`), entry.draft, "utf-8");
      key[topicId][letter] = { cell: entry.cell, research: entry.research, rep: entry.rep, dir: entry.cellDir };
    }
    sheet.push(...scoreSheetSection(topicId, letters));
    console.log(`[blind] ${topicId}：${letters.length} 稿 → ${letters.join(" ")}`);
  }

  await fs.writeFile(path.join(BLIND_ROOT, "score-sheet.md"), sheet.join("\n"), "utf-8");
  await fs.writeFile(
    path.join(BLIND_ROOT, "key.json"),
    `${JSON.stringify({ seed, generatedAt: new Date().toISOString(), key }, null, 2)}\n`,
    "utf-8",
  );
  console.log(`[blind] 答案 → ${path.join(BLIND_ROOT, "key.json")}（打完分再开）`);
}

main().catch((err: unknown) => {
  console.error(`[blind] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
