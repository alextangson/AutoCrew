/**
 * 拦截判定（spec §6 + §12-1 / §12-8）：纯函数。「成片通过」只在当前成片有一条指纹匹配的 clean 结果、
 * 或所有缝已逐处放行、或检查没跑成且创始人整条放行时才允许。没有结果一律拦（E20）。
 */
import type { ProductionDoc, Sliver, SliverCheck } from "../../../storage/production-types.js";

export const NO_RESULT = "抽帧检查还没有结果";
export const sliverKey = (s: Pick<Sliver, "start_frame" | "end_frame" | "prev_item" | "next_item">) => `${s.start_frame}-${s.end_frame}-${s.prev_item}-${s.next_item}`;

export interface Verdict { ok: boolean; missing?: string; check: SliverCheck | null; open: Sliver[]; wholeWaived: boolean; wholeWaivable: boolean }

/** 本轮这版成片最近一条检查 */
export function latestCheck(doc: ProductionDoc, cutSha: string): SliverCheck | null {
  return [...(doc.sliver_checks ?? [])].reverse().find((c) => c.round === doc.round && c.cut_sha === cutSha) ?? null;
}

export function sliverWaived(doc: ProductionDoc, cutSha: string, fingerprint: string, s: Sliver): boolean {
  const key = sliverKey(s);
  return doc.decisions.some((d) => d.type === "sliver_waive" && d.round === doc.round && d.sha256 === cutSha && d.fingerprint === fingerprint && d.sliver_key === key);
}

/** `fingerprint`：服务端重算的当前输入指纹（批准时）；null = 只看已存的最近结果（推导 / 展示） */
export function sliverVerdict(doc: ProductionDoc, cutSha: string, fingerprint: string | null): Verdict {
  let check = latestCheck(doc, cutSha);
  if (check && fingerprint !== null && check.fingerprint !== fingerprint) check = null;
  const wholeWaived = doc.decisions.some((d) => d.type === "sliver_waive_all" && d.round === doc.round && d.sha256 === cutSha);
  const base = { check, open: [] as Sliver[], wholeWaived, wholeWaivable: !check || check.status === "unchecked" };
  // 整条放行只对「没跑成 / 没结果」有效（E13）：之后真查出了缝，照样逐处看
  if (!check) return wholeWaived ? { ...base, ok: true } : { ...base, ok: false, missing: NO_RESULT };
  if (check.status === "clean") return { ...base, ok: true };
  if (check.status === "unchecked") return wholeWaived ? { ...base, ok: true } : { ...base, ok: false, missing: `抽帧检查没跑成：${check.reason ?? "原因不明"}` };
  const open = check.slivers.filter((s) => !sliverWaived(doc, cutSha, check!.fingerprint, s));
  return open.length ? { ...base, open, ok: false, missing: `抽帧缝 ${open.length} 处` } : { ...base, open, ok: true };
}
