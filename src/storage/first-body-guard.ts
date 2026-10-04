/**
 * 选题会规则的唯一卡口（创始人 2026-10-04；Codex 第五轮后改成单点执行）。
 *
 * 一篇稿件第一次拿到「真正文」（非空白、非选题描述垫的占位）就在这里判，所有写正文的口
 * （`saveContent` / `updateContent` / `updateContentIfDraftMatches` / 流转带的补丁）都汇到
 * 存储层的这一处，入口层的提前拒绝只是更好懂的提示，正确性不靠它们。
 *
 * 判定顺序：
 * 1. 这篇稿本身已是真稿（当前正文或任一版本是真的）→ 改稿/回滚，放行。
 * 2. 写完仍是占位 → 不是「第一份正文」，放行。
 * 3. 来源（provenance）：人手（工作台、我的内容回写）与手动导入 → 放行；
 *    模型/宿主 → 走选题会判定（选题已有别的真稿放行，否则要创始人亲口定的、仍作数的角度）；
 *    没标来源 → 拒（宁可报错，也不让漏标的写口悄悄开出第一篇）。
 *    没挂选题的稿：模型写 → 拒；人手/导入 → 放行；没标来源 → 不属于「选题的第一篇」，放行。
 */
import type { Content } from "./local-store.js";

/** 写正文的来源：调用方必须显式传（`_provenance`），不传按「来源不明」处理 */
export type WriteProvenance = { kind: "human" } | { kind: "import" } | { kind: "model"; host?: string };

export const HUMAN_WRITE: WriteProvenance = { kind: "human" };
export const IMPORT_WRITE: WriteProvenance = { kind: "import" };
export const modelWrite = (host?: string): WriteProvenance => ({ kind: "model", ...(host ? { host } : {}) });

/** 工具参数里的模型标记（MCP 注入 `_host`，OpenClaw 注入 `_modelCall`）→ 来源；都没有 = 人手 */
export function provenanceOf(params: Record<string, unknown>, opts: { manualImport?: boolean } = {}): WriteProvenance {
  // 手动导入的是创作者自己的成稿（谁搬进来都一样）：豁免
  if (opts.manualImport) return IMPORT_WRITE;
  if (typeof params._host === "string" || params._modelCall === true) return modelWrite(typeof params._host === "string" ? params._host : undefined);
  return HUMAN_WRITE;
}

/** create_variant 不带正文时写的占位正文前缀 */
export const TOPIC_PLACEHOLDER_BODY_PREFIX = "<!-- Generated from topic:";

/** 正文是不是占位：空白，或 create_variant 拿选题描述垫的那段 */
export function isPlaceholderBody(body: unknown): boolean {
  return typeof body !== "string" || !body.trim() || body.startsWith(TOPIC_PLACEHOLDER_BODY_PREFIX);
}

/** 真稿：未删、未归档、正文（当前或任一版本）不是占位 */
export function isRealDraft(c: Pick<Content, "deletedAt" | "status" | "body" | "versions">): boolean {
  if (c.deletedAt || c.status === "archived") return false;
  return !isPlaceholderBody(c.body) || (c.versions ?? []).some((v) => !isPlaceholderBody(v.body));
}

export class FirstBodyRefusedError extends Error {
  constructor(readonly refusal: { ok: false; code: string; error: string } & Record<string, unknown>) {
    super(refusal.error);
  }
}

const UNKNOWN_PROVENANCE = "这次写正文没有标明来源（人手 / 导入 / 模型），没法判断它要不要先开选题会，先不写。";

/**
 * 卡口本体：会让稿件第一次拿到真正文时才做事；拒绝就抛 FirstBodyRefusedError（带结构化回执）。
 * `existing` 为 null = 新建稿件。
 */
export async function guardFirstBody(
  existing: Pick<Content, "deletedAt" | "status" | "body" | "versions" | "topicId"> | null,
  next: { body?: string; topicId?: string },
  provenance: WriteProvenance | undefined,
  dataDir?: string,
): Promise<void> {
  if (existing && isRealDraft(existing)) return;
  if (next.body === undefined || isPlaceholderBody(next.body)) return;
  const topicId = next.topicId ?? existing?.topicId;
  const { ANGLE_GATE_COPY, newDraftAngleRefusal, topicHasDraft } = await import("../modules/research/angle-gate.js");
  if (!topicId) {
    if (provenance?.kind !== "model") return;
    throw new FirstBodyRefusedError({ ok: false, code: "needs_founder_angle", error: ANGLE_GATE_COPY.noTopic, next_action: { skill: "topic-meeting", tool: "autocrew_workflow", params: { action: "prepare" } } });
  }
  // 选题已有别的真稿：这不是它的第一篇（存量、真稿的平台变体），先于一切来源与角度元数据放行
  let hasDraft: boolean;
  try { hasDraft = await topicHasDraft(topicId, dataDir); } catch (err) {
    throw new FirstBodyRefusedError({ ok: false, code: "angle_gate_read_failed", error: `${ANGLE_GATE_COPY.readFailed}（${err instanceof Error ? err.message : String(err)}）` });
  }
  if (hasDraft) return;
  if (provenance?.kind === "human" || provenance?.kind === "import") return;
  // 选题会已开过但来源不明也拒：漏标来源的写口不能靠「碰巧已定角度」过关
  if (!provenance) throw new FirstBodyRefusedError({ ok: false, code: "unknown_write_provenance", error: UNKNOWN_PROVENANCE });
  const refused = await newDraftAngleRefusal(topicId, dataDir);
  if (refused) throw new FirstBodyRefusedError(refused);
}
