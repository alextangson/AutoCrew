/**
 * 分镜 = 脚本生成的审阅页（spec 2026-09-30-storyboard-review-check）。只收 `build_material_review.py` 产出的
 * `03-broll/review-vNNN/<name>.html`：同目录同名 `<name>.receipt.json`，页面 sha256 = 回执 html_sha256，
 * 回执里的每个素材都还在、sha256 对得上。MD、手写页、生成后手改过的页、项目外、经符号链接 → 拒收并指路。
 *
 * 回执 media[].path 相对脚本的 `--root`，回执里没记 root：从页面所在目录往上逐级试到项目根，
 * 找到一级能让全部素材都对上就算（真实工程里 root = 页面所在的 review-vNNN 目录）。
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isWithin } from "../../storage/storage-roots.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { contentRoot } from "../../storage/content-project.js";
import { getContent } from "../../storage/local-store.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { sha256File } from "../video/handoff/manifest.js";
import { cachedSha, commitSha, SETTLE_MS, STILL_SETTLING, writtenWithin } from "./hash-cache.js";
import { STABLE_MS, STILL_WRITING } from "./files.js";

export const STORYBOARD_HINT = "分镜要用 build_material_review.py 生成 03-broll/review-vNNN/review.html 再报；MD 或手写页不收";
const DIR_RE = /^review-v(\d{3})$/;

export interface StoryboardFile { rel: string; abs: string; sha256: string; version: number; receipt_sha256: string; size: number; mtime_ms: number }
export type Checked<T> = { ok: true; value: T } | { ok: false; code: string; error: string };
const deny = (code: string, why: string): Checked<never> => ({ ok: false, code, error: `${why}。${STORYBOARD_HINT}` });

const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** 逐段 lstat：任何一段是符号链接 / 不存在 → false */
async function plainPath(realRoot: string, rel: string, lastIsFile: boolean): Promise<boolean> {
  const parts = rel.split("/");
  let cur = realRoot;
  for (const [i, part] of parts.entries()) {
    cur = path.join(cur, part);
    const st = await fs.lstat(cur).catch(() => null);
    if (!st || st.isSymbolicLink()) return false;
    if (i < parts.length - 1 ? !st.isDirectory() : lastIsFile ? !st.isFile() : !st.isDirectory()) return false;
  }
  return isWithin(realRoot, await fs.realpath(cur).catch(() => ""));
}

interface Receipt { html_sha256: string; manifest_sha256: string; media: Array<{ item: string; path: string; sha256: string }> }

function parseReceipt(raw: string): Receipt | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.html_sha256 !== "string" || typeof j.manifest_sha256 !== "string" || !Array.isArray(j.media)) return null;
    const media = j.media as Array<Record<string, unknown>>;
    if (!media.every((m) => m && typeof m.path === "string" && typeof m.sha256 === "string" && typeof m.item === "string")) return null;
    return { html_sha256: j.html_sha256, manifest_sha256: j.manifest_sha256, media: media as Receipt["media"] };
  } catch { return null; }
}

/** 素材以 base 为根都对得上：相对路径、真实路径在项目里、是普通文件、sha 一致 */
/**
 * 页面里实际引用的本地资源（src / href，相对页面所在目录解析成绝对路径）。脚本按 relpath 写、再做 URL 与 HTML 转义，
 * 这里反过来还原；带协议的外链和锚点不算。
 */
export function pageRefs(html: string, pageDir: string): Set<string> {
  // 命名实体 + 十进制 / 十六进制数字实体（&#47; &#x2F;）；&amp; 最后还原，免得二次解码
  const unesc = (s: string) => s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const out = new Set<string>();
  const add = (value: string) => {
    const raw = unesc(value).trim();
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return;
    let decoded: string;
    try { decoded = decodeURIComponent(raw.split(/[?#]/)[0]); } catch { return; }
    out.add(path.resolve(pageDir, decoded));
  };
  // 单双引号的 src / href / poster；srcset 按逗号拆、取每段的 URL；CSS url(...)（带不带引号都认）
  for (const m of html.matchAll(/\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2] ?? "");
  for (const m of html.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const part of (m[1] ?? m[2] ?? "").split(",")) add(part.trim().split(/\s+/)[0] ?? "");
  }
  for (const m of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) add(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/**
 * 素材以 base 为根都对得上：相对路径、就是页面实际引用的那个文件（Codex 审 storyboard P2：别让上层目录里
 * 同名同 hash 的文件顶替页面真正加载的素材）、真实路径在项目里、是普通文件、sha 一致
 */
/**
 * 三种核法：scan（对账扫描，按元数据缓存）、record（agent 报上来那一刻，现算、沿用 record 的 10 秒门）、
 * commit（创始人拍板，现算、一分钟内还在变的拒绝）。还在写 → "unsettled"，不算哈希。
 */
export type StoryboardMode = "scan" | "record" | "commit";
const UNSETTLED = "unsettled" as const;
const windowOf = (mode: StoryboardMode) => (mode === "record" ? STABLE_MS : SETTLE_MS);

async function mediaSha(real: string, mode: StoryboardMode): Promise<string | null | typeof UNSETTLED> {
  const st = await fs.stat(real).catch(() => null);
  if (!st?.isFile()) return null;
  if (writtenWithin(st.mtimeMs, windowOf(mode))) return UNSETTLED;
  if (mode === "scan") return (await cachedSha(real).catch(() => null))?.sha256 ?? null;
  if (mode === "record") return sha256File(real).catch(() => null);
  const r = await commitSha(real).catch(() => null);
  return !r ? null : r.ok ? r.sha256 : UNSETTLED;
}

async function mediaMatch(realRoot: string, base: string, media: Receipt["media"], refs: Set<string>, mode: StoryboardMode): Promise<boolean | typeof UNSETTLED> {
  for (const m of media) {
    if (path.isAbsolute(m.path)) return false;
    const abs = path.resolve(base, m.path);
    if (!refs.has(abs)) return false;
    if (!isWithin(realRoot, abs)) return false;
    const real = await fs.realpath(abs).catch(() => null);
    if (!real || !isWithin(realRoot, real)) return false;
    const sha = await mediaSha(real, mode);
    if (sha === UNSETTLED) return UNSETTLED;
    if (sha !== m.sha256) return false;
  }
  return true;
}

/** 核验一个审阅页（§3）。`input` 可以是绝对路径或相对项目根的路径 */
export async function validateStoryboard(projectRoot: string, input: string, mode: StoryboardMode = "record"): Promise<Checked<StoryboardFile>> {
  if (path.extname(input).toLowerCase() !== ".html") return deny("storyboard_not_review_page", `分镜只收脚本生成的 .html 审阅页，收到的是「${path.basename(input)}」`);
  const realRoot = await fs.realpath(projectRoot);
  const abs = path.isAbsolute(input) ? input : path.resolve(realRoot, input);
  const rel = path.relative(realRoot, abs).split(path.sep).join("/");
  const parts = rel.split("/");
  if (rel.startsWith("..") || path.isAbsolute(rel) || parts.length !== 3 || parts[0] !== "03-broll" || !DIR_RE.test(parts[1])) {
    return deny("storyboard_outside", "审阅页要在本条项目的 03-broll/review-vNNN/ 里");
  }
  if (!(await plainPath(realRoot, rel, true))) return deny("storyboard_outside", "审阅页不存在，或路径里有符号链接");
  const receiptRel = rel.replace(/\.html$/i, ".receipt.json");
  if (!(await plainPath(realRoot, receiptRel, true))) return deny("storyboard_no_receipt", "审阅页旁边没有脚本写的回执（同名 .receipt.json）");
  const stillWriting = deny("storyboard_unsettled", mode === "record" ? STILL_WRITING : STILL_SETTLING);
  if ((await Promise.all([rel, receiptRel].map((x) => fs.stat(path.join(realRoot, x))))).some((x) => writtenWithin(x.mtimeMs, windowOf(mode)))) return stillWriting;
  const receiptRaw = await fs.readFile(path.join(realRoot, receiptRel));
  const receipt = parseReceipt(receiptRaw.toString("utf8"));
  if (!receipt) return deny("storyboard_bad_receipt", "审阅页的回执读不出来或缺字段");
  const html = await fs.readFile(path.join(realRoot, rel));
  const st = await fs.stat(path.join(realRoot, rel));
  if (sha256(html) !== receipt.html_sha256) return deny("storyboard_edited", "审阅页被手改过，请用脚本重新生成");
  let ok: boolean | typeof UNSETTLED = false;
  const refs = pageRefs(html.toString("utf8"), path.dirname(path.join(realRoot, rel)));
  for (let base = path.dirname(path.join(realRoot, rel)); isWithin(realRoot, base); base = path.dirname(base)) {
    ok = await mediaMatch(realRoot, base, receipt.media, refs, mode);
    if (ok) break;
    if (base === realRoot) break;
  }
  if (ok === UNSETTLED) return stillWriting;
  if (!ok) return deny("storyboard_media_changed", "审阅页引用的素材不见了 / 变了");
  return { ok: true, value: { rel, abs: path.join(realRoot, rel), sha256: sha256(html), version: Number(DIR_RE.exec(parts[1])![1]), receipt_sha256: sha256(receiptRaw), size: st.size, mtime_ms: Math.trunc(st.mtimeMs) } };
}

/** 事实里的路径（相对项目）再核一遍位置安全，返回绝对路径；不合规 → null */
export async function storyboardFile(projectRoot: string, fact: Fact): Promise<string | null> {
  if (fact.kind !== "storyboard" || !fact.path || path.isAbsolute(fact.path)) return null;
  const realRoot = await fs.realpath(projectRoot).catch(() => null);
  if (!realRoot || !(await plainPath(realRoot, fact.path, true))) return null;
  return path.join(realRoot, fact.path);
}

/** 03-broll/review-vNNN/*.html 里合规的审阅页（对账导入用；不合规的静默跳过，E11） */
export async function scanStoryboards(projectRoot: string): Promise<StoryboardFile[]> {
  const out: StoryboardFile[] = [];
  const broll = path.join(projectRoot, "03-broll");
  const dirs = await fs.readdir(broll, { withFileTypes: true }).catch(() => []);
  for (const d of dirs.filter((x) => x.isDirectory() && DIR_RE.test(x.name))) {
    const files = await fs.readdir(path.join(broll, d.name), { withFileTypes: true }).catch(() => []);
    for (const f of files.filter((x) => x.isFile() && /\.html$/i.test(x.name))) {
      const r = await validateStoryboard(projectRoot, `03-broll/${d.name}/${f.name}`, "scan").catch(() => null);
      if (r?.ok) out.push(r.value);
    }
  }
  return out;
}

export interface OpenDeps { spawnImpl?: typeof spawn; platform?: NodeJS.Platform }

/**
 * 「打开审阅页」（E10）：只由浏览器会话路由调用；只认本条 storyboard 事实里的路径（浏览器传的是 fact_id，
 * 传不进路径），位置安全再核一遍，用系统默认浏览器打开。
 */
export async function openStoryboard(contentId: string, factId: string, dataDir: string, deps: OpenDeps = {}): Promise<Record<string, unknown>> {
  const content = await getContent(contentId, dataDir);
  if (!content || content.deletedAt) return { ok: false, code: "not_found", error: "这条稿不在了" };
  const fact = (await readProductionDocOrEmpty(contentId, dataDir)).facts.find((f) => f.id === factId && f.kind === "storyboard" && f.state === "accepted");
  if (!fact) return { ok: false, code: "not_allowed", error: "这份分镜不属于这条稿，刷新再看" };
  const file = await storyboardFile(contentRoot(contentId, dataDir), fact);
  if (!file) return { ok: false, code: "file_missing", error: "审阅页找不到了，或路径里多了符号链接" };
  if ((deps.platform ?? process.platform) !== "darwin") return { ok: true, path: file, opened: false };
  // 等 open 真正跑完再回话（Codex 审 storyboard P2）：启动失败 / 非零退出都要让创始人看见，不回成功
  const failed = (why: string) => ({ ok: false, code: "open_failed", error: `浏览器没打开：${why}`, path: file });
  try {
    const child = (deps.spawnImpl ?? spawn)("open", [file], { stdio: "ignore" });
    return await new Promise<Record<string, unknown>>((resolve) => {
      child.once("error", (e: Error) => resolve(failed(e.message)));
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
        resolve(code === 0 ? { ok: true, path: file, opened: true } : failed(signal ? `被信号 ${signal} 中断` : `open 退出码 ${String(code)}`)));
    });
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}

/** 分镜事实：版本新的在前（同版本按报上时间）；不分轮次，旧版留历史 */
export function storyboards(doc: ProductionDoc): Fact[] {
  return doc.facts.filter((f) => f.kind === "storyboard" && f.state === "accepted")
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.at.localeCompare(a.at));
}

export const versionLabel = (v: number | undefined) => `v${String(v ?? 0).padStart(3, "0")}`;

/** 卡片面板的「分镜」一段：最新一版（现场核一次是否在报上之后被改过 / 不见了）+ 旧版 */
export async function storyboardPanel(contentId: string, dataDir: string, doc: ProductionDoc): Promise<Record<string, unknown> | null> {
  const all = storyboards(doc);
  if (!all.length) return null;
  const view = (f: Fact) => ({ fact_id: f.id, sha256: f.sha256, version: versionLabel(f.version), path: f.path, at: f.at });
  const latest = all[0];
  const file = await storyboardFile(contentRoot(contentId, dataDir), latest);
  const now = file ? (await cachedSha(file).catch(() => null))?.sha256 ?? null : null;
  const changed = Boolean(latest.replaced_at) || (now !== null && now !== latest.sha256);
  return { latest: { ...view(latest), changed, missing: !file, ...(changed ? { note: "审阅页在报上之后被改过" } : !file ? { note: "审阅页找不到了" } : {}) }, older: all.slice(1).map(view) };
}
