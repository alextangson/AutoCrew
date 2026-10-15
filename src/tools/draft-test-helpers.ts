/** autocrew_draft 测试共用：新流程立意之后先选开头（spec 2026-10-15 §7），否则第一版全文会被拒 */
type Run = (action: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

export const OPENINGS = ["你让 AI 写周报，它交回来一份你自己都不认识的周报。", "上周我省下了三个小时，下周又全没了。", "1200 个职场人里，37% 每天用 AI 写周报。"];

export async function pickOpening(run: Run, contentId: string, version: number, chosen = OPENINGS[1]): Promise<void> {
  const c = await run("opening", { content_id: contentId, base_version: version, candidates: OPENINGS });
  if (!c.ok) throw new Error(`opening candidates 失败：${JSON.stringify(c)}`);
  const p = await run("opening", { content_id: contentId, base_version: version, opening: chosen, founder_words: "第二个" });
  if (!p.ok) throw new Error(`opening pick 失败：${JSON.stringify(p)}`);
}
