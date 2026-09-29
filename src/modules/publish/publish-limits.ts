/**
 * 发布文本的平台上限与计数口径（纯函数，不读盘、不推状态）。
 *
 * 从 `tools/pre-publish.ts` 抽出（发布前把关 spec §5，Codex P2-10）：预检与 `autocrew_publish check`
 * 用同一份数字，check 不调旧执行器（旧执行器会推进状态）。
 *
 * 口径：
 * - 标题：加权计数（中文 1 字、英文数字半字、空格不计），上限见 `videoTitleLimit`；
 * - 文案：字符串长度（JS length），计入并进文案末尾的话题标签；抖音不设硬上限；
 * - 文案下限 20 字（与交发布包同一对上下限）。
 */
import { publishTitleChars, videoTitleLimit } from "./video-kit.js";

export const PLATFORM_MIN_BODY: Record<string, number> = {
  xiaohongshu: 200,
  xhs: 200,
  douyin: 100,
  wechat_mp: 800,
  wechat_video: 100,
  bilibili: 200,
};

/**
 * 发布文案上限（创始人裁定：短文案平台 ≤1000）。douyin 不设——body 是口播脚本；
 * 发布简介 ≤300 只是引擎 prompt 纪律（video-kit CAPTION_RULES），宿主发布包同样不设硬上限。
 */
export const PLATFORM_MAX_BODY: Record<string, number> = {
  xiaohongshu: 1000,
  xhs: 1000,
  wechat_video: 800,
  bilibili: 2000,
  wechat_mp: 3000,
};

/** 发布简介下限（P6 §3.6）。交包与预检用同一对上下限：交得进去就查得过 */
export const KIT_CAPTION_MIN = 20;

export function captionBounds(platform: string): [number, number | undefined] {
  return [KIT_CAPTION_MIN, PLATFORM_MAX_BODY[platform]];
}

/** 简介里已有的话题标签（#xxx；小红书的 #xxx[话题]# 也认） */
export function captionTags(caption: string): string[] {
  return (caption.match(/#[^\s#]+/g) ?? []).map((t) => t.slice(1).replace(/\[话题\]$/, "")).filter(Boolean);
}

/** 标签不在简介里等于没发——并到末尾，已有的不重复 */
export function mergeTags(caption: string, tags: string[]): string {
  const present = new Set(captionTags(caption));
  const missing = tags.filter((t) => !present.has(t));
  return missing.length > 0 ? `${caption}\n\n${missing.map((t) => `#${t}`).join(" ")}` : caption;
}

export interface TextRuleResult {
  field: "title" | "caption" | "tags";
  ok: boolean;
  /** 人话：计数、上限与口径 */
  detail: string;
}

/** 一个平台条目的标题 / 文案 / 标签按平台口径逐项判（check 与预检共用的数字） */
export function validatePublishText(platform: string, input: { title: string; caption: string; tags: string[] }): TextRuleResult[] {
  const out: TextRuleResult[] = [];
  const title = input.title.trim();
  const limit = videoTitleLimit(platform);
  const chars = publishTitleChars(title);
  if (!title) out.push({ field: "title", ok: false, detail: "没有标题" });
  else out.push({ field: "title", ok: chars <= limit, detail: `标题 ${chars} 字（加权计数：中文 1、英文数字半字、空格不计），${platform} 上限 ${limit}` });
  const badTags = input.tags.filter((t) => /[\s#]/.test(t.replace(/^#+/, "")));
  out.push(badTags.length
    ? { field: "tags", ok: false, detail: `标签「${badTags.join("」「")}」里有空格或 #，发出去会断开` }
    : { field: "tags", ok: true, detail: `${input.tags.length} 个标签（并进文案末尾，计入文案字数）` });
  const caption = mergeTags(input.caption.trim(), input.tags.map((t) => t.replace(/^#+/, "")).filter(Boolean));
  const [min, max] = captionBounds(platform);
  const cap = max === undefined ? `${platform} 不设硬上限` : `${platform} 上限 ${max}`;
  const ok = caption.length >= min && (max === undefined || caption.length <= max);
  out.push({ field: "caption", ok, detail: `文案 ${caption.length} 字（字符串长度，含并入的标签），下限 ${min}，${cap}` });
  return out;
}
