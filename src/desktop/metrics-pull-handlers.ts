/**
 * 自动回流控制面的三个通道（spec §4.4）：
 *   flywheel:pull_status  读状态（含各平台 in-flight，前端按钮置灰的依据）
 *   flywheel:pull_now     手动触发（无视 nextEligibleAt，但吃同一把 single-flight 锁）
 *   flywheel:pull_toggle  平台开关
 *
 * 状态读失败一律显式回 ok:false——「读不出来」不能被谎报成「三平台都没抓过」。
 */
import {
  PULL_PLATFORMS,
  PULL_PLATFORM_CONSOLES,
  PULL_PLATFORM_LABELS,
  defaultPlatformState,
  isPullPlatform,
  readPullState,
  updatePlatformPullState,
  type PullPlatform,
} from "../modules/flywheel/pull-state.js";
import {
  PULL_TTL_MS,
  inFlightPlatforms,
  pullPlatformNow,
} from "./metrics-pull-cycle.js";

type Payload = Record<string, unknown>;
type HandlerResult = Record<string, unknown>;

function dataDirOf(payload: Payload): string | undefined {
  return (payload._dataDir as string) || undefined;
}

function badPlatform(value: unknown): HandlerResult | null {
  if (isPullPlatform(value)) return null;
  return { ok: false, error: `platform 必须是 ${PULL_PLATFORMS.join(" / ")} 之一` };
}

export async function pullStatusHandler(payload: Payload): Promise<HandlerResult> {
  const dataDir = dataDirOf(payload);
  try {
    const state = await readPullState(dataDir);
    const running = new Set(inFlightPlatforms(dataDir));
    return {
      ok: true,
      data: {
        ttlHours: Math.round(PULL_TTL_MS / 3_600_000),
        platforms: PULL_PLATFORMS.map((platform) => ({
          platform,
          label: PULL_PLATFORM_LABELS[platform],
          consoleUrl: PULL_PLATFORM_CONSOLES[platform],
          inFlight: running.has(platform),
          ...(state.platforms[platform] ?? defaultPlatformState()),
        })),
      },
    };
  } catch (err) {
    // 状态文件读不出来（权限/设备故障）≠ 没抓过：如实报错，界面显示「不可用」
    return { ok: false, error: `回流状态读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function pullNowHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPlatform(payload.platform);
  if (bad) return bad;
  const platform = payload.platform as PullPlatform;
  try {
    // 手动触发不看 nextEligibleAt（人明确要抓），但走同一入口吃 single-flight
    const attempt = await pullPlatformNow(platform, { dataDir: dataDirOf(payload), trigger: "manual" });
    return { ok: true, data: attempt };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function pullToggleHandler(payload: Payload): Promise<HandlerResult> {
  const bad = badPlatform(payload.platform);
  if (bad) return bad;
  if (typeof payload.enabled !== "boolean") return { ok: false, error: "enabled 必须是布尔值" };
  const platform = payload.platform as PullPlatform;
  const enabled = payload.enabled;
  try {
    const state = await updatePlatformPullState(
      platform,
      // 开启时清掉退避锚点：人刚打开开关，不该还被上一次失败的 1 小时冷却挡着
      (prev) => ({ ...prev, enabled, ...(enabled ? { nextEligibleAt: null } : {}) }),
      dataDirOf(payload),
    );
    return { ok: true, data: { platform, enabled: state.platforms[platform].enabled } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
