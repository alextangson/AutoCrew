/**
 * 把 `<目录>/<体裁>/bench-*.md`（docs/exemplars-draft 的形状）导进范文库。按内容 hash 幂等：
 * 没变的不出新版本。`voice/` 子目录里的是创始人成片转写，按口吻参考（voice_ref）入库。体裁目录是 5 本手册 id 之一；手法卡目录（shoufa / any）记成 any；别的目录跳过并报出来。
 * 一篇解析或入库失败不挡其他篇，结果里逐篇写明。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isPlaybookId } from "../playbook/types.js";
import { putExemplar, type ImportOutcome } from "./store.js";
import { importVoiceFiles } from "./voice.js";
import type { ExemplarGenre, ExemplarKind } from "./types.js";

const ANY_DIRS = new Set(["any", "shoufa"]);

export function genreOfDir(dir: string): ExemplarGenre | null {
  if (isPlaybookId(dir)) return dir;
  return ANY_DIRS.has(dir) ? "any" : null;
}

/** 一节正文：`## 名字` 到下一个 `## ` */
function section(text: string, name: string): string | null {
  const m = text.match(new RegExp(`^##\\s*${name}\\s*$`, "m"));
  if (!m || m.index === undefined) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** 去掉时间戳、标点、空白，只比字 */
const bare = (t: string) => t.replace(/\*\*\[\d{2}:\d{2}\]\*\*/g, "").replace(/[\s\p{P}\p{S}]/gu, "");

/** 批注每一条标题里引的「原句」都要在全文里找得到（按 …… / → 切段，忽略标点空白）；找不到的列出来 */
export function missingQuotes(full: string, notes: string): string[] {
  const body = bare(full);
  const heads = notes.split("\n").filter((l) => /^\d+\.\s/.test(l)).map((l) => l.match(/\*\*(.+?)\*\*/)?.[1] ?? "");
  const quotes = heads.flatMap((h) => [...h.matchAll(/「([^「」]*(?:「[^」]*」[^「」]*)*)」/g)].map((m) => m[1]));
  return quotes.filter((q) => q.split(/……|…|→/).map(bare).filter(Boolean).some((frag) => !body.includes(frag)));
}

/** 头部「用途：结构卡 / 手法卡」决定类型；没写就是完整范文。完整范文要有「全文」一节，批注引的原句要在全文里（§10） */
export function parseExemplarFile(text: string): { title: string; kind: ExemplarKind } {
  const title = text.match(/^#\s+(.+)$/m)?.[1].trim();
  if (!title) throw new Error("缺一级标题（# 标题）");
  const head = text.split(/\n## /)[0];
  const kind: ExemplarKind = /用途[：:]\s*结构卡/.test(head) ? "structure_card" : /用途[：:]\s*手法卡/.test(head) ? "technique_card" : "exemplar";
  if (kind !== "exemplar") return { title, kind };
  const full = section(text, "全文");
  if (!full) throw new Error("完整范文缺「## 全文」一节或它是空的");
  const missing = missingQuotes(full, section(text, "批注") ?? "");
  if (missing.length) throw new Error(`批注引的原句在全文里找不到：${missing.map((q) => `「${q}」`).join("、")}`);
  return { title, kind };
}

export interface ImportResult { file: string; id?: string; outcome?: ImportOutcome; version?: number; error?: string }

async function importOne(root: string, dir: string, name: string, genre: ExemplarGenre, dataDir?: string, replaces?: string): Promise<ImportResult> {
  const file = path.join(dir, name);
  try {
    const text = await fs.readFile(path.join(root, file), "utf8");
    const { title, kind } = parseExemplarFile(text);
    const r = await putExemplar({ id: name.replace(/\.md$/, ""), genre, kind, title, text, ...(replaces ? { replaces } : {}) }, dataDir);
    return { file, ...r };
  } catch (e) {
    return { file, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function importExemplarDir(root: string, dataDir?: string, replaces?: string): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  const dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const dir of dirs) {
    if (dir === "voice") { out.push(...await importVoiceFiles([path.join(root, dir)], dataDir)); continue; }
    const names = (await fs.readdir(path.join(root, dir))).filter((n) => /^bench-.+\.md$/.test(n)).sort();
    if (!names.length) continue;
    const genre = genreOfDir(dir);
    if (!genre) { out.push({ file: dir, error: `目录 ${dir} 不是体裁 id（${["ganhuo", "shiyan", "fanchangshi", "xinxicha", "renwu", "any"].join(" / ")}），跳过` }); continue; }
    for (const name of names) out.push(await importOne(root, dir, name, genre, dataDir, replaces));
  }
  return out;
}
