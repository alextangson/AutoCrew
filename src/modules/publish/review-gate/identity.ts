/**
 * 检查身份（发布前把关 spec §2.1，Codex P1-4/5）。
 *
 * - 待发布内容哈希（逐平台）：规范化后的 {platform, account, content_id, title, caption, tags, covers[{usage, ratio, sha256}],
 *   video_sha256, scheduled_at+tz}；排除授权、执行状态、回执、活动核验等过程字段——写回执不让检查失效。
 * - 检查指纹 = 待发布内容哈希 + 登记记录 id + 批准 id + 偏好表版本 + 指令 id + 字幕 sha + 问题集版本 + 模型版本，
 *   另加原话 / 例外 / 稿件标题与比对正文的哈希（Jev 的输入，换了原话不能复用旧答案——见 README 偏差说明）。
 */
import crypto from "node:crypto";
import type { CoverFact } from "./deterministic.js";
import type { PlanEntry } from "./plan.js";

export const QUESTION_SET_VERSION = "prg-q1";

const sha = (v: unknown) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

export function payloadHash(entry: PlanEntry, contentId: string, covers: CoverFact[], videoSha: string | null): string {
  return sha({
    platform: entry.platform,
    account: entry.account,
    content_id: entry.content_id ?? contentId,
    title: entry.title.trim(),
    caption: entry.caption.trim(),
    tags: entry.tags,
    covers: covers.map((c) => ({ usage: c.usage, ratio: c.pixel_ratio, sha256: c.fact.sha256 ?? null }))
      .sort((a, b) => `${a.usage}|${a.ratio}|${a.sha256}`.localeCompare(`${b.usage}|${b.ratio}|${b.sha256}`)),
    video_sha256: videoSha,
    scheduled_at: entry.scheduled_at,
    timezone: entry.timezone,
  });
}

export interface FingerprintParts {
  payload_hash: string;
  registration_id: string | null;
  approval_ids: string[];
  prefs_version: string;
  instruction_id: string | null;
  srt_sha: string | null;
  question_set: string;
  model: string;
  quotes_sha: string;
  overrides_sha: string;
  basis_sha: string;
  /** Jev A / B 请求的 state + 问题整体哈希：判定依赖的每个输入都在里面 */
  requests_sha: string;
}

export function fingerprint(parts: FingerprintParts): string {
  return sha(parts);
}

export function textSha(v: unknown): string {
  return sha(v).slice(0, 16);
}
