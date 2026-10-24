/**
 * 审阅页的正文排版（所见即所推）：用推送时同一个排版脚本（vendor/wechat-format/scripts/format.py，经 uv run）
 * 和同一个主题，把这一包的 markdown（配图换成包里的本地文件）排成公众号版式，审阅页直接嵌进去。
 * 排版失败（uv 没装、主题不存在、脚本报错）→ 返回原始原因，审阅页明写「没排出来」，不拿未排版的正文冒充最终样子。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ArticleImageEntry } from "../publish/article-images.js";
import { articleMarkdown } from "./push-stage.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_PUBLISH_SCRIPT = path.join(REPO_ROOT, "vendor", "wechat-format", "scripts", "publish.py");

export type FormattedBody = { ok: true; theme: string; html: string } | { ok: false; theme: string; error: string };

export interface FormatInput { title: string; body: string; entries: ArticleImageEntry[]; theme: string; dir: string; publishScript?: string }
export interface FormatDeps { uv?: string; timeoutMs?: number }

/** format.py 和 publish.py 同目录：推送用哪个脚本，审阅页就用它旁边的排版脚本 */
export function formatScriptPath(publishScript?: string): string {
  return path.join(path.dirname(publishScript || process.env.AUTOCREW_WECHAT_PUBLISH_SCRIPT || DEFAULT_PUBLISH_SCRIPT), "format.py");
}

/** 推送用的 markdown，配图标记按顺序换成包里的本地文件（和推送时 wechat-mp 的替换同一写法） */
async function stageMarkdown(i: FormatInput, srcDir: string): Promise<string> {
  let md = articleMarkdown(i.title, i.body, i.entries);
  let k = 0;
  const parts: string[] = [];
  const marker = /\[IMAGE:\s*(.+?)\]/g;
  let last = 0;
  for (let m = marker.exec(md); m; m = marker.exec(md)) {
    const n = k++;
    const e = i.entries.find((x) => x.index === n);
    let rep = `**（配图 ${n + 1} 还没有图）**`;
    if (e?.status === "ready" && e.imagePath) {
      const name = `img-${String(n + 1).padStart(2, "0")}${path.extname(e.imagePath).toLowerCase() || ".png"}`;
      await fs.copyFile(e.imagePath, path.join(srcDir, name));
      rep = `![${m[1].trim().slice(0, 30)}](${name})`;
    }
    parts.push(md.slice(last, m.index), rep);
    last = m.index + m[0].length;
  }
  md = parts.join("") + md.slice(last);
  return md;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { out += String(c); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); out += `\n排版超时（${timeoutMs / 1000} 秒）`; }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out: `${out}\n${e.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

const tail = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4).join("；") || "脚本没有输出";

/** 排一次；同一份 markdown + 主题排过就直接读上次的结果 */
export async function formatArticleBody(i: FormatInput, deps: FormatDeps = {}): Promise<FormattedBody> {
  const fail = (error: string): FormattedBody => ({ ok: false, theme: i.theme, error });
  const uv = deps.uv ?? "uv";
  const script = formatScriptPath(i.publishScript);
  if (spawnSync(uv, ["--version"], { stdio: "ignore" }).error) return fail("uv 没装：排版脚本经 uv 运行（autocrew doctor 可检查）");
  try { await fs.access(script); } catch { return fail(`排版脚本不存在：${script}`); }
  const srcDir = path.join(i.dir, "src");
  await fs.rm(i.dir, { recursive: true, force: true });
  await fs.mkdir(srcDir, { recursive: true });
  const md = await stageMarkdown(i, srcDir);
  await fs.writeFile(path.join(srcDir, "article.md"), md, "utf-8");
  const vendorRoot = path.dirname(path.dirname(script));
  await ensureConfig(vendorRoot);
  const outBase = path.join(i.dir, "out");
  const r = await run(uv, ["run", script, "--input", path.join(srcDir, "article.md"), "--theme", i.theme, "--output", outBase, "--format", "wechat", "--no-open"], vendorRoot, deps.timeoutMs ?? 120_000);
  if (r.code !== 0) return fail(`排版脚本报错：${tail(r.out)}`);
  const outDir = path.join(outBase, "article");
  let html: string;
  try { html = await fs.readFile(path.join(outDir, "article.html"), "utf-8"); } catch { return fail(`排版脚本没有产出 article.html：${tail(r.out)}`); }
  const base = pathToFileURL(outDir + path.sep).href;
  return { ok: true, theme: i.theme, html: html.replace(/(src=["'])(images\/[^"']+)/g, (_m, a: string, p: string) => `${a}${base}${p}`) };
}

/** 排版脚本 import 期就读同级 config.json；缺了从 example 兜底（与推送路径同一做法） */
async function ensureConfig(vendorRoot: string): Promise<void> {
  const cfg = path.join(vendorRoot, "config.json");
  try { await fs.access(cfg); } catch { await fs.copyFile(path.join(vendorRoot, "config.example.json"), cfg).catch(() => undefined); }
}

/** 缓存键：markdown 输入 + 配图字节 + 主题 */
export async function formatKey(i: Omit<FormatInput, "dir">): Promise<string> {
  const h = createHash("sha256").update(i.theme).update("\0").update(i.title).update("\0").update(i.body);
  for (const e of i.entries) {
    h.update(`\0${e.index}:${e.status}:${e.credit ?? ""}:${e.kind ?? ""}:${e.origin ?? ""}`);
    if (e.imagePath) h.update(await fs.readFile(e.imagePath).catch(() => Buffer.from("missing")));
  }
  return h.digest("hex");
}

/** 带缓存的排版：键一样且上次排成功，就复用上次的 HTML */
export async function formatArticleBodyCached(i: FormatInput, deps: FormatDeps = {}): Promise<FormattedBody> {
  const key = await formatKey(i);
  const stamp = path.join(path.dirname(i.dir), `${path.basename(i.dir)}.json`);
  try {
    const prev = JSON.parse(await fs.readFile(stamp, "utf-8")) as { key: string; html: string };
    if (prev.key === key) return { ok: true, theme: i.theme, html: prev.html };
  } catch { /* 没排过 */ }
  const r = await formatArticleBody(i, deps);
  if (r.ok) await fs.writeFile(stamp, JSON.stringify({ key, html: r.html }), "utf-8");
  else await fs.rm(stamp, { force: true });
  return r;
}
