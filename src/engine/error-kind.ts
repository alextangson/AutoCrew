/**
 * 引擎错误的**稳定分类**（P2 spec §4.2）。
 *
 * 为什么单独一个文件：翻译器（failure-text.ts）、重试通道（utils/retry.ts）与探针
 * 都要认这套分类，但它们谁都不该为了认一个枚举就把 pi-ai SDK 拖进来。
 * 本模块零依赖、纯函数——`pi-wire.ts` 原样再导出一份，spec 里点名的入口不变。
 *
 * 纪律：**协议不匹配不靠猜**。观察器把「200 但不是 SSE」改写成 400 时，body 是
 * `{"error":{"type":"protocol_mismatch",…}}`，分类器读的是那个 `type`；
 * 消息里那句 ASCII 标记只是 SDK 只回传 message 时的第二道保险，不是主判据。
 */

export type EngineErrorKind =
  | "connect"
  | "timeout"
  | "auth"
  | "rate_limit"
  | "upstream"
  | "protocol"
  | "aborted"
  | "unknown";

export interface ClassifiedEngineError {
  kind: EngineErrorKind;
  /** 上游给的 HTTP 状态码（认得出来时）；连接类失败没有这个数 */
  status?: number;
  /** 已剥掉 JSON 信封的那句原文（翻译器的可选料，连接类不用它） */
  detail: string;
}

/** 观察器写进 400 body 的错误类型标识；分类器与观察器共用这一个常量 */
export const PROTOCOL_MISMATCH = "protocol_mismatch";

const CONNECT_RE =
  /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|ENETUNREACH|socket hang up|premature close|connection error|other side closed|UND_ERR|terminated/i;
/**
 * 只认**上游/传输层**的超时指纹。刻意不认中文「超时」——那是我们自己写的话
 * （整稿墙钟、视角墙钟），把它认成线路超时就会给一个「端点没回内容」的假诊断。
 */
const TIMEOUT_RE = /idle timeout|ETIMEDOUT|timed? ?out/i;
const ABORT_RE = /\baborted\b|AbortError/i;

/** 状态码 → 分类。429 单列（换端点有用），401/403 单列（换端点没用） */
function kindOfStatus(status: number): EngineErrorKind | undefined {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504 || status === 524 || status === 522) return "timeout";
  if (status >= 500) return "upstream";
  if (status >= 400) return "upstream"; // 400/404：上游明确拒了，不是网络的错
  return undefined;
}

/**
 * 剥 JSON 错误信封。两种化身都要认：
 *   - `401 {"error":{"message":"…","type":"…"}}`（上游原样）
 *   - `502: {"message":"…"}`（观察器把 fetchImpl 的异常透过 socket 边界送回来的那种，
 *     SDK 再拼一次状态码，冒号与内层形状都和上面那种不一样）
 */
function unwrapEnvelope(message: string): { status?: number; detail: string; type?: string } {
  const m = /^(\d{3}):?\s+(\{[\s\S]*\})\s*$/.exec(message.trim());
  if (!m) return { detail: message.trim() };
  const status = Number(m[1]);
  try {
    const parsed = JSON.parse(m[2]) as { error?: { message?: unknown; type?: unknown }; message?: unknown; type?: unknown };
    const inner = parsed.error?.message ?? parsed.message;
    const type = parsed.error?.type ?? parsed.type;
    return {
      status,
      detail: typeof inner === "string" && inner.trim() ? inner.trim() : m[2],
      ...(typeof type === "string" && type ? { type } : {}),
    };
  } catch {
    return { status, detail: m[2] };
  }
}

function statusOf(err: unknown, fromMessage?: number): number | undefined {
  const direct = (err as { status?: unknown; statusCode?: unknown } | null)?.status;
  if (typeof direct === "number") return direct;
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof code === "number") return code;
  if (fromMessage !== undefined) return fromMessage;
  // **只认开头**的状态码（`429 too many requests`）。满消息扫三位数会把
  // `connect ECONNREFUSED 1.2.3.4:443` 里的端口当成状态码,给出一个笃定的错诊断。
  const leading = /^(\d{3})\b/.exec(String((err as Error)?.message ?? "").trim());
  const n = leading ? Number(leading[1]) : Number.NaN;
  return Number.isFinite(n) && n >= 400 && n <= 599 ? n : undefined;
}

/**
 * 错误 → `{kind, status?, detail}`。任何输入都给得出答案（认不出就是 `unknown`），
 * 因为这条链路上每个调用点都在失败路径上——分类器自己再抛一次毫无意义。
 */
export function classifyEngineError(err: unknown): ClassifiedEngineError {
  const e = err instanceof Error ? err : new Error(String(err ?? ""));
  const env = unwrapEnvelope(e.message);
  const status = statusOf(err, env.status);
  const detail = env.detail || e.message;

  // 1. 结构化协议不匹配：观察器写的 type 是主判据，消息里的标记是 SDK 只回 message 时的保险
  if (env.type === PROTOCOL_MISMATCH || e.message.includes(PROTOCOL_MISMATCH)) {
    return { kind: "protocol", ...(status !== undefined ? { status } : {}), detail };
  }
  // 2. 用户/看门狗中止：长得像瞬时网络故障，但它不是线路的病
  if (e.name === "AbortError") return { kind: "aborted", detail };
  if (e.name === "TimeoutError") return { kind: "timeout", detail };
  // 3. 连接类**优先于状态码**：`502 {"message":"fetch failed"}` 里的 502 是观察器补的，
  //    不是上游给的（创始人真机上那句 `出错了：502 {…fetch failed}` 正是这么来的）。
  //    真·上游 502 的 body 会说别的话，不会说 fetch failed。
  if (e.name === "APIConnectionError" || CONNECT_RE.test(detail)) return { kind: "connect", detail };
  // 4. 上游明确给了状态码：它说什么就是什么
  if (status !== undefined) {
    const kind = kindOfStatus(status);
    if (kind) return { kind, status, detail };
  }
  // 5. 无状态码：连接 > 超时 > 中止，按「用户最需要知道哪件事」排
  if (CONNECT_RE.test(e.message)) return { kind: "connect", detail };
  if (TIMEOUT_RE.test(e.message)) return { kind: "timeout", detail };
  if (ABORT_RE.test(e.message)) return { kind: "aborted", detail };
  return { kind: "unknown", ...(status !== undefined ? { status } : {}), detail };
}
