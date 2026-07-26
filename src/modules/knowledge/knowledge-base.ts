/**
 * 知识库轻版（PRD §7.1「轻量没入式知识库」）— 本地目录扔文件即条目。
 * <dataDir>/knowledge/ 下的 .md/.txt，按选题 token 重叠度选 top-k，
 * 截取片段注入生成 prompt 的 research 槽。无 embedding（YAGNI——
 * 文件量级是十位数；语义检索随知识库正式版裁决）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";

/** 知识片段的默认字符预算——写稿侧按 research 槽剩余预算压低时，以它为上限 */
export const KNOWLEDGE_DEFAULT_CHARS = 2_000;

export interface KnowledgeOptions {
  /** 默认 3 */
  maxFiles?: number;
  /** 全部片段合计字符预算，默认 KNOWLEDGE_DEFAULT_CHARS */
  maxChars?: number;
}

export function knowledgeDir(dataDir?: string): string {
  return path.join(getDataDir(dataDir), "knowledge");
}

function tokenize(text: string): string[] {
  return text
    .split(/[\s/,，、。！？!?．.:：;；()（）[\]【】"'`]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
}

/** 中文无分词：CJK 连写段切重叠二字组，配合整 token 双轨计分 */
function cjkBigrams(text: string): string[] {
  const grams: string[] = [];
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) grams.push(run.slice(i, i + 2));
  }
  return [...new Set(grams)];
}

export async function knowledgeStatus(dataDir?: string): Promise<{ dir: string; count: number }> {
  const dir = knowledgeDir(dataDir);
  try {
    const files = await fs.readdir(dir);
    return { dir, count: files.filter((f) => /\.(md|txt)$/i.test(f)).length };
  } catch {
    return { dir, count: 0 };
  }
}

export async function retrieveKnowledge(
  topic: string,
  dataDir?: string,
  opts: KnowledgeOptions = {},
): Promise<string | null> {
  const dir = knowledgeDir(dataDir);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((f) => /\.(md|txt)$/i.test(f));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  if (names.length > 50) console.warn("[knowledge] 文件数 " + names.length + "，全量读取可能变慢——知识库正式版再上索引");

  const topicTokens = tokenize(topic);
  const topicBigrams = cjkBigrams(topic);
  if (topicTokens.length === 0 && topicBigrams.length === 0) return null;

  const scored: Array<{ name: string; content: string; score: number }> = [];
  // 顺序读且无法短路：计分需全文。当前十位数文件量级下是刻意的简单实现。
  for (const name of names) {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, name), "utf-8");
    } catch {
      continue;
    }
    const haystack = (name + "\n" + content).toLowerCase();
    let score = 0;
    for (const tok of topicTokens) {
      if (haystack.includes(tok)) score += 3;
    }
    for (const gram of topicBigrams) {
      if (haystack.includes(gram)) score += 1;
    }
    if (score >= 3) scored.push({ name, content, score });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, opts.maxFiles ?? 3);
  const budget = opts.maxChars ?? KNOWLEDGE_DEFAULT_CHARS;
  const per = Math.floor(budget / top.length);
  const parts = top.map((f) => `《${f.name}》：${f.content.slice(0, per).trim()}`);
  return `【知识库参考】\n${parts.join("\n---\n")}`;
}
