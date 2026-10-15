/**
 * 口吻参考的来源（spec 2026-10-15 §16、§17）：创始人自己已发布成片的转写，入范文库，kind=voice_ref。
 * 和范文一样有版本、核指纹，但不进范文预览、不能被锁成范文、不进 firsthand。
 * 认两种文件：分析目录里的机器转写（`## Transcript`，无标点、15 秒时间戳）和校过的口吻样本（`## 全文`）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { putExemplar, readExemplarManifest, readExemplarText, type ImportOutcome } from "./store.js";

const BODY_HEADS = ["Transcript", "全文"];
const STAMP = /\*\*\[(\d{2}:\d{2})\]\*\*/g;

/** 正文那一节（Transcript / 全文）；没有就是 null */
export function voiceBody(text: string): string | null {
  for (const h of BODY_HEADS) {
    const m = text.match(new RegExp(`^##\\s*${h}\\s*$`, "m"));
    if (!m || m.index === undefined) continue;
    const rest = text.slice(m.index + m[0].length);
    const end = rest.search(/^## /m);
    const body = (end < 0 ? rest : rest.slice(0, end)).trim();
    if (body) return body;
  }
  return null;
}

export function voiceId(file: string): string {
  const slug = path.basename(file, ".md").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `voice-${slug || createHash("sha256").update(file).digest("hex").slice(0, 8)}`;
}

export interface VoiceImportResult { file: string; id?: string; outcome?: ImportOutcome; version?: number; error?: string }

/** 导入一批口吻文件：路径可以是文件或目录（目录取其中 .md，跳过 index.md）；一篇失败不挡其他 */
export async function importVoiceFiles(paths: string[], dataDir?: string): Promise<VoiceImportResult[]> {
  const files: string[] = [];
  for (const p of paths) {
    const st = await fs.stat(p);
    if (st.isDirectory()) files.push(...(await fs.readdir(p)).filter((n) => n.endsWith(".md") && n !== "index.md").sort().map((n) => path.join(p, n)));
    else files.push(p);
  }
  const out: VoiceImportResult[] = [];
  for (const f of files) {
    try {
      const text = await fs.readFile(f, "utf8");
      const title = text.match(/^#\s+(.+)$/m)?.[1].trim();
      if (!title) throw new Error("缺一级标题（# 标题）");
      if (!voiceBody(text)) throw new Error("缺「## Transcript」或「## 全文」一节，或它是空的");
      out.push({ file: path.basename(f), ...await putExemplar({ id: voiceId(f), genre: "any", kind: "voice_ref", title, text }, dataDir) });
    } catch (e) {
      out.push({ file: path.basename(f), error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** 按时间戳段落整段截，不截半段；没有时间戳就按句末标点截 */
export function voiceExcerpt(body: string, max: number): { text: string; excerpted: boolean } {
  const parts = body.split(STAMP);
  const segs: string[] = [];
  for (let i = 1; i < parts.length; i += 2) segs.push(`[${parts[i]}] ${parts[i + 1].trim()}`);
  if (!segs.length) {
    const chars = Array.from(body);
    if (chars.length <= max) return { text: body, excerpted: false };
    const head = chars.slice(0, max).join("");
    const cut = Math.max(...["。", "！", "？"].map((p) => head.lastIndexOf(p)));
    return { text: cut > 0 ? head.slice(0, cut + 1) : head, excerpted: true };
  }
  const kept: string[] = [];
  let used = 0;
  for (const s of segs) {
    const n = Array.from(s).length + 1;
    if (used + n > max && kept.length) break;
    kept.push(s);
    used += n;
  }
  return { text: kept.join("\n"), excerpted: kept.length < segs.length };
}

export interface LibraryVoiceRef { id: string; version: number; title: string; text: string; excerpted: boolean }

/** 取 n 篇口吻参考：按稿 id 轮换起点（不同稿拿到不同的两篇，同一篇稿每次一样）；读坏的报进 errors，不当成没有 */
export async function libraryVoiceRefs(seed: string, n: number, max: number, dataDir?: string): Promise<{ refs: LibraryVoiceRef[]; errors: string[] }> {
  const m = await readExemplarManifest(dataDir);
  const all = m.exemplars.filter((e) => e.kind === "voice_ref").sort((a, b) => a.id.localeCompare(b.id));
  const refs: LibraryVoiceRef[] = [];
  const errors: string[] = [];
  const start = all.length ? parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % all.length : 0;
  for (let i = 0; i < all.length && refs.length < n; i++) {
    const e = all[(start + i) % all.length];
    try {
      const body = voiceBody(await readExemplarText(e.id, e.current, dataDir, m));
      if (!body) { errors.push(`口吻参考 ${e.id} 没有正文一节`); continue; }
      refs.push({ id: e.id, version: e.current, title: e.title, ...voiceExcerpt(body, max) });
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { refs, errors };
}
