/**
 * TypeSafe System One（Jev）直连（发布前把关 spec §12）。
 *
 * - `POST https://api.typesafe.ai/v1/systemone`，模型钉 `jev-1.13.0`，超时 15 秒，不重试（失败照实报，下次 check 再试）；
 * - 密钥：环境变量 `TYPESAFE_API_KEY` 优先，其次本机 `~/.autocrew/secrets/typesafe-api-key`（600，设置页写同一个文件）；
 *   不进仓库、不进日志、不进检查留档；
 * - 失败（没密钥、401/429/5xx、超时、返回形状不对）→ 抛 JevError，调用方标「语义把关没跑成：原因」，不挡发布、不缓存。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getMachineDir } from "../../../storage/storage-roots.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
export const JEV_TIMEOUT_MS = 15_000;
/** $0.042 / 百万输入 token（spec §12） */
export const JEV_USD_PER_MTOK = 0.042;

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };

export interface JevResponse { model: string; answers: Record<string, JevAnswer>; usage: { input_tokens: number; output_tokens: number }; ms: number }

export class JevError extends Error {
  constructor(public readonly reason: string) { super(reason); }
}

export type JevCaller = (state: unknown, questions: Record<string, JevQuestion>) => Promise<JevResponse>;

export function typesafeKeyFile(machineDir?: string): string {
  return path.join(getMachineDir(machineDir), "secrets", "typesafe-api-key");
}

export type KeySource = "env" | "file" | null;

/** 只回有没有、来自哪；值只在调用时现读，不缓存到模块状态里 */
export async function resolveTypesafeKey(machineDir?: string): Promise<{ key: string | null; source: KeySource }> {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return { key: env, source: "env" };
  try {
    const raw = (await fs.readFile(typesafeKeyFile(machineDir), "utf8")).trim();
    return raw ? { key: raw, source: "file" } : { key: null, source: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { key: null, source: null };
    throw new JevError(`读不了本机密钥文件：${(e as NodeJS.ErrnoException).code ?? "未知错误"}`);
  }
}

/** 设置页写密钥：同一个文件，600 权限；空串拒收 */
export async function writeTypesafeKey(key: string, machineDir?: string): Promise<void> {
  const k = key.trim();
  if (!k || /\s/.test(k)) throw new Error("TypeSafe key 不能为空，也不能含空白");
  const file = typesafeKeyFile(machineDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, k, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

function validAnswer(q: JevQuestion, a: unknown): a is JevAnswer {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  if (q.type === "noul") return x.type === "noul" && typeof x.noul === "number" && x.noul >= 0 && x.noul <= 1;
  return x.type === "choice" && typeof x.choice === "string" && Object.hasOwn(q.criteria, x.choice) && !!x.probabilities && typeof x.probabilities === "object";
}

/** 返回形状逐项核对：少一个答案、类型不对、概率越界都算「返回形状不对」 */
export function parseJevBody(body: unknown, questions: Record<string, JevQuestion>, ms: number): JevResponse {
  const b = body as { model?: unknown; answers?: Record<string, unknown>; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null;
  if (!b || typeof b !== "object" || !b.answers || typeof b.answers !== "object") throw new JevError("返回形状不对：没有 answers");
  for (const [id, q] of Object.entries(questions)) {
    if (!validAnswer(q, b.answers[id])) throw new JevError(`返回形状不对：问题 ${id} 的答案缺失或类型不对`);
  }
  const input = Number(b.usage?.input_tokens ?? NaN), output = Number(b.usage?.output_tokens ?? 0);
  if (!Number.isFinite(input)) throw new JevError("返回形状不对：没有 usage.input_tokens");
  return { model: typeof b.model === "string" ? b.model : JEV_MODEL, answers: b.answers as Record<string, JevAnswer>, usage: { input_tokens: input, output_tokens: output }, ms };
}

function httpReason(status: number): string {
  if (status === 401) return "TypeSafe 拒绝了密钥（401）：检查设置页的 key";
  if (status === 429) return "TypeSafe 限流（429）：稍后重跑 check";
  if (status === 422) return "TypeSafe 说请求形状不对（422）：这是代码问题，报给开发";
  if (status >= 500) return `TypeSafe 服务出错（${status}）：稍后重跑 check`;
  return `TypeSafe 返回 HTTP ${status}`;
}

export interface JevDeps { fetchImpl?: typeof fetch; machineDir?: string; timeoutMs?: number }

/** 默认调用器：每次现读密钥；任何失败都抛 JevError（原因是人话，不含密钥） */
export function makeJevCaller(deps: JevDeps = {}): JevCaller {
  return async (state, questions) => {
    const { key } = await resolveTypesafeKey(deps.machineDir);
    if (!key) throw new JevError("没配 TypeSafe 密钥（环境变量 TYPESAFE_API_KEY 或设置页）");
    const started = Date.now();
    let res: Response;
    try {
      res = await (deps.fetchImpl ?? fetch)(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? JEV_TIMEOUT_MS),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      throw new JevError(name === "TimeoutError" || name === "AbortError" ? `TypeSafe 超时（${(deps.timeoutMs ?? JEV_TIMEOUT_MS) / 1000} 秒）` : `连不上 TypeSafe：${(e as Error)?.message ?? String(e)}`);
    }
    if (!res.ok) throw new JevError(httpReason(res.status));
    let body: unknown;
    try { body = await res.json(); } catch { throw new JevError("返回形状不对：不是 JSON"); }
    return parseJevBody(body, questions, Date.now() - started);
  };
}
