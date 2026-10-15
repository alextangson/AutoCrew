/**
 * 范文库（docs/2026-10-15-writing-exemplars-spec.md §2、§15.5、§16）共用的形状。
 * 存储：<dataDir>/exemplars/manifest.json（唯一提交点）+ <id>/v<N>.md（每版全文，只写一次，不覆盖）。
 * 范文只收对标爆款（§16）；创始人自己的转写不进这里，走 voice_refs。
 */
import { PLAYBOOK_IDS, type PlaybookId } from "../playbook/types.js";

/** exemplar = 完整逐字稿；structure_card = 只拆结构的长片；technique_card = 只学一个手法 */
export const EXEMPLAR_KINDS = ["exemplar", "structure_card", "technique_card"] as const;
export type ExemplarKind = (typeof EXEMPLAR_KINDS)[number];

/** 体裁：5 本手册之一，或 any（跨体裁的手法卡） */
export type ExemplarGenre = PlaybookId | "any";
export const isExemplarGenre = (v: unknown): v is ExemplarGenre =>
  v === "any" || (typeof v === "string" && (PLAYBOOK_IDS as readonly string[]).includes(v));

export interface ExemplarVersion {
  version: number;
  at: string;
  /** 全文 sha256 前 16 位：导入按它幂等 */
  hash: string;
  chars: number;
  title: string;
}

export interface ExemplarEntry {
  id: string;
  genre: ExemplarGenre;
  kind: ExemplarKind;
  title: string;
  current: number;
  versions: ExemplarVersion[];
}

export interface ExemplarManifest {
  schema: 1;
  exemplars: ExemplarEntry[];
}

/** 立意卡上实际引用、锁进稿子的范文 */
export interface ExemplarPin { id: string; version: number }

/** 写法一节（在技能文件里）的版本：内容 hash；每个版本的全文另存一份在资料库，续写时按它取 */
export interface MethodPin { version: string }

export class ExemplarError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export const EXEMPLAR_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
