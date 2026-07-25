/**
 * 消化结论与回执文案（spec §3.1 三态语义 + §2.1 回执）。
 *
 * 从 digest-pipeline 里分出来的一层：管线负责**走流程**，这里负责把「发生了什么」翻译成
 * 两样东西——给 worker 的 ProcessResult 与给创始人的人话回执。两者永远成对产生，
 * 所以放同一个文件；解析器一多（抖音已上、X 在路上），错误映射表还会长。
 *
 * 一条纪律：**三态不共用 failed**。确定性拒绝 → rejected（不重试），等外部条件 → blocked
 * （配置变更时唤醒，不计 attempts），可重试故障 → failed。判错方向的默认值一律偏
 * 「可见地重试几次」，把能救的判死比多跑两次贵得多。
 */
import { FetchExternalError } from "./fetch-external.js";
import type { InboxStage, InboxVerdict } from "./inbox-store.js";
import { JustoneapiError } from "./justoneapi.js";
import { MAX_ATTEMPTS, type ProcessResult } from "./inbox-worker.js";
import { EngineUnavailableError, TriageError } from "./triage.js";

// ─── 回执文案（常量，改文案只改这里） ────────────────────────────────────────

const VERDICT_LABEL: Record<InboxVerdict, string> = {
  inspiration: "灵感选题",
  exemplar: "对标拆解卡",
  both: "拆解卡 + 灵感选题",
  unusable: "用不上",
};

export const DIGEST_RECEIPTS = {
  digested: (verdict: InboxVerdict, landings: string[]): string =>
    `已消化 · ${VERDICT_LABEL[verdict]}\n落点：${landings.join("；") || "（无）"}`,
  alreadyDigested: (where: string): string => `已收录过，这次没重复入库\n原落点：${where}`,
  rejected: (reason: string): string => `这条没收下：${reason}`,
  failed: (reason: string): string => `这条暂时没处理成功：${reason}\n会自动重试，不用重发`,
  /** 重试额度已用尽——别再承诺「会自动重试」，指向人工入口 */
  failedFinal: (reason: string): string =>
    `这条试了 ${MAX_ATTEMPTS} 次都没成功：${reason}\n去工作台收件箱里手动重试`,
  blocked: (reason: string, hint: string): string => `这条先挂起：${reason}\n${hint}`,
  /** 墓碑命中：显式覆盖而非静默复活（§3.5） */
  tombstone: "此前拆解卡已删除；要重拆请重新转发并附『重拆』备注",
  topicRejectMemory: "这个选题 7 天内评估过并落选了，暂不重复入库",
  emptyItem: "这条既没有链接也没有文字，没法消化",
  douyinNoVideoId: "这条抖音链接里没有视频 id（只吃单条视频链接，主页/合集不行）",
} as const;

const ENGINE_BLOCKED_HINT = "去设置页把引擎（模型 / 中转地址 / API key）配好，保存后会自动重试。";
const JUSTONEAPI_BLOCKED_HINT = "去「设置 · 灵感收件箱」配置 justoneapi key，保存后会自动重试。";

// ─── 形态 ────────────────────────────────────────────────────────────────────

/** 一次消化的产出：给 worker 的结论 + 给创始人的人话 */
export interface Outcome {
  result: ProcessResult;
  receipt: string;
}

/** 跨步骤累积的进度——失败时也要随结果带回台账，否则 checkpoint 丢了要重跑卡步 */
export interface Progress {
  stage?: InboxStage;
  targetIds: string[];
  /** 人话落点，只进回执 */
  landings: string[];
}

export function carry(progress: Progress): Pick<ProcessResult, "stage" | "targetIds"> {
  return {
    ...(progress.stage ? { stage: progress.stage } : {}),
    ...(progress.targetIds.length ? { targetIds: progress.targetIds } : {}),
  };
}

export function rejectedOutcome(reason: string, errorCode: string, progress: Progress): Outcome {
  return {
    result: { status: "rejected", errorCode, failReason: reason, ...carry(progress) },
    receipt: DIGEST_RECEIPTS.rejected(reason),
  };
}

export function duplicateOutcome(where: string, targetIds: string[], verdict?: InboxVerdict): Outcome {
  return {
    result: { status: "digested", ...(verdict ? { verdict } : {}), targetIds },
    receipt: DIGEST_RECEIPTS.alreadyDigested(where),
  };
}

// ─── 错误映射（三态语义，验收项） ────────────────────────────────────────────

/** 确定性抓取失败：重试也不会变，直接 rejected */
const DETERMINISTIC_FETCH = new Set([
  "invalid_url",
  "unsupported_protocol",
  "ssrf_blocked",
  "unsupported_content_type",
  "body_too_large",
  "too_many_redirects",
]);

const FETCH_REASON: Record<string, string> = {
  invalid_url: "这个链接解析不了",
  unsupported_protocol: "只吃 http/https 链接",
  ssrf_blocked: "这个地址指向本机或内网，出于安全没抓",
  unsupported_content_type: "这个链接不是网页正文（只吃 HTML / 纯文本）",
  body_too_large: "页面超过 2MB 上限，已中止",
  too_many_redirects: "跳转超过 5 跳，已放弃",
  timeout: "抓取超时",
  fetch_failed: "抓不到这个页面（网络或对方站点问题）",
};

/** http_<n>：4xx 是对方明确拒绝（确定性），5xx/其它按可重试处理 */
function httpStatusOf(errorCode: string): number | null {
  const m = /^http_(\d{3})$/.exec(errorCode);
  return m ? Number(m[1]) : null;
}

function fetchReason(err: FetchExternalError): string {
  const http = httpStatusOf(err.errorCode);
  return http !== null ? `对方站点返回 ${http}` : (FETCH_REASON[err.errorCode] ?? err.message);
}

interface Classified {
  status: "rejected" | "failed" | "blocked";
  errorCode: string;
  reason: string;
  receipt: string;
}

/** failed 的回执文案取决于「还有没有下一次」——worker 的 retryable 口径同款 */
function failedReceipt(reason: string, willRetry: boolean): string {
  return willRetry ? DIGEST_RECEIPTS.failed(reason) : DIGEST_RECEIPTS.failedFinal(reason);
}

/**
 * 错误 → 三态。判错方向的默认值一律偏「可见地重试几次」（failed），
 * 而不是永久 rejected——把能救的判死比多跑两次贵得多。
 */
function classifyError(err: unknown, willRetry: boolean): Classified {
  if (err instanceof FetchExternalError) {
    const http = httpStatusOf(err.errorCode);
    const deterministic = DETERMINISTIC_FETCH.has(err.errorCode) || (http !== null && http < 500);
    const reason = fetchReason(err);
    return deterministic
      ? { status: "rejected", errorCode: err.errorCode, reason, receipt: DIGEST_RECEIPTS.rejected(reason) }
      : { status: "failed", errorCode: err.errorCode, reason, receipt: failedReceipt(reason, willRetry) };
  }
  if (err instanceof EngineUnavailableError) {
    return {
      status: "blocked",
      errorCode: err.errorCode,
      reason: err.message,
      receipt: DIGEST_RECEIPTS.blocked(err.message, ENGINE_BLOCKED_HINT),
    };
  }
  // 解析器自带三态（§3.2 错误码映射表），这里只负责挑对应的人话回执
  if (err instanceof JustoneapiError) {
    const reason = err.message;
    const receipt =
      err.outcome === "blocked"
        ? DIGEST_RECEIPTS.blocked(reason, JUSTONEAPI_BLOCKED_HINT)
        : err.outcome === "rejected"
          ? DIGEST_RECEIPTS.rejected(reason)
          : failedReceipt(reason, willRetry);
    return { status: err.outcome, errorCode: err.errorCode, reason, receipt };
  }
  if (err instanceof TriageError) {
    const reason = err.message;
    return err.retryable
      ? { status: "failed", errorCode: err.errorCode, reason, receipt: failedReceipt(reason, willRetry) }
      : { status: "rejected", errorCode: err.errorCode, reason, receipt: DIGEST_RECEIPTS.rejected(reason) };
  }
  const reason = err instanceof Error ? err.message : String(err);
  return { status: "failed", errorCode: "digest_failed", reason, receipt: failedReceipt(reason, willRetry) };
}

/** attempts 是 worker claim 时已经 +1 过的「本次是第几次」，与它的 retryable 同口径 */
export function failureOutcome(err: unknown, progress: Progress, attempts: number): Outcome {
  const c = classifyError(err, attempts < MAX_ATTEMPTS);
  return {
    result: { status: c.status, errorCode: c.errorCode, failReason: c.reason, ...carry(progress) },
    receipt: c.receipt,
  };
}
