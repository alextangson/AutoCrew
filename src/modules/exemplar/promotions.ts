/**
 * 改稿意见升级成「范文批注」或「写法」的提案（spec 2026-10-15 §6、§15.6、§15.8）。
 * 存 <dataDir>/exemplars/promotions.json，进「等你拍板」。批准后（§15.8）：
 * - 范文批注：同一个队列里给那篇范文生成新版本（批注追加在末尾），再记提案状态 applied；
 * - 写法：写法在仓库技能文件里，不自动改；在资料库生成一份可审阅的补丁，状态 approved_pending_release，
 *   在「等你拍板」里显示「已批，等发布」；技能文件里有证据说明它已合进去（折入标记或改动全文）后，自动转 released 并消失。
 * 手册骨架的升级不走这里，走手册提案。
 * 文件读坏了 = 可见错误，不当成没有提案、不覆盖。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { contentHash, exemplarsDir, putInQueue, readExemplarManifest, readExemplarText, serializeExemplars } from "./store.js";
import { writeTextAtomicMkdir } from "../../storage/json-atomic.js";
import { getDataDir } from "../../storage/local-store.js";
import { SKILL_FILE, methodSection } from "./method.js";
import { ExemplarError } from "./types.js";

export type PromotionTarget = "exemplar" | "method";
export type PromotionStatus = "pending" | "applied" | "approved_pending_release" | "released" | "rejected";

export interface PromotionCite { content_id: string; index: number; founder_words: string }
export interface Promotion {
  id: string;
  target: PromotionTarget;
  /** target=exemplar：给哪篇范文加批注 */
  exemplar_id?: string;
  /** 批注（改前 → 改后片段）或写法的改动全文 */
  text: string;
  reason: string;
  cites: PromotionCite[];
  status: PromotionStatus;
  gen: string;
  at: string;
  decided_at?: string;
  founder_words?: string;
  /** applied：生成的范文版本 */
  exemplar_version?: number;
  /** approved_pending_release：补丁文件（相对数据目录） */
  patch_file?: string;
  /** released：在技能文件里找到合入证据的时间和依据 */
  released_at?: string;
  released_evidence?: "marker" | "text";
}
interface PromotionFile { schema: 1; items: Promotion[] }

const file = (dataDir?: string) => path.join(exemplarsDir(dataDir), "promotions.json");

export async function readPromotions(dataDir?: string): Promise<Promotion[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file(dataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ExemplarError("promotions_unreadable", `升级提案读不了：${(e as Error).message}`);
  }
  try {
    const f = JSON.parse(raw) as PromotionFile;
    if (f?.schema !== 1 || !Array.isArray(f.items)) throw new Error("结构不对");
    return f.items;
  } catch (e) {
    throw new ExemplarError("promotions_corrupt", `升级提案 ${file(dataDir)} 解析失败（${(e as Error).message}）：没有覆盖它`);
  }
}

const write = async (items: Promotion[], dataDir?: string) => { assertDataDirWritable(dataDir); await writeJsonAtomicMkdir(file(dataDir), { schema: 1, items }); };

export interface PromotionInput { target: PromotionTarget; exemplar_id?: string; text: string; reason: string; cites: PromotionCite[] }

/** 记一份提案：同样的待批 = duplicate；否决过的同文 = blocked_by_rejected */
export function proposePromotion(x: PromotionInput, dataDir?: string): Promise<{ outcome: "proposed" | "duplicate" | "blocked_by_rejected"; id: string }> {
  return serializeExemplars(dataDir, async () => {
    const items = await readPromotions(dataDir);
    const same = items.find((p) => p.target === x.target && p.exemplar_id === x.exemplar_id && p.text.trim() === x.text.trim() && (p.status === "pending" || p.status === "rejected"));
    if (same?.status === "rejected") return { outcome: "blocked_by_rejected" as const, id: same.id };
    if (same) return { outcome: "duplicate" as const, id: same.id };
    const id = `wp-${randomUUID()}`;
    const p: Promotion = { id, target: x.target, ...(x.exemplar_id ? { exemplar_id: x.exemplar_id } : {}), text: x.text.trim(), reason: x.reason, cites: x.cites,
      status: "pending", gen: contentHash(JSON.stringify([id, x.text])), at: new Date().toISOString() };
    await write([...items, p], dataDir);
    return { outcome: "proposed" as const, id };
  });
}

export const patchRel = (id: string) => path.join("exemplars", "method-patches", `${id}.md`);

function annotated(text: string, p: Promotion, words: string, at: string): string {
  const cites = p.cites.map((c) => `${c.content_id}#${c.index}「${c.founder_words}」`).join("；");
  return `${text.replace(/\s+$/, "")}\n\n## 追加批注（${at.slice(0, 10)} 创始人批准：「${words}」）\n\n- ${p.text}\n  - 出处：${cites}\n`;
}

function patchText(p: Promotion, words: string, at: string): string {
  return [`# 写法改动补丁 ${p.id}`, "", `- 批准：${at}，创始人原话「${words}」`, `- 为什么：${p.reason}`,
    `- 出处：${p.cites.map((c) => `${c.content_id}#${c.index}「${c.founder_words}」`).join("；")}`,
    "- 状态：已批，等发布（改 skills/write-script/SKILL.md 的写法一节、随代码发布后才生效）", "", "## 改动", "", p.text, ""].join("\n");
}

/** 批准落地：范文 → 新版本；写法 → 补丁文件。返回要并进提案的字段 */
async function land(p: Promotion, words: string, at: string, dataDir?: string): Promise<Partial<Promotion>> {
  if (p.target === "exemplar") {
    const m = await readExemplarManifest(dataDir);
    const e = m.exemplars.find((x) => x.id === p.exemplar_id);
    if (!e) throw new ExemplarError("not_found", `范文库里已经没有 ${String(p.exemplar_id)}：批不了，告诉创始人`);
    // 上次已经生成了版本、只是没来得及记提案状态：只补状态，不再追加一遍批注
    const done = e.versions.find((v) => v.promotion_id === p.id);
    if (done) return { status: "applied", exemplar_version: done.version };
    const text = await readExemplarText(e.id, e.current, dataDir, m);
    const r = await putInQueue({ id: e.id, genre: e.genre, kind: e.kind, title: e.title, text: annotated(text, p, words, at), promotion_id: p.id }, dataDir);
    return { status: "applied", exemplar_version: r.version };
  }
  assertDataDirWritable(dataDir);
  await writeTextAtomicMkdir(path.join(getDataDir(dataDir), patchRel(p.id)), patchText(p, words, at));
  return { status: "approved_pending_release", patch_file: patchRel(p.id) };
}

/** 创始人批 / 不要。gen 对不上 = 内容变过；已定过 = already_handled。落地和状态在同一个队列里，失败就不改状态 */
export function decidePromotion(id: string, gen: string, decision: "approve" | "reject", founderWords: string, dataDir?: string): Promise<Promotion> {
  return serializeExemplars(dataDir, async () => {
    const items = await readPromotions(dataDir);
    const p = items.find((x) => x.id === id);
    if (!p) throw new ExemplarError("not_found", `没有这份升级提案：${id}`);
    if (p.status !== "pending") throw new ExemplarError("already_handled", "这份升级提案已经定过了");
    if (p.gen !== gen) throw new ExemplarError("stale", "提案内容和你给创始人看的对不上：重新 list 再给他看");
    const at = new Date().toISOString();
    const landed: Partial<Promotion> = decision === "approve" ? await land(p, founderWords, at, dataDir) : { status: "rejected" };
    Object.assign(p, landed, { decided_at: at, founder_words: founderWords });
    await write(items, dataDir);
    return p;
  });
}

/** 技能文件里的折入标记：<!-- promotion-folded: wp-a wp-b -->，人工合补丁时写上（措辞改过也能认） */
const FOLDED_RE = /<!--\s*promotion-folded:([^>]*)-->/g;
const norm = (t: string) => t.replace(/[\s\p{P}\p{S}]/gu, "");

/** 这份已批写法有没有合进技能的证据：标记里有它的 id，或改动全文（去掉空白和标点）原样在「写法」一节里。没有证据 = null */
export function releaseEvidence(p: Promotion, skill: string): "marker" | "text" | null {
  for (const m of skill.matchAll(FOLDED_RE)) if (m[1].split(/[\s,，]+/).includes(p.id)) return "marker";
  let section: string;
  try { section = methodSection(skill); } catch { return null; }
  const t = norm(p.text);
  return t.length > 0 && norm(section).includes(t) ? "text" : null;
}

/** 已批等发布的写法：技能文件里找到合入证据的转 released。技能文件读不了 = 抛错，不当成没合 */
export function releaseFoldedPromotions(dataDir?: string, skillFile = SKILL_FILE): Promise<Promotion[]> {
  return serializeExemplars(dataDir, async () => {
    const items = await readPromotions(dataDir);
    const waiting = items.filter((p) => p.status === "approved_pending_release");
    if (waiting.length === 0) return [];
    let skill: string;
    try { skill = await fs.readFile(skillFile, "utf8"); } catch (e) { throw new ExemplarError("method_unreadable", `write-script 技能读不了，判断不了写法补丁有没有生效：${(e as Error).message}`); }
    const at = new Date().toISOString();
    const released: Promotion[] = [];
    for (const p of waiting) {
      const ev = releaseEvidence(p, skill);
      if (!ev) continue;
      Object.assign(p, { status: "released", released_at: at, released_evidence: ev });
      released.push(p);
    }
    if (released.length > 0) await write(items, dataDir);
    return released;
  });
}
