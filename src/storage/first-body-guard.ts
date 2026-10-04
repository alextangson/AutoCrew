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
 * 3. 来源必须显式（`_provenance`）：没标 → 拒，挂没挂选题都一样。
 * 4. 人手（可信入口按认证方式注入：浏览器会话、我的内容回写）与手动导入 → 放行。
 * 5. 模型：改写自一篇可核验的真稿（derivedFrom）→ 放行；没挂选题 → 拒；
 *    选题已有别的真稿 → 放行；否则要创始人亲口定的、仍作数的最新角度决定。
 */
import type { Content } from "./local-store.js";

/** 写正文的来源：调用方必须显式传（`_provenance`），不传按「来源不明」处理 */
export type WriteProvenance =
  | { kind: "human" }
  | { kind: "import" }
  /** derivedFrom：由哪篇已有稿件改写而来（平台适配）；卡口会严格读它确认是真稿 */
  | { kind: "model"; host?: string; derivedFrom?: string; request?: WriteRequest };

/**
 * 这次模型写作依据的请求（写作包 / 生成请求里冻结的）：落第一份正文时要和创始人最新的决定对上——
 * 给了 direction 就得是创始人最近自定的那句；没给 direction 就得是最近选了卡（angleId 给了还得同一张）；
 * 带跳过参数一律不行。
 */
export interface WriteRequest { direction?: string; angleId?: string; skip?: boolean }

export const HUMAN_WRITE: WriteProvenance = { kind: "human" };
export const IMPORT_WRITE: WriteProvenance = { kind: "import" };
export const modelWrite = (host?: string, request?: WriteRequest): WriteProvenance => ({ kind: "model", ...(host ? { host } : {}), ...(request ? { request } : {}) });

function isProvenance(v: unknown): v is WriteProvenance {
  const kind = (v as { kind?: unknown } | null)?.kind;
  return kind === "human" || kind === "import" || kind === "model";
}

/**
 * 工具参数 → 写正文的来源。只认可信层注入的标记：`_provenance`（桌面 IPC 按认证方式注入，
 * 外部 payload 的下划线键在入口就被剥掉）、`_host`（MCP 按令牌注入）、`_modelCall`（OpenClaw 注入）。
 * 都没有 = 来源不明（undefined），由卡口拒绝第一份正文——不再默认当成人手。
 */
export function provenanceOf(params: Record<string, unknown>, opts: { manualImport?: boolean } = {}): WriteProvenance | undefined {
  // 手动导入的是创作者自己的成稿（谁搬进来都一样）：豁免
  if (opts.manualImport) return IMPORT_WRITE;
  if (typeof params._host === "string" || params._modelCall === true) return modelWrite(typeof params._host === "string" ? params._host : undefined);
  if (isProvenance(params._provenance)) return params._provenance;
  return undefined;
}

/** 桌面 IPC：浏览器登录会话 = 人手；令牌（宿主/模型可达）或认证方式不明 = 模型 */
export function provenanceFromAuth(authMethod: "session" | "bearer" | undefined): WriteProvenance {
  return authMethod === "session" ? HUMAN_WRITE : modelWrite("desktop-token");
}

/** create_variant 不带正文时写的占位正文前缀 */
export const TOPIC_PLACEHOLDER_BODY_PREFIX = "<!-- Generated from topic:";

/** 正文是不是占位：空白，或 create_variant 拿选题描述垫的那段 */
export function isPlaceholderBody(body: unknown): boolean {
  return typeof body !== "string" || !body.trim() || body.startsWith(TOPIC_PLACEHOLDER_BODY_PREFIX);
}

/** 系统给选题垫的占位正文（create_variant 不带正文时）：一字不差的模板 */
export function topicPlaceholderBody(topicId: string, description: string): string {
  return `${TOPIC_PLACEHOLDER_BODY_PREFIX} ${topicId} -->\n\n${description}`;
}

type PlaceholderRef = { topicId?: string; generatedPlaceholder?: string };

/**
 * 一段正文算不算「核验过的占位」：空白；或与系统建稿时记下的那段占位一字不差；
 * 或与该选题当前描述生成的模板一字不差（老数据没记那段占位）。前缀长得像不算——
 * 在占位前缀后面接一段正文照样是真正文（Codex 第八轮：前缀可以被伪造）。
 */
export async function isVerifiedPlaceholder(body: unknown, ref: PlaceholderRef, dataDir?: string): Promise<boolean> {
  if (typeof body !== "string" || !body.trim()) return true;
  if (!body.startsWith(TOPIC_PLACEHOLDER_BODY_PREFIX)) return false;
  if (ref.generatedPlaceholder !== undefined && body === ref.generatedPlaceholder) return true;
  if (!ref.topicId) return false;
  const { getTopicStrict } = await import("./local-store.js");
  const topic = await getTopicStrict(ref.topicId, dataDir);
  return Boolean(topic && body === topicPlaceholderBody(ref.topicId, topic.description ?? ""));
}

/** 真稿：未删、未归档、正文（当前或任一版本）不是核验过的占位。严格读：选题读坏就抛 */
export async function isRealDraft(c: Pick<Content, "deletedAt" | "status" | "body" | "versions" | "topicId" | "generatedPlaceholder">, dataDir?: string): Promise<boolean> {
  if (c.deletedAt || c.status === "archived") return false;
  for (const body of [c.body, ...(c.versions ?? []).map((v) => v.body)]) {
    if (!(await isVerifiedPlaceholder(body, c, dataDir))) return true;
  }
  return false;
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
  existing: Pick<Content, "deletedAt" | "status" | "body" | "versions" | "topicId" | "generatedPlaceholder"> | null,
  next: { body?: string; topicId?: string; generatedPlaceholder?: string },
  provenance: WriteProvenance | undefined,
  dataDir?: string,
): Promise<void> {
  const { ANGLE_GATE_COPY, decisionRequestRefusal, newDraftAngleRefusal, topicHasDraft } = await import("../modules/research/angle-gate.js");
  const readFailed = (err: unknown) => new FirstBodyRefusedError({ ok: false, code: "angle_gate_read_failed", error: `${ANGLE_GATE_COPY.readFailed}（${err instanceof Error ? err.message : String(err)}）` });
  const topicId = next.topicId ?? existing?.topicId;
  try {
    if (existing && await isRealDraft(existing, dataDir)) return;
    if (next.body === undefined) return;
    // 写完仍是核验过的占位（系统记下的那段 / 该选题模板 / 空白）才不算第一份正文；伪造前缀不算
    const ref = { topicId, generatedPlaceholder: next.generatedPlaceholder ?? existing?.generatedPlaceholder };
    if (await isVerifiedPlaceholder(next.body, ref, dataDir)) return;
  } catch (err) { throw readFailed(err); }
  // 来源必须显式：没标就拒（挂没挂选题都一样），漏标来源的写口不能悄悄开出第一篇
  if (!provenance) throw new FirstBodyRefusedError({ ok: false, code: "unknown_write_provenance", error: UNKNOWN_PROVENANCE });
  if (provenance.kind === "human" || provenance.kind === "import") return;
  // 模型改写一篇已有真稿（平台适配等）：凭可核验的源稿 id 放行，与新稿挂不挂选题无关
  if (provenance.derivedFrom) {
    const { getContentStrict } = await import("./local-store.js");
    try {
      const source = await getContentStrict(provenance.derivedFrom, dataDir);
      if (source && await isRealDraft(source, dataDir)) return;
    } catch (err) { throw readFailed(err); }
  }
  if (!topicId) {
    throw new FirstBodyRefusedError({ ok: false, code: "needs_founder_angle", error: ANGLE_GATE_COPY.noTopic, next_action: { skill: "topic-meeting", tool: "autocrew_workflow", params: { action: "prepare" } } });
  }
  // 选题已有别的真稿：这不是选题的第一篇（存量、真稿的平台变体），不再看角度元数据
  let hasDraft: boolean;
  try { hasDraft = await topicHasDraft(topicId, dataDir); } catch (err) { throw readFailed(err); }
  if (hasDraft) return;
  const refused = await newDraftAngleRefusal(topicId, dataDir);
  if (refused) throw new FirstBodyRefusedError(refused);
  // 冻结的请求（写作包 / 生成请求 / 重写合并后的请求）要对得上创始人「最新」的决定
  const mismatch = await decisionRequestRefusal(topicId, provenance.request, dataDir);
  if (mismatch) throw new FirstBodyRefusedError(mismatch);
}
