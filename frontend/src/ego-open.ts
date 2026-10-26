/**
 * 「打开 XX 后台 / 要登录」一律在 ego lite 里开（2026-10-25）：数据回流和发布都用 ego lite 的登录态，
 * 在默认浏览器（Chrome）里登录对它们没用。打不开（没装 / 没开着）时把服务端给的下一步照原样提示出来。
 */
import { invoke } from "./transport";
import { toast } from "./ui";

export type ConsoleTarget = "data" | "publish";

/** 结果文案：成功说去 ego lite 里登录；失败说怎么办（服务端已写好人话，含地址） */
export function openConsoleMessage(r: { ok: boolean; error?: string; data?: unknown }): string {
  if (r.ok) return (r.data as { message?: string } | undefined)?.message ?? "已在 ego lite 里打开后台";
  return r.error ?? "在 ego lite 里打开后台失败";
}

export async function openInEgo(platform: string, target: ConsoleTarget = "data"): Promise<boolean> {
  const r = await invoke("ego:open_console", { platform, target });
  toast(openConsoleMessage(r));
  return r.ok;
}
