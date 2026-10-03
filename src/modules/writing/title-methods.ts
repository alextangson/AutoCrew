/**
 * 发布标题方法库的指引与校验（docs/2026-10-03-title-methods-spec.md §五）。
 *
 * 标题由宿主模型按方法库写；代码只拦能机器判断的：方法 id 不在库里、3 个候选不分属 3 个不同类。
 * 标题里的阿拉伯数字在正文找不到只提示不拦（§七.4）。模型参数不可信：先规范化（JSON 字符串、大小写、中文方法名）再判。
 */
import { maybeJson, UNPARSABLE } from "../publish/review-gate/plan.js";
import {
  PLATFORM_TITLE_TONE, TITLE_CATEGORIES, TITLE_CHECKLIST, TITLE_CORE_THINKING, TITLE_METHODS, TITLE_RED_LINE,
  type TitleMethod,
} from "./title-method-library.js";

/** 创始人自己写的标题：不算进任何方法 */
export const SELF_WRITTEN = "自拟";

export interface TitleCandidate {
  title: string;
  method: string;
  reason: string;
}

export interface TitleChoice {
  candidates: TitleCandidate[];
  method: string;
}

export function titleMethodIds(): string[] {
  return TITLE_METHODS.map((m) => m.id);
}

export function findTitleMethod(id: string): TitleMethod | undefined {
  return TITLE_METHODS.find((m) => m.id === id);
}

export function categoryName(id: string): string {
  return TITLE_CATEGORIES.find((c) => c.id === id)?.name ?? id;
}

/** 方法 id 规范化：去空白、大小写、下划线 / 空格当连字符；中文方法名也认。认不出回 null */
export function normalizeMethodId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if (t === SELF_WRITTEN) return SELF_WRITTEN;
  const slug = t.toLowerCase().replace(/[\s_]+/g, "-");
  return TITLE_METHODS.find((m) => m.id === slug || m.name === t)?.id ?? null;
}

const idListText = () => titleMethodIds().join(" / ");

type Failure = { field: string; detail: string };

function readCandidate(raw: unknown, i: number, failures: Failure[]): TitleCandidate | null {
  const v = maybeJson(raw);
  const obj = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const field = `title_candidates[${i}]`;
  if (!obj) { failures.push({ field, detail: "每个候选要是 {title, method, reason}" }); return null; }
  const text = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string).trim() : "");
  const method = normalizeMethodId(obj.method);
  if (!text("title")) failures.push({ field, detail: "候选缺 title" });
  if (!text("reason")) failures.push({ field, detail: "候选缺一句选这个方法的理由 reason" });
  if (!method || method === SELF_WRITTEN) {
    failures.push({ field, detail: `方法 id「${String(obj.method ?? "")}」不在方法库里，可用：${idListText()}` });
    return null;
  }
  return { title: text("title"), method, reason: text("reason") };
}

function readCandidates(raw: unknown, failures: Failure[]): TitleCandidate[] {
  const v = maybeJson(raw);
  if (v === UNPARSABLE || !Array.isArray(v)) {
    const got = v === undefined ? "缺" : v === UNPARSABLE ? "解析不了的 JSON" : "不是数组";
    failures.push({ field: "title_candidates", detail: `title_candidates ${got}：要 3 个四平台通用候选 [{title, method, reason}]，分属 3 个不同类` });
    return [];
  }
  if (v.length !== 3) {
    failures.push({ field: "title_candidates", detail: `要正好 3 个候选（收到 ${v.length} 个）；都不满意就再出 3 个，或由创始人自己写（title_method="${SELF_WRITTEN}"）` });
  }
  const parsed = v.map((c, i) => readCandidate(c, i, failures));
  if (parsed.some((c) => c === null)) return [];
  const list = parsed as TitleCandidate[];
  const cats = new Set(list.map((c) => findTitleMethod(c.method)!.category));
  if (list.length === 3 && cats.size !== 3) {
    const used = list.map((c) => `${c.method}（${categoryName(findTitleMethod(c.method)!.category)}）`).join("、");
    failures.push({ field: "title_candidates", detail: `3 个候选必须分属 3 个不同类，现在是：${used}` });
  }
  return list;
}

/** 校验 kit 里的标题来源：3 个通用候选 + 这个平台最终用的方法 id（或「自拟」） */
export function validateTitleChoice(candidatesRaw: unknown, methodRaw: unknown): { failures: Failure[]; choice: TitleChoice } {
  const failures: Failure[] = [];
  const candidates = readCandidates(candidatesRaw, failures);
  const method = normalizeMethodId(methodRaw);
  if (!method) {
    const got = typeof methodRaw === "string" && methodRaw.trim() ? `「${methodRaw.trim()}」不在方法库里` : "缺";
    failures.push({ field: "title_method", detail: `title_method ${got}：填这个平台标题用的方法 id，创始人自己写的填「${SELF_WRITTEN}」。可用：${idListText()}` });
  }
  return { failures, choice: { candidates, method: method ?? "" } };
}

/** 标题里的阿拉伯数字在正文里找不到：只提示（§七.4），提醒核对是否编了数 */
export function titleNumberWarnings(title: string, body: string): string[] {
  const nums = [...new Set(title.match(/\d+(?:\.\d+)?/g) ?? [])];
  const missing = nums.filter((n) => !body.includes(n));
  if (missing.length === 0) return [];
  return [`标题里的数字 ${missing.join("、")} 在正文里没找到（正文写成汉字数字的也会报）：确认它在定稿或证据台账里有依据，没有就换个不靠数字的方法。仅提示，不拦。`];
}

function methodLine(m: TitleMethod): string {
  const red = m.redLine?.length ? `；红线：${m.redLine.join("；")}` : "";
  return `- ${m.id}（${categoryName(m.category)}·${m.name}）：${m.formula}。为什么有效：${m.why}。适合：${m.fits}；不适合：${m.notFor}。例：${m.example}${red}`;
}

const FLOW = [
  "1. 先读稿，过一遍核心思维，确认写给档案里的哪位受众。",
  "2. 写 3 个四平台通用候选，分属 3 个不同类，各标方法 id 和一句选它的理由；摆给创始人挑。",
  `3. 都不满意：再出 3 个，或创始人自己写（title_method 填「${SELF_WRITTEN}」）。`,
  "4. 按平台字数和语气把选中的那个落成 post_title；在候选上改几个字仍记原方法 id；四个平台各自记各自的方法 id。",
  "5. 稿件太短太空撑不起有张力的标题：直接说内容撑不起，不硬凑。",
];

/** 给宿主看的完整方法库指引；带 platform 时附上该平台语气 */
export function titleMethodGuide(platform?: string): string {
  const tone = platform && PLATFORM_TITLE_TONE[platform] ? [`本平台语气：${PLATFORM_TITLE_TONE[platform]}`] : Object.entries(PLATFORM_TITLE_TONE).map(([p, t]) => `${p}：${t}`);
  return [
    "【发布标题方法库】", "核心思维：", ...TITLE_CORE_THINKING.map((t) => `- ${t}`),
    "流程：", ...FLOW, "方法：", ...TITLE_METHODS.map(methodLine),
    "检验清单（每个候选都过一遍）：", ...TITLE_CHECKLIST.map((t) => `- ${t}`),
    "真实性红线：", ...TITLE_RED_LINE.map((t) => `- ${t}`),
    "平台语气（字数上限以工具说明为准）：", ...tone.map((t) => `- ${t}`),
  ].join("\n");
}
