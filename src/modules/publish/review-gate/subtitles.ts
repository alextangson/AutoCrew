/**
 * Jev A 的比对底稿（spec §8、E9）：登记成片的字幕（与成片 sha 绑定）；没有登记字幕就用定稿正文并写明。
 * 超预算只比对前段，写明「只比对了前 N 分钟」——此时 A2 的「不支持」只算「未覆盖」。
 */
import fs from "node:fs/promises";

/** 中文约 1 token/字；Jev 的 state + 最长问题上限 32k token，留足问题与字段的余量 */
export const SUBTITLE_CHAR_BUDGET = 12_000;

export interface Basis { kind: "srt" | "draft"; text: string; truncated: boolean; note: string }

const TIME = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

export function srtCues(srt: string): Array<{ endMs: number; text: string }> {
  const cues: Array<{ endMs: number; text: string }> = [];
  for (const block of srt.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => TIME.test(l));
    if (at < 0) continue;
    const m = TIME.exec(lines[at])!;
    const endMs = ((Number(m[5]) * 60 + Number(m[6])) * 60 + Number(m[7])) * 1000 + Number(m[8]);
    const text = lines.slice(at + 1).join(" ");
    if (text) cues.push({ endMs, text });
  }
  return cues;
}

export function basisFromSrt(srt: string, budget = SUBTITLE_CHAR_BUDGET): Basis {
  const cues = srtCues(srt);
  let text = "", lastEnd = 0, truncated = false;
  for (const c of cues) {
    if (text.length + c.text.length + 1 > budget) { truncated = true; break; }
    text += (text ? "\n" : "") + c.text;
    lastEnd = c.endMs;
  }
  const minutes = Math.max(1, Math.round(lastEnd / 60_000));
  return { kind: "srt", text, truncated, note: truncated ? `字幕太长，只比对了前 ${minutes} 分钟` : "按登记成片的字幕比对" };
}

export function basisFromDraft(body: string, budget = SUBTITLE_CHAR_BUDGET): Basis {
  const truncated = body.length > budget;
  return { kind: "draft", text: truncated ? body.slice(0, budget) : body, truncated, note: `没有登记字幕，用定稿正文比对${truncated ? `（只比对了前 ${budget} 字）` : ""}` };
}

export async function loadBasis(srtPath: string | null, draftBody: string): Promise<Basis> {
  if (!srtPath) return basisFromDraft(draftBody);
  try { return basisFromSrt(await fs.readFile(srtPath, "utf8")); } catch (e) {
    const draft = basisFromDraft(draftBody);
    return { ...draft, note: `登记字幕读不了（${(e as NodeJS.ErrnoException).code ?? "未知错误"}），改用定稿正文比对` };
  }
}
