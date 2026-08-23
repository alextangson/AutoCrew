/**
 * 端点连通性探针 — 设置页「测试」按钮的执行层。
 *
 * 纪律只有一条：**走真实调用那条路**。同一个观察器、同一个 makePiModel（compat 钉死）、
 * 同一个协议分派——探针通了而写稿失败（或反过来）是最没价值的测试结果，
 * 所以这里不许有"轻量版"的另一条实现。
 *
 * 发一次极小的一轮（一句 user、无 system、无工具），成功时回耗时——中转慢不慢，这是唯一的数字。
 *
 * 明确不报「上游实际回的模型名」：pi-ai 的 AssistantMessage.model 填的是**请求时的 id**
 * （openai-completions.js 里 `model: model.id`），不是响应体里的那个，拿它当"上游回了什么"
 * 会永远相等，等于给一个永远不报警的警报。要真做这件事得让观察器解析响应体，
 * 而观察器的职责边界就是"不解析"——这条留白，别用假数据糊上。
 *
 * 超时：观察器的字节级看门狗 + 外部 signal 双保险，绝不挂死在一个不回字节的端点上。
 */
import type { EngineConfig } from "./config.js";
import { registerExchange } from "./observer.js";
import { consumePiStream, makePiModel, startPiStream, toPiContext } from "./pi-wire.js";

export interface ProbeResult {
  ok: boolean;
  /** 整次交换的耗时（ms）——失败时也给，"3ms 就拒了"和"20 秒才超时"是两种病 */
  ms: number;
  /** 原始错误消息（成功时不存在）；脱敏交给调用方（引擎层不认识 UI 的口径） */
  error?: string;
}

export const PROBE_TIMEOUT_MS = 20_000;

export async function probeEngineRoute(
  config: EngineConfig,
  model: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const exchange = await registerExchange({
    upstreamBase: config.baseUrl,
    fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    idleMs: timeoutMs,
    signal: ctrl.signal,
  });
  try {
    await consumePiStream(
      startPiStream(
        config,
        makePiModel(config, model, exchange.baseUrl),
        toPiContext([{ role: "user", content: "ping" }], []),
      ),
    );
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    // 超时的化身很多（观察器掐断、SDK 报连接错误），一律按用户能懂的那句说
    if (ctrl.signal.aborted) {
      return { ok: false, ms: Date.now() - started, error: `超时：${Math.round(timeoutMs / 1000)} 秒内端点没有回任何内容` };
    }
    return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    exchange.release();
  }
}
