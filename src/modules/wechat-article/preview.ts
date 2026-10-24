/**
 * 图文审阅页（全媒体 spec §3.2 第 5 条）：近似公众号版式的本地 HTML——标题候选、正文配图就位、
 * 图下来源 / 生成说明、封面主图与两个裁切、创作来源、篇幅与没过的项。创始人从「等你拍板」的认稿那件打开它。
 * 只读：不改包。图片用 file:// 绝对路径，本机浏览器直接打开。
 */
import { diffHtml, type RebindDiff } from "../lineage/rebind-diff.js";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import type { ArticleImageEntry } from "../publish/article-images.js";
import { LEGACY_COVER_PAIR, type ArticlePackage } from "./package.js";
import { cropParam, type ArticleCoverRatio, type ArticleMasterCover } from "./cover.js";
import type { FormattedBody } from "./preview-format.js";

export interface PreviewInput {
  contentId: string;
  title: string;
  body: string;
  pkg: ArticlePackage;
  entries: ArticleImageEntry[];
  chars: number;
  problems: string[];
  /** 源成片换版 rebind 过：旧 / 新成片字幕的逐句对比（审阅页顶上给他看） */
  rebindDiff?: RebindDiff | null;
  suggestedSource: string | null;
  approval: string;
  sourceNote?: string;
  /** 推送用的排版脚本 + 主题排出来的正文（所见即所推）；失败就带原因 */
  formatted: FormattedBody;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const img = (p: string) => esc(pathToFileURL(p).href);

/** 图下说明：web = 署名 + 来源链接；gen = 谁出的、请求的模型、模型核实情况；失败 = 原始原因 */
export function imageCaption(e: ArticleImageEntry): string {
  if (e.status === "error") return `<p class="cap bad">配图 ${e.index + 1} 生成失败：${esc(e.error ?? "没有原因")}</p>`;
  if (e.status !== "ready" || !e.imagePath) return `<p class="cap bad">配图 ${e.index + 1} 还没有图（${esc(e.prompt)}）</p>`;
  if (e.kind === "web" || e.origin === "web") {
    return e.sourceUrl
      ? `<p class="cap">${esc(e.credit ?? "")} · <a href="${esc(e.sourceUrl)}">${esc(e.sourceUrl)}</a></p>`
      : `<p class="cap bad">web 图没有来源链接，不能过审</p>`;
  }
  if (e.origin === "uploaded" || e.origin === "research") return `<p class="cap">创作者自己的图（${e.origin === "research" ? "调研素材" : "上传"}）</p>`;
  const model = e.modelStatus === "configured" ? "按设置里配的模型请求，未核实" : "model unverified（通道报不出实际模型）";
  return `<p class="cap">AI 生成 · 通道 ${esc(e.provider ?? "?")} · 请求 ${esc(e.requestedModel ?? "未指定")} · ${model}</p>`;
}

/** 配图逐张：缩略图 + 来源 / 生成说明（正文里的排版样子见下面的正文区） */
function imagesHtml(entries: ArticleImageEntry[]): string {
  if (!entries.length) return "<p class='muted'>正文没有配图</p>";
  return `<div class="imgs">${entries.map((e) => `<figure>${e.status === "ready" && e.imagePath ? `<img src="${img(e.imagePath)}">` : ""}<figcaption><b>配图 ${e.index + 1}</b>${imageCaption(e)}</figcaption></figure>`).join("")}</div>`;
}

/** 正文区：排版脚本的产出原样嵌入；排版失败就明写，不给未排版的正文 */
function bodySection(f: FormattedBody): string {
  if (!f.ok) return `<section class="fmt-fail"><h2>正文排版没出来（主题 ${esc(f.theme)}）</h2><p>${esc(f.error)}</p><p>推送时用的是同一个排版脚本和主题，这里排不出来，推送也会出问题：先修好再看。</p></section>`;
  return `<p class="fmt-note">下面是推送时的排版（主题 ${esc(f.theme)}）</p><article class="wx">${f.html}</article>`;
}

/** 按归一化裁切框，把主图的那一块画成目标比例的框：背景图放大到「框宽 / 裁切宽」，再平移到裁切左上 */
export function cropHtml(c: ArticleMasterCover, ratio: ArticleCoverRatio, boxWidth: number): string {
  const k = c.crops[ratio];
  const bgW = boxWidth / (k.x2 - k.x1);
  const bgH = (bgW * c.height) / c.width;
  const boxH = Math.round((k.y2 - k.y1) * bgH);
  const style = `width:${boxWidth}px;height:${boxH}px;background:url('${img(c.path)}') no-repeat;background-size:${bgW.toFixed(1)}px ${bgH.toFixed(1)}px;background-position:-${(k.x1 * bgW).toFixed(1)}px -${(k.y1 * bgH).toFixed(1)}px`;
  return `<figure class="cover"><div class="crop" style="${style}"></div><p class="cap">${ratio}（${cropParam(k)}）</p></figure>`;
}

function coversHtml(pkg: ArticlePackage): string {
  if (pkg.covers?.length) return `<p class="bad">${esc(LEGACY_COVER_PAIR)}</p>`;
  const c = pkg.cover;
  if (!c) return "<p class='bad'>还没有封面主图</p>";
  return `<div class="covers">${cropHtml(c, "2.35:1", 300)}${cropHtml(c, "1:1", 128)}</div><p class="muted">主图 ${c.width}×${c.height}</p>`;
}

function headerHtml(i: PreviewInput): string {
  const titles = i.pkg.titleOptions.map((t) => `<li${t === i.pkg.chosenTitle ? ' class="chosen"' : ""}>${esc(t)}${t === i.pkg.chosenTitle ? "（已选）" : ""}</li>`).join("");
  const source = i.pkg.creationSource ? `${esc(i.pkg.creationSource.value)}（创始人确认：「${esc(i.pkg.creationSource.founderWords)}」）` : `未确认${i.suggestedSource ? `（建议：${esc(i.suggestedSource)}）` : ""}`;
  const problems = i.problems.length ? `<ul class="bad">${i.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : `<p class="ok">都齐了，可以批。</p>`;
  const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  return [
    `<section class="meta"><h3>标题候选</h3><ol class="titles">${titles || "<li>还没有</li>"}</ol>`,
    `<h3>封面（一张主图，裁出 2.35:1 + 1:1）</h3>${coversHtml(i.pkg)}`,
    `<h3>配图</h3>${imagesHtml(i.entries)}`,
    `<h3>包信息</h3>`,
    row("创作来源", source),
    row("篇幅", `正文 ${i.chars} 字${i.pkg.lengthOverride ? `（篇幅已放行：「${esc(i.pkg.lengthOverride.founderWords)}」）` : ""}`),
    i.sourceNote ? row("底稿", esc(i.sourceNote)) : "",
    row("排版主题", esc(i.formatted.theme)),
    row("批准状态", esc(i.approval)),
    `<h3>还差什么</h3>${problems}</section>`,
    diffHtml(i.rebindDiff ?? null),
  ].join("\n");
}

const CSS = `body{background:#f2f2f2;margin:0;font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;color:#222}
main{max-width:640px;margin:0 auto;padding:24px 16px 64px;box-sizing:border-box}
.meta{background:#fff;border:1px solid #e6e6e6;border-radius:10px;padding:16px 18px;font-size:14px;line-height:1.6;margin-bottom:20px}
.meta h3{font-size:13px;font-weight:600;color:#888;letter-spacing:.04em;margin:18px 0 8px}.meta h3:first-child{margin-top:0}
.titles{margin:0;padding-left:1.4em}.titles li{margin:2px 0}.chosen{font-weight:600}
.covers{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}.cover{margin:0;min-width:0;max-width:100%}.crop{border:1px solid #ddd;border-radius:4px;max-width:100%}
.cap{font-size:12px;color:#888;margin:.4em 0;overflow-wrap:anywhere;word-break:break-all}.muted{color:#999;font-size:12px;margin:.4em 0}
.imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.imgs figure{margin:0;min-width:0}.imgs img{width:100%;border-radius:4px;display:block}.imgs figcaption{font-size:12px}
.row{display:flex;gap:12px;padding:6px 0;border-top:1px solid #f0f0f0}.row:first-of-type{border-top:0}.k{flex:0 0 5em;color:#888}.v{flex:1;min-width:0;overflow-wrap:anywhere}
.bad{color:#c0392b}.ok{color:#2e7d32}.fmt-note{font-size:12px;color:#999;text-align:center;margin:0 0 8px}
.wx{background:#fff;max-width:600px;margin:0 auto;padding:20px 16px;box-sizing:border-box;overflow:hidden}.wx img{max-width:100%}
.fmt-fail{background:#fff3f2;border:1px solid #f1c0bb;color:#c0392b;border-radius:10px;padding:16px 18px}.fmt-fail h2{font-size:16px;margin:0 0 8px}`;

export function renderArticlePreview(i: PreviewInput): string {
  const title = i.pkg.chosenTitle ?? i.pkg.titleOptions[0] ?? i.title;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${headerHtml(i)}${bodySection(i.formatted)}</main></body></html>`;
}

export async function writeArticlePreview(i: PreviewInput, dataDir?: string): Promise<string> {
  const target = projectFile(contentRoot(i.contentId, dataDir), "wechat-preview.html");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, renderArticlePreview(i), "utf-8");
  return target;
}
