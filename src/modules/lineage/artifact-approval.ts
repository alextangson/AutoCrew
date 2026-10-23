/**
 * 绑定产物的批准（全媒体 spec §7 #2、§8 Phase 1 #3）：批准记下「批的是哪一份」的指纹，
 * 下游动手前拿当前指纹再核一次——对不上就拒，给一句人话原因。不静默放行，也不退回别的版本。
 *
 * Phase 1 只接在派生线（英文版 / 公众号文章对源成片的绑定）；Phase 2/3 的稿件、配音、发布包批准照这个形状用。
 */
import { createHash } from "node:crypto";

export interface ArtifactApproval {
  /** 批的是什么（人话，出现在拒绝原因里）：「源视频成片」「英文稿」… */
  artifact: string;
  /** 批准那一刻这份产物的身份（sha256 或别的稳定身份串） */
  hash: string;
  approvedAt: string;
}

export type ApprovalCheck =
  | { ok: true }
  | { ok: false; code: "approval_missing" | "artifact_missing" | "artifact_changed"; reason: string };

/** 任意产物 → 稳定指纹：字符串 / 字节直接算；对象按键排序后的 JSON 算（键顺序不同不算改动） */
export function artifactHash(input: string | Buffer | Record<string, unknown> | unknown[]): string {
  const bytes = typeof input === "string" || Buffer.isBuffer(input) ? input : stableJson(input);
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function approveArtifact(artifact: string, hash: string, now: Date = new Date()): ArtifactApproval {
  return { artifact, hash, approvedAt: now.toISOString() };
}

/** 动手前的核对：没批过、产物没了、产物变了都拒，原因说清是哪一样 */
export function checkArtifactApproval(approval: ArtifactApproval | null | undefined, currentHash: string | null | undefined): ApprovalCheck {
  if (!approval?.hash) return { ok: false, code: "approval_missing", reason: "还没有批准记录：先批准再继续" };
  if (!currentHash) {
    return { ok: false, code: "artifact_missing", reason: `批准时的${approval.artifact}现在找不到了（撤批、重开或文件不见了）：批准已失效，要重新批` };
  }
  if (currentHash !== approval.hash) {
    return { ok: false, code: "artifact_changed", reason: `${approval.artifact}在批准之后变了（批的是 ${shortHash(approval.hash)}，现在是 ${shortHash(currentHash)}）：批准已失效，要按新版重新批` };
  }
  return { ok: true };
}

/** 指纹前 8 位（去掉 sha256: / legacy-rev: 这类前缀），给人看 */
export function shortHash(hash: string): string {
  const body = hash.includes(":") ? hash.slice(hash.indexOf(":") + 1) : hash;
  return body.slice(0, 8);
}
