/**
 * `ego:open_console`：在 ego lite 里打开平台后台让人登录（2026-10-25 创始人：视频号重登录别开 Chrome）。
 *
 * 数据回流和发布都跑在 ego lite 里、用它 profile 里的登录态；在默认浏览器（Chrome）里登录对它们没用。
 * 地址只按平台在服务端查（回流后台 / 发布页），不接页面传来的任意链接。
 * ego lite 没装 / 没开着：照实说并给出地址，让人自己在 ego lite 里打开——不退回默认浏览器。
 */
import { EgoChannelError, parseEgoOutput, spawnEgoRunner, type EgoRunner } from "../adapters/browser/ego-session.js";
import { openForUserScript } from "../adapters/browser/ego-scripts.js";
import { PULL_PLATFORM_CONSOLES, PULL_PLATFORM_LABELS, isPullPlatform } from "../modules/flywheel/pull-state.js";
import { PLATFORM_CAPS, type PlatformId } from "../modules/publish/platform-caps.js";

const OPEN_TIMEOUT_MS = 30_000;

let runnerOverride: EgoRunner | null = null;
/** 测试注入：绝不碰真 ego lite */
export function setOpenConsoleRunner(r: EgoRunner | null): void { runnerOverride = r; }

type Target = "data" | "publish";

function consoleOf(platform: unknown, target: Target): { url: string; label: string } | null {
  if (typeof platform !== "string") return null;
  if (target === "data") return isPullPlatform(platform) ? { url: PULL_PLATFORM_CONSOLES[platform], label: PULL_PLATFORM_LABELS[platform] } : null;
  const caps = (PLATFORM_CAPS as Record<string, (typeof PLATFORM_CAPS)[PlatformId] | undefined>)[platform];
  if (caps?.publishChannel === "ego_lite" && caps.publishUrl) return { url: caps.publishUrl, label: caps.label };
  // 公众号发布走接口 + ego lite 里的编辑器：没有发布页就开它的后台
  return isPullPlatform(platform) ? { url: PULL_PLATFORM_CONSOLES[platform], label: PULL_PLATFORM_LABELS[platform] } : null;
}

/** 打不开时给人看的下一步：装 / 开 ego lite，或自己在 ego lite 里打开这个地址 */
function fallback(err: unknown, url: string): string {
  const code = err instanceof EgoChannelError ? err.code : "";
  if (code === "ego_missing") return `没找到 ego lite（ego-browser 命令）：先安装并打开 ego lite（https://lite.ego.app/），再点一次；或者装好后在 ego lite 里打开 ${url} 登录。不要在 Chrome 里登录，回流用不上`;
  if (code === "ego_unreachable" || code === "ego_spawn_failed") return `ego lite 没在运行：先打开 ego lite 再点一次；或者直接在 ego lite 里打开 ${url} 登录。不要在 Chrome 里登录，回流用不上`;
  if (code === "ego_timeout") return `ego lite 半分钟没打开页面：看一下 ego lite 是不是卡住了；也可以直接在 ego lite 里打开 ${url} 登录`;
  return `在 ego lite 里打开后台失败（${err instanceof Error ? err.message : String(err)}）：直接在 ego lite 里打开 ${url} 登录`;
}

export async function openConsoleHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target: Target = payload.target === "publish" ? "publish" : "data";
  const c = consoleOf(payload.platform, target);
  if (!c) return { ok: false, error: `不认识的平台「${String(payload.platform ?? "")}」，或它的${target === "publish" ? "发布" : "数据"}后台不在 ego lite 里开` };
  const runner = runnerOverride ?? spawnEgoRunner();
  try {
    parseEgoOutput(await runner(openForUserScript({ space: `autocrew-登录-${String(payload.platform)}-${Date.now()}`, url: c.url }), OPEN_TIMEOUT_MS));
    return { ok: true, data: { url: c.url, message: `已在 ego lite 里打开${c.label}后台：在那里登录好，再回来点「登录好了，重抓」` } };
  } catch (err) {
    return { ok: false, error: fallback(err, c.url), data: { url: c.url } };
  }
}
