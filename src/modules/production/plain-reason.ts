/**
 * 给创始人看的「为什么」（review-inbox 2a 真实数据验收）：只说人话，最多带一个文件名；
 * 不出现路径、版本目录名、规则名，也不出现「迁移」「准入」「原依据」这类开发者用词。
 */
import path from "node:path";
import type { Fact } from "../../storage/production-types.js";
import { admittedGroupKey } from "./cover-groups.js";

const FOLDER_NAMES: Record<string, string> = { exports: "导出", export: "导出", final: "定稿", qa: "质检", review: "审阅" };

/** 文件夹的名字（说人话）：exports → 导出；vNNN → 旧版本；其他照原名 */
export function folderName(rel: string | undefined): string {
  const dir = rel ? path.basename(path.dirname(rel)) : "";
  if (!dir || dir === "." || dir === "05-cover") return "封面";
  if (/^v\d+$/i.test(dir)) return "旧版本";
  if (/^review-/i.test(dir)) return "审阅";
  return FOLDER_NAMES[dir.toLowerCase()] ?? dir;
}

/**
 * 项目里、正式封面文件夹（vNNN/、final/）以外的封面图：多半是做封面过程中的中间文件（缩略图、质检图）。
 * 它们不是创始人要拍板的事——只在卡片上收成一行「以前的封面文件 N 张」。
 */
export function isStrayCover(f: Fact): boolean {
  return f.kind === "cover" && f.state === "candidate" && (f.source === "migration" || (Boolean(f.path) && !path.isAbsolute(f.path!) && !admittedGroupKey(f.path)));
}

export const strayCoverReason = (rel: string | undefined) => `在『${folderName(rel)}』文件夹里找到的，不在正式封面文件夹`;

/** 候选「为什么」的一句人话 */
export function plainReason(f: Fact): string {
  if (f.kind === "cover" && f.path && !path.isAbsolute(f.path) && !admittedGroupKey(f.path)) return strayCoverReason(f.path);
  // 只看依据的第一句（这条为什么是候选）；后面「前三名」里别条稿的标题不能拿来判（verifier 2a P3）
  const e = (f.evidence ?? "").split(/[；;]|前三名/)[0];
  if (/转写|开头说|听起来/.test(e)) return "开头说的话和这条稿对上了";
  if (/文件名|前缀|对上标题/.test(e)) return "文件名和标题对上了";
  if (/可搬入目录之外|不会自动/.test(e)) return "放在 AutoCrew 不会自动收的文件夹里，要你确认";
  if (/收件箱/.test(e)) return "在原片收件箱里找到的";
  if (/导出/.test(e)) return "剪辑软件导出的";
  return "要你确认是不是这条";
}

/** 量词：封面一张、字幕一份、原片 / 成片一段 */
export const measure = (kind: Fact["kind"], n = 1): string => {
  const w = kind === "cover" ? "张" : kind === "srt" ? "份" : "段";
  return n === 1 ? `一${w}` : `${n} ${w}`;
};

export const KIND_NAME: Record<string, string> = { aroll: "原片", cut: "成片", srt: "字幕", cover: "封面" };

export const fileName = (p: string | undefined) => (p ? path.basename(p) : "");
