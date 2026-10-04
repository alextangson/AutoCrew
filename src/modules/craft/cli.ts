/**
 * `npm run craft:fetch -- <视频网址...> [--out <目录>] [--comments N] [--clean <博主>]` 的参数解析与执行。
 */
import { cleanCreator, MAX_COMMENTS, runCraftFetch, type FetchSummary } from "./fetch.js";
import { execYtdlp, type YtdlpExec } from "./ytdlp.js";

export interface CraftArgs { urls: string[]; out?: string; comments: number; clean?: string }

export const USAGE = "用法：npm run craft:fetch -- <YouTube 视频网址...> [--out <目录>] [--comments N(≤100)] | --clean <博主>";

export function parseCraftArgs(argv: string[]): CraftArgs | { error: string } {
  const a: CraftArgs = { urls: [], comments: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string | undefined => argv[++i];
    if (arg === "--out") a.out = next();
    else if (arg === "--clean") a.clean = next();
    else if (arg === "--comments") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1 || n > MAX_COMMENTS) return { error: `--comments 要 1–${MAX_COMMENTS} 的整数` };
      a.comments = n;
    } else if (arg.startsWith("--")) return { error: `不认识的参数：${arg}` };
    else a.urls.push(arg);
  }
  if (a.out === undefined && argv.includes("--out")) return { error: "--out 后面要跟目录" };
  if (a.clean !== undefined && a.urls.length) return { error: "--clean 单独用，不和视频网址一起" };
  if (a.clean === undefined && argv.includes("--clean")) return { error: "--clean 后面要跟博主名" };
  if (a.clean === undefined && !a.urls.length) return { error: USAGE };
  return a;
}

export function summaryText(s: FetchSummary): string {
  if (s.error) return `没跑成：${s.error}`;
  const lines = [`输出目录：${s.outDir}`, `完成 ${s.done} 条，失败 ${s.failed} 条，没抓 ${s.notAttempted} 条（明细见 index.json）`];
  if (s.stopped) lines.push(s.stopped);
  return lines.join("\n");
}

/** 返回进程退出码：全部完成 0，否则 1 */
export async function runCraftCli(argv: string[], exec: YtdlpExec = execYtdlp(), log: (s: string) => void = console.log): Promise<number> {
  const a = parseCraftArgs(argv);
  if ("error" in a) { log(a.error); return 1; }
  if (a.clean !== undefined) {
    const r = await cleanCreator(a.clean);
    log(r.removed ? `已删除 ${r.dir}` : `没有这个目录，不用删：${r.dir}`);
    return 0;
  }
  const s = await runCraftFetch({ urls: a.urls, outDir: a.out, comments: a.comments, exec, log });
  log(summaryText(s));
  return s.ok ? 0 : 1;
}
