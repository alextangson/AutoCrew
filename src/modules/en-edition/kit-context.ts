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
import type { Content } from "../../storage/local-store.js";

export interface EnKitBinding { enScriptHash: string; enDubHash: string }

export async function enKitBinding(contentId: string, dataDir: string): Promise<{ binding: EnKitBinding; durationS: number } | { no: Refusal }> {
  const a = await approvedEnState(contentId, dataDir);
  if ("no" in a) return a;
  const cm = await currentEnManifest(contentId, a.s, dataDir);
  if ("no" in cm) return cm;
  // 生成时间不算：同样的配音重排一次不该让包过期
  const enDubHash = createHash("sha256").update(JSON.stringify({ ...cm.m, createdAt: undefined })).digest("hex");
  return { binding: { enScriptHash: a.s.hash, enDubHash }, durationS: cm.m.dubEndS };
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
