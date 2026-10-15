/**
 * `autocrew init`（onboarding-connect §7.3，O16）：一条命令串起「接上调用方自己」+「建资料库并当场生效」。
 * 可重复跑：做过的步骤跳过并说明；某一步失败就停在那一步，给原文错误和下一步，绝不报成功。
 * 画像和试跑靠对话（docs/SETUP-FOR-AGENTS.md），不放进命令。
 */
import { connectHost } from "./host-connect/connect.js";
import { detectHost, HOST_LABEL, parseConnectHost, type ConnectHost, type HostStatus } from "./host-connect/detect.js";
import type { HostEnv } from "./host-connect/env.js";
import type { ConnectResult } from "./host-connect/connect.js";
import { defaultLibraryPath, setupLibrary, type LegacyChoice, type SetupResult } from "../storage/library-setup.js";

export interface InitOptions { host?: string; library?: string; legacy?: string }
export interface InitStep { step: "connect" | "library"; state: "done" | "skipped" | "failed" | "needs_answer"; message: string; next?: string; error?: string }
export interface InitReport { ok: boolean; exitCode: 0 | 1 | 2; steps: InitStep[] }

export interface InitDeps {
  env: HostEnv;
  /** 守护进程在跑时经它建库（服务自己占住新库写入权）；没跑返回 null，在本进程里建 */
  serviceSetup: (body: { target: string; legacy?: LegacyChoice }) => Promise<SetupResult | null>;
  detect?: (host: ConnectHost, env: HostEnv) => Promise<HostStatus>;
  connect?: (host: ConnectHost, env: HostEnv) => Promise<ConnectResult>;
  processEnv?: NodeJS.ProcessEnv;
}

/** 调用方是谁：显式 --host 优先；在 Claude Code 里跑时它会设 CLAUDECODE=1 */
export function resolveCaller(flag: string | undefined, env: NodeJS.ProcessEnv): ConnectHost | null {
  if (flag) return parseConnectHost(flag);
  return env.CLAUDECODE === "1" ? "claude" : null;
}

async function connectStep(opts: InitOptions, deps: InitDeps): Promise<InitStep> {
  const host = resolveCaller(opts.host, deps.processEnv ?? process.env);
  if (!host) {
    return { step: "connect", state: "failed", message: opts.host ? `不认识「${opts.host}」` : "不知道你是哪个 AI",
      next: "加上 --host claude（或 codex / workbuddy）再跑 autocrew init" };
  }
  const status = await (deps.detect ?? detectHost)(host, deps.env);
  if (status.connected) return { step: "connect", state: "skipped", message: `${HOST_LABEL[host]} 之前已经接上，跳过` };
  const r = await (deps.connect ?? connectHost)(host, deps.env);
  if (r.ok && r.verified) return { step: "connect", state: "done", message: r.message };
  return { step: "connect", state: "failed", message: `${HOST_LABEL[host]} 没接上`, error: r.error ?? r.message,
    next: `照上面的原因处理后重跑 autocrew init --host ${host}；也可以单独跑 autocrew connect ${host} 看详细结果` };
}

function libraryStep(r: SetupResult, target: string): InitStep {
  switch (r.status) {
    case "already": return { step: "library", state: "skipped", message: `资料库已经建好（${r.root}），跳过` };
    case "created": return { step: "library", state: "done", message: `资料库建好了：${r.root}，已经生效` };
    case "opened": return { step: "library", state: "done", message: `${r.root} 本来就是 AutoCrew 资料库，已经接上用` };
    case "migrated": return { step: "library", state: "done", message: `资料库建好了：${r.root}，旧稿已搬进去（搬前备份在 ${r.backup}）` };
    case "queued_restart": return { step: "library", state: "needs_answer", message: `旧稿已备份到 ${r.backup}；搬家要重启一次服务才执行，现在还没生效`,
      next: "先确认没有正在写的稿（GET /api/update/busy），再 npm run restart；重启后重跑 autocrew init 确认" };
    case "needs_legacy_choice": return { step: "library", state: "needs_answer", message: `你在旧位置（~/.autocrew）已有 ${r.drafts} 篇稿，要搬进新资料库吗？`,
      next: `问用户后重跑：搬 → autocrew init --library "${target}" --legacy migrate（搬前会先备份）；不搬 → --legacy keep（旧稿留在原处）` };
    case "refused": return { step: "library", state: "failed", message: "资料库没建", error: r.error,
      next: r.suggestion ? `换一个位置重跑，比如 autocrew init --library "${r.suggestion}"` : "换一个位置重跑 autocrew init --library <路径>" };
  }
}

export async function runInit(opts: InitOptions, deps: InitDeps): Promise<InitReport> {
  const steps: InitStep[] = [await connectStep(opts, deps)];
  if (steps[0].state === "failed") return { ok: false, exitCode: 1, steps };
  const legacy: LegacyChoice | undefined = opts.legacy === "migrate" || opts.legacy === "keep" ? opts.legacy : undefined;
  if (opts.legacy && !legacy) {
    steps.push({ step: "library", state: "failed", message: `--legacy 只能是 migrate 或 keep，收到「${opts.legacy}」`, next: "改正后重跑" });
    return { ok: false, exitCode: 1, steps };
  }
  const target = opts.library ?? defaultLibraryPath();
  try {
    const body: { target: string; legacy?: LegacyChoice } = { target, ...(legacy ? { legacy } : {}) };
    const r = (await deps.serviceSetup(body)) ?? (await setupLibrary(body));
    steps.push(libraryStep(r, target));
  } catch (err) {
    steps.push({ step: "library", state: "failed", message: "建资料库出错", error: err instanceof Error ? err.message : String(err), next: "把这段原文发给维护者；修好后重跑 autocrew init" });
  }
  const last = steps[steps.length - 1];
  const exitCode = last.state === "failed" ? 1 : last.state === "needs_answer" ? 2 : 0;
  return { ok: exitCode === 0, exitCode, steps };
}

export function formatInit(report: InitReport): string {
  const mark = { done: "✓", skipped: "✓", failed: "✕", needs_answer: "?" } as const;
  return report.steps.map((s) => [
    `${mark[s.state]} ${s.message}`,
    ...(s.error ? [`  原因：${s.error}`] : []),
    ...(s.next ? [`  下一步：${s.next}`] : []),
  ].join("\n")).join("\n") + (report.ok ? "\n全部完成。接下来在对话里做用户画像和试跑（见 docs/SETUP-FOR-AGENTS.md）。" : "");
}
