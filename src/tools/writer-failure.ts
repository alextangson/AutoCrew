/**
 * 写作线上的「这条线怎么了」——一句人话，两个调用点共用（P2 §4.2 翻译器的下游）。
 *
 * 备料炸了（`pack` 的后台备料，走 scout 那条线）与审稿炸了（`submit`，走 reviewer）
 * 需要说的是同一种话：**哪条线、哪个端点、什么故障、这次产品做了什么**。写两遍就一定会漂，
 * 所以只留这一个入口。分类认不出来（`unknown`）时**不套模板**——宁可把原话清洗一下端出去，
 * 也不用确定的语气说错话。
 */
import { classifyEngineError } from "../engine/error-kind.js";
import { hostOf, loadEngineConfig, resolveEngineRoute } from "../engine/config.js";
import { describeEngineFailure, isEngineFailure } from "../engine/failure-text.js";
import { cleanErrorMessage } from "../desktop/error-clean.js";
import type { EngineRouteName } from "../engine/config-schema.js";

/**
 * @param fallback 分类认不出时说什么（审稿有自己的 reason，备料用清洗过的原文）
 */
export async function describeWriterFailure(
  err: unknown,
  role: EngineRouteName,
  dataDir: string,
  fallback: string,
): Promise<string> {
  const classified = classifyEngineError(err);
  if (!isEngineFailure(classified)) return fallback;
  try {
    const config = await loadEngineConfig(dataDir);
    const route = resolveEngineRoute(config, role, config.strongModel);
    const id = route.config.activeProvider?.id ?? "main";
    const provider = (config.providers ?? []).find((p) => p.id === id);
    return describeEngineFailure({
      role,
      provider: { id, host: hostOf(provider?.baseUrl ?? route.config.baseUrl) },
      classified,
      fallbackAvailable: Boolean(config.fallback),
    });
  } catch {
    // 连引擎配置都读不出来：说得清的只剩这次的原始错误
    return cleanErrorMessage(err) || fallback;
  }
}
