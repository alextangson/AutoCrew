/**
 * 正文插图位置 = 正文里的 [IMAGE: …] 标记。这里是对标记的纯操作(加/删)，
 * 供 article_images:add_slot / remove_slot 复用；AI 选位在 suggest-images.ts。
 */
const MARKER_RE = /\[IMAGE:\s*[^\]]*\]/g;

export const DEFAULT_IMAGE_PROMPT = "具体场景、主体、构图、光线、色彩；不要文字和水印";

export function countImageMarkers(body: string): number {
  return (body.match(MARKER_RE) ?? []).length;
}

/** 在正文末尾追加一个插图位(占位)。精确位置由用户后续拖动/AI 选位负责。 */
export function addImageMarker(body: string, prompt: string = DEFAULT_IMAGE_PROMPT): string {
  const clean = body.replace(/\s+$/, "");
  return `${clean}\n\n[IMAGE: ${prompt.trim() || DEFAULT_IMAGE_PROMPT}]\n`;
}

/** 删除第 index 个(0 基)插图位标记；越界原样返回。清理多余空行。 */
export function removeImageMarker(body: string, index: number): string {
  const matches = [...body.matchAll(MARKER_RE)];
  const m = matches[index];
  if (!m || m.index === undefined) return body;
  const next = body.slice(0, m.index) + body.slice(m.index + m[0].length);
  return next.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/\s+$/, "") + "\n";
}
