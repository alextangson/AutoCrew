/**
 * 口吻参考 voice_refs（spec 2026-10-15 §8、§15.1、§16）：只管「他怎么说话」（用词、句子长短、口头习惯），不管怎么写，
 * 也不能拿来证明亲历——亲历只认 firsthand（他的原话 + 本选题的真实转写）。
 * - 主体：他自己念出来的转写，成片优先；只有原片的标「原片，非发布版」。
 * - 补充：他认可过的 AI 稿，标「AI 起草、你认可」。
 * 每段整句收尾地节选，不让一篇长转写吃掉全部预算。
 */
import type { OwnMaterialChunk } from "../research/own-material.js";
import type { FounderTranscript } from "./transcripts.js";
import { libraryVoiceRefs } from "../exemplar/voice.js";

export const VOICE_REF_LABEL = "口吻参考，不是范文：只学他怎么说话，不学结构，不当亲历证据";
const TRANSCRIPTS_MAX = 2;
const PER_REF_CHARS = 3000;

/** 按整句节选（截在最后一个句末标点后），标明是节选 */
export function excerpt(text: string, max = PER_REF_CHARS): { text: string; excerpted: boolean } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, excerpted: false };
  const head = chars.slice(0, max).join("");
  const cut = Math.max(...["。", "！", "？", ".", "!", "?"].map((p) => head.lastIndexOf(p)));
  return { text: cut > max / 2 ? head.slice(0, cut + 1) : head, excerpted: true };
}

export interface VoiceRef { kind: "transcript" | "approved_ai_draft"; label: string; title: string; content_id: string; text: string; excerpted: boolean }

export function voiceRefs(transcripts: FounderTranscript[], approved: OwnMaterialChunk[], titles: Map<string, string>): VoiceRef[] {
  const seen = new Set<string>();
  const refs: VoiceRef[] = [];
  for (const t of transcripts) {
    if (refs.length >= TRANSCRIPTS_MAX || seen.has(t.content_id)) continue;
    seen.add(t.content_id);
    refs.push({ kind: "transcript", label: t.label, title: titles.get(t.content_id) ?? t.content_id, content_id: t.content_id, ...excerpt(t.text) });
  }
  const draft = approved.find((c) => c.kind === "approved_draft");
  if (draft) refs.push({ kind: "approved_ai_draft", label: "AI 起草、你认可（只当口吻参考）", title: draft.title, content_id: draft.contentId, ...excerpt(draft.text) });
  return refs;
}

export const LIBRARY_VOICE_LABEL = "口吻参考：创始人成片转写，不是范文";

/**
 * voice_refs 的来源顺序（§16、§17）：范文库里创始人发布成片的转写（voice_ref）优先取 2 篇；
 * 一篇都没有时才退回原片转写。认可过的 AI 稿另附一篇，标明 AI 起草。读坏的报进 errors。
 */
export async function voiceContext(seed: string, transcripts: { items: FounderTranscript[]; errors: string[] }, approved: OwnMaterialChunk[], titles: Map<string, string>, dataDir?: string): Promise<Record<string, unknown>> {
  const lib = await libraryVoiceRefs(seed, TRANSCRIPTS_MAX, PER_REF_CHARS, dataDir).catch((e: unknown) => ({ refs: [], errors: [`范文库里的口吻参考读不了：${e instanceof Error ? e.message : String(e)}`] }));
  const errors = [...lib.errors, ...transcripts.errors];
  if (lib.refs.length) {
    const ai = voiceRefs([], approved, titles);
    const refs = [...lib.refs.map((r) => ({ kind: "founder_final_cut", label: LIBRARY_VOICE_LABEL, title: r.title, id: r.id, version: r.version, text: r.text, excerpted: r.excerpted })), ...ai];
    return { label: LIBRARY_VOICE_LABEL, source: "library", refs, ...(errors.length ? { errors } : {}) };
  }
  return { label: VOICE_REF_LABEL, source: "raw_fallback", note: "范文库里还没有创始人成片转写：先用原片转写顶上", refs: voiceRefs(transcripts.items, approved, titles), ...(errors.length ? { errors } : {}) };
}
