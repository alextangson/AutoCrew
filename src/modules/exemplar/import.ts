/**
 * 把 `<目录>/<体裁>/bench-*.md`（docs/exemplars-draft 的形状）导进范文库。按内容 hash 幂等：
 * 没变的不出新版本。体裁目录是 5 本手册 id 之一；手法卡目录（shoufa / any）记成 any；别的目录跳过并报出来。
 * 一篇解析或入库失败不挡其他篇，结果里逐篇写明。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isPlaybookId } from "../playbook/types.js";
import { putExemplar, type ImportOutcome } from "./store.js";
import type { ExemplarGenre, ExemplarKind } from "./types.js";

const ANY_DIRS = new Set(["any", "shoufa"]);

export function genreOfDir(dir: string): ExemplarGenre | null {
  if (isPlaybookId(dir)) return dir;
  return ANY_DIRS.has(dir) ? "any" : null;
}

/** 头部「用途：结构卡 / 手法卡」决定类型；没写就是完整范文 */
export function parseExemplarFile(text: string): { title: string; kind: ExemplarKind } {
  const title = text.match(/^#\s+(.+)$/m)?.[1].trim();
  if (!title) throw new Error("缺一级标题（# 标题）");
  const head = text.split(/\n## /)[0];
  const kind: ExemplarKind = /用途[：:]\s*结构卡/.test(head) ? "structure_card" : /用途[：:]\s*手法卡/.test(head) ? "technique_card" : "exemplar";
  return { title, kind };
}

export interface ImportResult { file: string; id?: string; outcome?: ImportOutcome; version?: number; error?: string }

async function importOne(root: string, dir: string, name: string, genre: ExemplarGenre, dataDir?: string): Promise<ImportResult> {
  const file = path.join(dir, name);
  try {
    const text = await fs.readFile(path.join(root, file), "utf8");
    const { title, kind } = parseExemplarFile(text);
    const r = await putExemplar({ id: name.replace(/\.md$/, ""), genre, kind, title, text }, dataDir);
    return { file, ...r };
  } catch (e) {
    return { file, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function importExemplarDir(root: string, dataDir?: string): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  const dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const dir of dirs) {
    const names = (await fs.readdir(path.join(root, dir))).filter((n) => /^bench-.+\.md$/.test(n)).sort();
    if (!names.length) continue;
    const genre = genreOfDir(dir);
    if (!genre) { out.push({ file: dir, error: `目录 ${dir} 不是体裁 id（${["ganhuo", "shiyan", "fanchangshi", "xinxicha", "renwu", "any"].join(" / ")}），跳过` }); continue; }
    for (const name of names) out.push(await importOne(root, dir, name, genre, dataDir));
  }
  return out;
}
