/**
 * 认稿弹窗的系统动作：`open` 预览（原片 / 定稿 / 工作台）与交接成功后的不阻塞通知窗。
 * 都是注入口（pull-deps），测试换假的——绝不真 open、不弹真窗。
 * 全体测试另有 src/test-setup 把本模块整体换成不碰系统的假实现。
 */
import { spawn } from "node:child_process";
import { runProcess } from "../proc.js";
import { probeMedia } from "../ingest.js";

export type OpenOutcome = { ok: true } | { ok: false; reason: string };
export type Opener = (target: string) => Promise<OpenOutcome>;
export type Notifier = (opts: { title: string; message: string; url: string }) => Promise<OpenOutcome>;

/** `open <路径或网址>`：交给系统默认程序；失败（文件没了、没有默认程序）带原因回来 */
export const systemOpener: Opener = async (target) => {
  if (process.platform !== "darwin") return { ok: false, reason: "不是 macOS" };
  const raw = await runProcess({ command: "open", args: [target], timeoutMs: 15_000 });
  if (raw.spawnError) return { ok: false, reason: `open 起不来：${raw.spawnError}` };
  if (raw.timedOut) return { ok: false, reason: "open 超时没反应" };
  if (raw.code !== 0) return { ok: false, reason: raw.stderr.trim().slice(0, 200) || `退出码 ${String(raw.code)}` };
  return { ok: true };
};

const NOTICE_SCRIPT = [
  "on run argv",
  "set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {\"打开工作台\", \"好\"} default button \"好\" giving up after 600",
  "if button returned of r is \"打开工作台\" then open location (item 3 of argv)",
  "end run",
];

/** 起窗后观察这么久：起不来（找不到 osascript）或没有图形会话会在这段时间内报错退出 */
const NOTICE_WATCH_MS = 1500;

/**
 * 分离的 osascript 子进程：数据经 argv 传，不拼进脚本。只观察开头一小段——
 * 这段里报错或非零退出就回失败原因；还开着 = 窗已弹出，放手不等创始人点。
 */
export const osascriptNotifier: Notifier = ({ title, message, url }) => {
  if (process.platform !== "darwin") return Promise.resolve({ ok: false, reason: "不是 macOS" });
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (r: OpenOutcome) => { if (!settled) { settled = true; resolve(r); } };
    const child = spawn("osascript", [...NOTICE_SCRIPT.flatMap((l) => ["-e", l]), title, message, url], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e) => finish({ ok: false, reason: `osascript 起不来：${e.message}` }));
    child.on("exit", (code) => finish(code === 0 ? { ok: true } : { ok: false, reason: stderr.trim().slice(0, 200) || `osascript 退出码 ${String(code)}` }));
    const timer = setTimeout(() => {
      child.stderr?.destroy();
      child.unref();
      finish({ ok: true });
    }, NOTICE_WATCH_MS);
    timer.unref?.();
  });
};

/** 工作台是否在跑：根路径有任何响应就算通 */
export async function benchReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** 媒体时长（毫秒），读不出回 null */
export async function mediaDuration(file: string): Promise<number | null> {
  const probed = await probeMedia(file).catch(() => null);
  return probed?.ok && probed.probe.durationMs > 0 ? probed.probe.durationMs : null;
}
