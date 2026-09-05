/**
 * settings:test_route — 设置页每个端点的「测试」按钮。
 *
 * 为什么存在：在这之前，填完 Key/端点/模型点保存，成没成要等到下一次写稿失败才知道。
 * 配置面没有反馈闭环就等于让用户拿生产任务当探针。
 *
 * 两条安全纪律：
 *   1. **只认已保存的配置**。payload 里永远不接受裸 baseUrl/apiKey——否则这个通道
 *      就成了"拿用户的 key 打任意地址"的跳板，也会造成"测的和存的不是一份"。
 *      target 只是个选择器（端点 id + 模型名），配置一律从 engine.json 现读。
 *   2. 错误原样透出，只过 cleanErrorMessage 剥本地路径与堆栈——上游说 401 就写 401，
 *      不翻译成"配置有误"这种把线索抹掉的话。
 *
 * P2 起测的是**端点**不是岗位（spec §4.1）：端点表里任一条都能测，审稿专线自然可测，
 * 岗位白名单删除。每次测试的结果同时落进健康通道——设置页的状态点与顶栏横幅
 * 与这个按钮看的是同一份事实。翻译归 engine/failure-text.ts（全产品唯一那一个）。
 */
import { loadEngineConfig, type EngineConfig } from "../engine/config.js";
import { describeProbeFailure } from "../engine/failure-text.js";
import { probeEngineRoute } from "../engine/probe.js";
import { recordProbeResult } from "./engine-health.js";
import { cleanErrorMessage } from "./error-clean.js";

/** 测试注入口（镜像 buildIpcHandlers 的 deps 模式）：缺省即真实探针 */
export interface ProbeDeps {
  probe?: typeof probeEngineRoute;
  record?: typeof recordProbeResult;
}

function safeHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}

export async function testEngineRoute(
  payload: Record<string, unknown>,
  deps: ProbeDeps = {},
): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const providerId = typeof payload.provider_id === "string" ? payload.provider_id.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!providerId || !model) return { ok: false, error: "settings:test_route 需要 provider_id 与 model" };

  let config: EngineConfig;
  try {
    config = await loadEngineConfig((payload._dataDir as string) || undefined);
  } catch {
    // loadEngineConfig 缺 key 就抛，原文是给终端用户的命令行口径——设置页里说人话
    return { ok: false, error: "还没配 API Key：先在「主端点」填 Key 并保存，再回来测试" };
  }

  const provider = (config.providers ?? []).find((p) => p.id === providerId);
  if (!provider) {
    return { ok: false, error: `找不到端点「${cleanErrorMessage(providerId, 40)}」——它可能已被删掉，刷新设置页再试` };
  }
  const probeConfig: EngineConfig = {
    ...config,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    protocol: provider.protocol,
    activeProvider: { id: provider.id, role: "probe" },
  };
  const result = await (deps.probe ?? probeEngineRoute)(probeConfig, model);
  // 探针结果进健康通道（spec §4.1 的四个更新时机之一）；写不进去不该让「测试」本身失败
  const host = safeHost(provider.baseUrl);
  await (deps.record ?? recordProbeResult)(provider.id, result, (payload._dataDir as string) || undefined, host).catch(() => {});
  if (!result.ok) return { ok: false, error: describeProbeFailure(cleanErrorMessage(result.error ?? "未知错误"), { id: provider.id, host }) };
  // 只报能负责的两件事：多久、用的哪个模型名。上游到底拿什么模型答的，这条链路看不见（见 probe.ts）
  return { ok: true, data: { ms: result.ms, model, providerId: provider.id } };
}
