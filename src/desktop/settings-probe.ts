/**
 * settings:test_route — 设置页每张路由卡片的「测试」按钮。
 *
 * 为什么存在：在这之前，填完 Key/端点/模型点保存，成没成要等到下一次写稿失败才知道。
 * 配置面没有反馈闭环就等于让用户拿生产任务当探针。
 *
 * 两条安全纪律：
 *   1. **只认已保存的配置**。payload 里永远不接受裸 baseUrl/apiKey——否则这个通道
 *      就成了"拿用户的 key 打任意地址"的跳板，也会造成"测的和存的不是一份"。
 *      target 只是个选择器（档位名 / 路由名 / 端点选项 id），配置一律从 engine.json 现读。
 *   2. 错误原样透出，只过 cleanErrorMessage 剥本地路径与堆栈——上游说 401 就写 401，
 *      不翻译成"配置有误"这种把线索抹掉的话。
 */
import { loadEngineConfig, resolveEngineRoute, type EngineConfig, type EngineRouteName } from "../engine/config.js";
import { probeEngineRoute } from "../engine/probe.js";
import { resolveChatModel } from "./chat-router.js";
import { cleanErrorMessage } from "./error-clean.js";

/** 路由名（走 resolveEngineRoute）；其余 target 一律交给 resolveChatModel */
const ROUTE_TARGETS = new Set<EngineRouteName>(["writer", "analytics", "scout", "codex"]);

/**
 * 错误消息人话化。**只做两件事，语义一个字不改**：
 *   1. 拆掉观察器/上游的 JSON 错误信封——`401 {"error":{"message":"invalid x-api-key"}}`
 *      对用户就是一串噪音，真正有用的是里面那句和状态码。
 *   2. undici 把 DNS/连接失败一律叫 "fetch failed"，那三个字说明不了任何事；
 *      补一句它到底意味着什么，原文保留在括号里，不掩盖。
 */
export function humanizeProbeError(raw: string): string {
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

function pickTarget(config: EngineConfig, target: string): { ok: true; config: EngineConfig; model: string } | { ok: false; error: string } {
  if (ROUTE_TARGETS.has(target as EngineRouteName)) {
    // 未单独配的专线原样落到主通道强模型——测的就是它真实生效的那一档
    const r = resolveEngineRoute(config, target as EngineRouteName, config.strongModel);
    return { ok: true, config: r.config, model: r.model };
  }
  return resolveChatModel(config, target);
}

/** 测试注入口（镜像 buildIpcHandlers 的 deps 模式）：缺省即真实探针 */
export interface ProbeDeps {
  probe?: typeof probeEngineRoute;
}

export async function testEngineRoute(
  payload: Record<string, unknown>,
  deps: ProbeDeps = {},
): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const target = typeof payload.target === "string" ? payload.target.trim() : "";
  if (!target) return { ok: false, error: "settings:test_route 需要 target" };

  let config: EngineConfig;
  try {
    config = await loadEngineConfig((payload._dataDir as string) || undefined);
  } catch {
    // loadEngineConfig 缺 key 就抛，原文是给终端用户的命令行口径——设置页里说人话
    return { ok: false, error: "还没配 API Key：先在「主通道」填 Key 并保存，再回来测试" };
  }

  const picked = pickTarget(config, target);
  if (!picked.ok) return { ok: false, error: picked.error };

  const result = await (deps.probe ?? probeEngineRoute)(picked.config, picked.model);
  if (!result.ok) return { ok: false, error: humanizeProbeError(cleanErrorMessage(result.error ?? "未知错误")) };
  // 只报能负责的两件事：多久、用的哪个模型名。上游到底拿什么模型答的，这条链路看不见（见 probe.ts）
  return { ok: true, data: { ms: result.ms, model: picked.model } };
}
