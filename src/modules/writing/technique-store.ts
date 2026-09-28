/**
 * 手法库（spec 2026-09-28 §3 C）。跟爆款拆解卡（pattern-store）是两个库：手法卡是可选打法，不是必须满足的结构。
 *
 * 两处来源，都只读 approved 目录，drafts 永不进写作包：
 * - 产品内置：本文件旁的 techniques/approved/*.json，只收书籍卡（随产品发给所有用户）；
 * - 资料目录：getDataDir()/techniques/approved/*.json（工作区数据目录，默认工作区是 ~/AutoCrew资料库/workspaces/default/，
 *   不是资料库根目录），可以放创始人经验卡（作用范围只限这个资料目录）。
 * 卡片有稳定 id + 整数 version；写作包冻结整份目录，交稿时 technique_ids 按冻结版本校验。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getDataDir } from "../../storage/local-store.js";
import { digest } from "./series-memory.js";

const line = Type.String({ minLength: 1, maxLength: 2000 });
export const ILLUSTRATION_LABEL = "示意，不是事实材料" as const;

export const techniqueCardSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,79}$" }),
  version: Type.Integer({ minimum: 1 }),
  name: line,
  /** 主要解决什么：开头 / 推进 / 收尾 / 撑长度 / 讲透区别…… */
  purpose: line,
  source: Type.Union([
    Type.Object({
      kind: Type.Literal("book"),
      title: line, author: line, edition: line,
      /** 能核对的位置（章节、页码）。只有书名不算核对过出处。 */
      location: line,
    }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal("founder_experience"),
      /** 来自哪段创始人历史改稿 / 哪条原规则 */
      origin: line,
      /** 首版只限所在资料目录，不随产品发给所有用户 */
      scope: Type.Literal("library"),
    }, { additionalProperties: false }),
  ]),
  verification: Type.Object({
    /** 创始人批准时的核对状态，原样保留，不因批准而改成「已核」 */
    status: Type.Union([Type.Literal("已核"), Type.Literal("部分待核")]),
    note: line,
    links: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 }),
  }, { additionalProperties: false }),
  fits: line,
  notFor: line,
  moves: Type.Array(line, { minItems: 1, maxItems: 10 }),
  illustration: Type.Object({ label: Type.Literal(ILLUSTRATION_LABEL), text: line }, { additionalProperties: false }),
  misuse: Type.Array(line, { minItems: 1, maxItems: 10 }),
  pairing: line,
}, { additionalProperties: false });
export type TechniqueCard = Static<typeof techniqueCardSchema>;
export interface TechniqueCatalog { version: string; cards: TechniqueCard[] }

const BUNDLED_APPROVED = path.join(path.dirname(fileURLToPath(import.meta.url)), "techniques", "approved");

async function readDir(dir: string, origin: "bundled" | "library"): Promise<TechniqueCard[]> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const cards: TechniqueCard[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    if (!Value.Check(techniqueCardSchema, raw)) throw new Error(`invalid_approved_technique: ${origin}/${name}`);
    // 创始人经验卡不随产品发给所有用户：内置目录里出现就是打包错误
    if (origin === "bundled" && raw.source.kind !== "book") throw new Error(`founder_card_in_bundle: ${name}`);
    cards.push(raw);
  }
  return cards;
}

/** 已审目录（内置书籍卡 + 本资料目录的卡），按 id、version 排序；同一 id+version 重复即报错。 */
export async function techniqueCatalog(dataDir?: string, bundledDir = BUNDLED_APPROVED): Promise<TechniqueCatalog> {
  const all = [
    ...(await readDir(bundledDir, "bundled")),
    ...(await readDir(path.join(getDataDir(dataDir), "techniques", "approved"), "library")),
  ].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
  for (let i = 1; i < all.length; i++) {
    if (all[i].id === all[i - 1].id && all[i].version === all[i - 1].version) throw new Error(`duplicate_technique_version: ${all[i].id}@${all[i].version}`);
  }
  return { version: digest(all.map((c) => [c.id, c.version])), cards: all };
}

/** 写作包里每张卡一行 */
export function catalogLines(catalog: TechniqueCatalog | undefined): string {
  if (!catalog?.cards.length) return "暂无已审手法卡。";
  return catalog.cards.map((c) => `- ${c.id}@v${c.version}「${c.name}」：${c.purpose}（适合：${c.fits.slice(0, 80)}）`).join("\n");
}

export function findCard(catalog: TechniqueCatalog | undefined, id: string, version: number): TechniqueCard | null {
  return catalog?.cards.find((c) => c.id === id && c.version === version) ?? null;
}
