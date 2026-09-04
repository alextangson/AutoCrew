/**
 * 口播格式硬门（P1 spec §4.4 / codex #22）——四字段任一出现镜头/字幕/画面标注即打回。
 *
 * 为什么不挂在赛道包上：抖音包没有 `qualityGate`，包级门禁对它是空操作，模型照样交「[画面] + [口播]」的
 * 分镜表。这道门**与包无关**，由调用方按「这稿是不是纯口播」显式打开（`forbidFormatMarkers`）。
 *
 * 判定口径：括号里以舞台指令词开头的标记 + 少量裸词（B-roll、镜头一）。
 * 只认括号开头是为了不误伤「这个画面感很强」这种正常行文；`[IMAGE: …]`（长文配图标记）
 * 与 `[未证实]`（数字诊断标记）不在词表里，不会被误杀。
 */
import type { ScriptFields, ScriptField } from "./number-gate.js";

export interface FormatMarkerHit {
  field: ScriptField;
  /** 命中的原文标记（超长截断） */
  marker: string;
  /** 归类：bracket = 括号舞台指令，bare = 裸词 */
  kind: "bracket" | "bare";
  index: number;
  context: string;
}

/** 括号内以这些词开头 = 舞台指令 */
const STAGE_KEYWORDS = [
  "画面", "字幕条", "字幕", "口播", "镜头", "分镜", "切", "停顿", "强调", "慢", "快",
  "音效", "配乐", "BGM", "B-roll", "Broll", "空镜", "特写", "近景", "中景", "远景", "全景",
  "转场", "插入", "旁白", "同期声", "花字", "贴纸", "运镜", "推近", "拉远",
];

const OPENERS: ReadonlyArray<readonly [string, string]> = [
  ["[", "]"],
  ["【", "】"],
  ["（", "）"],
  ["(", ")"],
  ["〔", "〕"],
];

const BARE_PATTERNS: RegExp[] = [
  /B\s*-?\s*roll/gi,
  /镜头\s*[一二三四五六七八九十]+/g,
  /镜头\s*\d+/g,
  /分镜\s*[一二三四五六七八九十\d]+/g,
];

const MAX_MARKER_CHARS = 40;

function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function truncate(marker: string): string {
  return marker.length <= MAX_MARKER_CHARS ? marker : `${marker.slice(0, MAX_MARKER_CHARS)}…`;
}

/** 单字/短指令词歧义大（切实、快手），只在括号内容很短时才当舞台指令 */
const SHORT_ONLY = new Set(["切", "慢", "快", "停顿", "强调"]);

function startsWithStageKeyword(inner: string): boolean {
  const head = inner.replace(/^[\s:：]+/, "");
  return STAGE_KEYWORDS.some((kw) => {
    if (!head.toLowerCase().startsWith(kw.toLowerCase())) return false;
    return SHORT_ONLY.has(kw) ? head.length <= 6 : true;
  });
}

function scanBrackets(field: ScriptField, text: string): FormatMarkerHit[] {
  const hits: FormatMarkerHit[] = [];
  for (let i = 0; i < text.length; i++) {
    const opener = OPENERS.find(([open]) => text[i] === open);
    if (!opener) continue;
    const close = text.indexOf(opener[1], i + 1);
    if (close === -1) continue;
    const inner = text.slice(i + 1, close);
    if (inner.length === 0 || !startsWithStageKeyword(inner)) continue;
    const marker = text.slice(i, close + 1);
    hits.push({
      field, marker: truncate(marker), kind: "bracket", index: i,
      context: contextAround(text, i, marker.length),
    });
    i = close;
  }
  return hits;
}

function scanBare(field: ScriptField, text: string): FormatMarkerHit[] {
  const hits: FormatMarkerHit[] = [];
  for (const pattern of BARE_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      hits.push({
        field, marker: truncate(m[0]), kind: "bare", index: m.index,
        context: contextAround(text, m.index, m[0].length),
      });
    }
  }
  return hits;
}

/** 四字段全扫，按字段顺序 + 位置排序（反馈稳定，便于测试与人读） */
export function findFormatMarkers(fields: ScriptFields): FormatMarkerHit[] {
  const out: FormatMarkerHit[] = [];
  for (const field of ["title", "hook", "body", "cta"] as const) {
    const text = fields[field];
    const hits = [...scanBrackets(field, text), ...scanBare(field, text)];
    // 同一位置可能既被括号规则又被裸词规则命中（如 `[B-roll: …]`），去重保留括号那条
    const seen = new Set<number>();
    for (const hit of hits.sort((a, b) => a.index - b.index || (a.kind === "bracket" ? -1 : 1))) {
      const overlapped = [...seen].some((start) => Math.abs(start - hit.index) <= 2);
      if (overlapped) continue;
      seen.add(hit.index);
      out.push(hit);
    }
  }
  return out;
}

const FIELD_LABEL: Record<ScriptField, string> = { title: "标题", hook: "钩子", body: "正文", cta: "结尾" };

export function formatFormatGateFeedback(hits: FormatMarkerHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => `- 「${h.marker}」（${FIELD_LABEL[h.field]}）：${h.context}`);
  return (
    `口播格式硬门未通过：这是纯口播正文，不写画面/字幕条/镜头标注。以下 ${hits.length} 处要去掉：\n` +
    `${lines.join("\n")}\n` +
    `改法：删掉标记本身；标记里的信息如果对听众有用，用能读出口的句子写进正文，读不出口的（运镜、字幕样式）直接不要。\n` +
    `修好后重新调用 submit_script 提交完整成稿（全文重交，不是只交修改段）。`
  );
}
