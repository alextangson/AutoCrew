/**
 * 英文发布包的前提和上下文：脚本已批、配音清单按这份脚本做的（approved.ts）；片长取清单里配音的结尾；
 * 缩略图还是登记那张。包要绑住脚本指纹和清单指纹，之后任何一样变了，check 按过期拦。
 */
import { createHash } from "node:crypto";
import { approvedEnState, currentEnManifest, type Refusal } from "./approved.js";
import { readEnThumbnail, thumbnailProblem } from "./thumbnail.js";
import type { EnKitContext } from "../publish/en-kit.js";
import { languageOf } from "../publish/platform-caps.js";
import { videoKitFor } from "../../storage/video-kits.js";
import { getContent, type Content } from "../../storage/local-store.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { contentRoot } from "../../storage/content-project.js";
import { validCutApproval } from "../production/derive.js";
import { probe } from "../production/roots.js";
import { placedManifest } from "./placements.js";
import path from "node:path";

export interface EnKitBinding { enScriptHash: string; enDubHash: string }

/**
 * 片长：审过的英文成片（补过 B-roll 后比配音清单长，2026-10-26 安克 682s vs 清单 662s）——登记时记下的时长，没记就现量；
 * 还没有审过的英文成片才退回配音结尾（durationSource 如实标出）。审过的成片读不出时长 = null（章节核不了，不拿清单顶替）。
 */
export async function enCutDurationS(contentId: string, dataDir: string): Promise<{ durationS: number | null; source: "approved_cut" } | null> {
  const c = await getContent(contentId, dataDir);
  if (!c) return null;
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const ap = validCutApproval(doc, c.body ?? "");
  const fact = ap?.sha256 ? doc.facts.find((f) => f.kind === "cut" && f.sha256 === ap.sha256 && !f.replaced_at) : undefined;
  if (!fact) return null;
  if (fact.duration_ms && fact.duration_ms > 0) return { durationS: fact.duration_ms / 1000, source: "approved_cut" };
  if (!fact.path) return { durationS: null, source: "approved_cut" };
  const r = await probe(path.isAbsolute(fact.path) ? fact.path : path.join(contentRoot(contentId, dataDir), fact.path));
  return { durationS: "error" in r || !(r.durationMs > 0) ? null : r.durationMs / 1000, source: "approved_cut" };
}

export async function enKitBinding(contentId: string, dataDir: string): Promise<{ binding: EnKitBinding; durationS: number | null; durationSource: "approved_cut" | "dub_manifest" } | { no: Refusal }> {
  const a = await approvedEnState(contentId, dataDir);
  if ("no" in a) return a;
  const cm = await currentEnManifest(contentId, a.s, dataDir);
  if ("no" in cm) return cm;
  const pm = await placedManifest(contentId, cm.m, dataDir);
  if ("error" in pm) return { no: { ok: false, code: "placements_stale", error: pm.error } };
  // 生成时间不算：同样的配音重排一次不该让包过期；登记了实际摆放就一并绑上（摆放改了，章节可能跟着变）
  const enDubHash = createHash("sha256").update(JSON.stringify({ ...cm.m, createdAt: undefined }) + (pm.placementsHash ?? "")).digest("hex");
  const cut = await enCutDurationS(contentId, dataDir);
  return { binding: { enScriptHash: a.s.hash, enDubHash }, ...(cut ? { durationS: cut.durationS, durationSource: cut.source } : { durationS: cm.m.dubEndS, durationSource: "dub_manifest" as const }) };
}

export async function enKitContext(contentId: string, dataDir: string): Promise<{ ctx: EnKitContext; binding: EnKitBinding } | { no: Refusal }> {
  const b = await enKitBinding(contentId, dataDir);
  if ("no" in b) return b;
  return { ctx: { thumbnailProblem: await thumbnailProblem(await readEnThumbnail(contentId, dataDir)), durationS: b.durationS }, binding: b.binding };
}

/** check 时：包绑的脚本 / 配音还是不是现在批过的那份；对得上 = null */
export async function enKitStaleReason(kit: Partial<EnKitBinding>, contentId: string, dataDir: string): Promise<string | null> {
  const b = await enKitBinding(contentId, dataDir);
  if ("no" in b) return b.no.error;
  if (kit.enScriptHash !== b.binding.enScriptHash || kit.enDubHash !== b.binding.enDubHash) return "英文发布包是按旧的脚本 / 配音做的：按现在批过的脚本和配音重交发布包";
  return null;
}

/** 发布前检查：英文平台的包按过期拦（中文平台 = null） */
export async function enKitStaleRefusal(content: Content, platform: string, dataDir: string): Promise<Refusal | null> {
  if (languageOf(platform) !== "en") return null;
  const kit = videoKitFor(content, platform);
  if (!kit) return null;
  const reason = await enKitStaleReason(kit, content.id, dataDir);
  return reason ? { ok: false, code: "kit_stale", error: reason } : null;
}
