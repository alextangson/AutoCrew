/**
 * 全产品**唯一**的线路故障翻译器（P2 spec §4.2）。
 *
 * 在这之前同一个上游连接失败有四种说法，只有设置页那条是给人看的。这里定一句话的模板：
 * 「**哪条线** + **哪个端点** + **什么故障** + **这次产品做了什么**」，四条链路（聊天 /
 * 写稿 / 深调研 / 探针）全部走它，谁都不许再把 `fetch failed` 原样端给用户。
 *
 * 边界：分类是 `unknown` 时**不套模板**——「写稿专线连不上」这种话如果安到一个
 * 「模型没调用 submit_script」的失败上，就是用确定的语气说错话。调用方据此决定
 * 要不要翻译（见 `isEngineFailure`）。
 */
import { classifyEngineError, type ClassifiedEngineError, type EngineErrorKind } from "./error-kind.js";
import { ENGINE_ROLE_LABELS, type EngineRouteName } from "./config-schema.js";

/** 报病文案里的角色。chat 与 main 同一句词——用户不区分「聊天用的」和「主端点」 */
export type FailureRole = EngineRouteName | "main" | "chat" | "probe";

const ROLE_LABEL: Record<FailureRole, string> = {
  ...ENGINE_ROLE_LABELS,
  main: "主端点",
  chat: "主端点",
  probe: "端点",
};

/** 「…已中断」里的那个动词：说「写稿已中断」，不说「本次调用已中断」 */
const ROLE_ACTION: Record<FailureRole, string> = {
  writer: "写稿",
  reviewer: "审稿",
  scout: "调研",
  analytics: "复盘",
  main: "本次调用",
  chat: "本次对话",
  probe: "本次测试",
};

export interface FailureProvider {
  id: string;
  /** 主机名（同家检测与文案共用同一把尺）；空串则文案省略括号 */
  host?: string;
  name?: string;
}

export interface DescribeFailureInput {
  role: FailureRole;
  provider: FailureProvider;
  classified: ClassifiedEngineError;
  /** 备用端点顶完了本次调用：说「已改由备用 X 顶完本次调用」 */
  fallbackUsed?: { provider: string } | undefined;
  /** 明确知道没有配备用时给 false——不知道就别说「没有备用端点」 */
  fallbackAvailable?: boolean | undefined;
}

/** kind → 故障那半句。status 有就带上，让人能拿去问中转客服 */
function symptom(kind: EngineErrorKind, status?: number): string {
  const code = status ? `（${status}）` : "";
  switch (kind) {
    case "connect":
      return "连不上：网络不通或域名解析失败";
    case "timeout":
      return `响应超时${code}：端点在限时内没有回内容`;
    case "auth":
      return `拒绝了 Key${code || "（401）"}：Key 错误或已过期，换端点没用`;
    case "rate_limit":
      return `限流${code || "（429）"}：请求太密或额度用尽`;
    case "protocol":
      return "协议不匹配：端点回的不是流式响应，去设置里把协议在 openai / anthropic 之间换一个试试";
    case "aborted":
      return "调用已中止";
    case "upstream":
      return `报错${code}`;
    default:
      return "调用失败";
  }
}

/** 只有 upstream / unknown 需要把上游那句话带出来；连接类带了只会是 `fetch failed` 这种噪音 */
function detailSuffix(kind: EngineErrorKind, detail: string): string {
  if (kind !== "upstream" && kind !== "unknown") return "";
  const text = detail.trim();
  if (!text || /^fetch failed$/i.test(text)) return "";
  return `：${text.length > 120 ? `${text.slice(0, 120)}…` : text}`;
}

/** 这次产品做了什么——留白比编一句「已自动恢复」诚实 */
function outcomeClause(input: DescribeFailureInput): string {
  if (input.role === "probe") return ""; // 测试本来就是为了看它坏没坏，不必再说「已中断」
  const action = ROLE_ACTION[input.role];
  if (input.fallbackUsed) return `已改由备用 ${input.fallbackUsed.provider} 顶完本次调用。`;
  if (input.fallbackAvailable === false) return `这次没有备用端点，${action}已中断。`;
  return `${action}已中断。`;
}

/**
 * 一句人话。形如：
 * 「写稿专线 newcli（code.newcli.com）连不上：网络不通或域名解析失败。这次没有备用端点，写稿已中断。」
 */
export function describeEngineFailure(input: DescribeFailureInput): string {
  const label = ROLE_LABEL[input.role] ?? ROLE_LABEL.main;
  const { id, host } = input.provider;
  const who = `${label} ${id}${host ? `（${host}）` : ""}`.trim();
  const what = symptom(input.classified.kind, input.classified.status) + detailSuffix(input.classified.kind, input.classified.detail);
  return `${who}${what}。${outcomeClause(input)}`;
}

/** 这个错误值得套模板吗？`unknown` 一律不套——宁可原样说，也不用确定的语气说错话 */
export function isEngineFailure(classified: ClassifiedEngineError): boolean {
  return classified.kind !== "unknown";
}

/**
 * 错误消息人话化（原 `settings-probe.ts` 的 `humanizeProbeError`，P2 收进翻译器）。
 * **只做两件事，语义一个字不改**：
 *   1. 拆掉观察器/上游的 JSON 错误信封——`401 {"error":{"message":"invalid x-api-key"}}`
 *      对用户就是一串噪音，真正有用的是里面那句和状态码。
 *   2. undici 把 DNS/连接失败一律叫 "fetch failed"，那三个字说明不了任何事；
 *      补一句它到底意味着什么，原文保留在括号里，不掩盖。
 */
export function humanizeEngineError(raw: string): string {
  const m = /^(\d{3})\s+(\{[\s\S]*\})\s*$/.exec(raw.trim());
  let status = "";
  let body = raw.trim();
  if (m) {
    status = m[1];
    body = m[2]; // 状态码已单独拿出来，剩下的正文不能再带着它，否则会拼成 "500 · 500 {…}"
    try {
      const inner = (JSON.parse(m[2]) as { error?: { message?: unknown } }).error?.message;
      if (typeof inner === "string" && inner.trim()) body = inner.trim();
    } catch {
      /* 不是 JSON 就原样留着——宁可长，不许猜 */
    }
  }
  if (/^fetch failed$/i.test(body)) {
    body = "连不上这个端点：域名解析不了或网络不通（fetch failed）";
    status = ""; // 502 是观察器补的，不是上游给的，说出来只会误导
  }
  return status ? `${status} · ${body}` : body;
}

/**
 * 探针专用口：分类认得出就套模板（`401: {…}` 带冒号、`fetch failed` 都归它管），
 * 认不出才退回老的拆信封翻译。设置页按钮、启动全量探针、健康视图三处同一句话。
 */
export function describeProbeFailure(raw: string, provider: FailureProvider): string {
  const classified = classifyEngineError(new Error(raw));
  if (!isEngineFailure(classified)) return humanizeEngineError(raw);
  return describeEngineFailure({ role: "probe", provider, classified });
}

/** 便捷口：拿到原始错误直接出文案（分类 + 翻译一步走） */
export function describeEngineError(
  err: unknown,
  ctx: Omit<DescribeFailureInput, "classified">,
): string {
  return describeEngineFailure({ ...ctx, classified: classifyEngineError(err) });
}
