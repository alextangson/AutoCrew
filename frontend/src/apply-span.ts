/** 把改写后的段落替换回正文的选区 [start, end)。收下选段修改时用。 */
export function applySpan(body: string, start: number, end: number, span: string): string {
  return body.slice(0, start) + span + body.slice(end);
}
