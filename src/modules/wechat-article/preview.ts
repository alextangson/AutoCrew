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

/** 一段文字：首行是 ## 小标题就出 h2，其余照段落排（单换行 = <br>） */
function textHtml(t: string): string {
  const [first, ...rest] = t.split("\n");
  const heading = /^#{1,4}\s+(.+)$/.exec(first);
  const para = (x: string) => `<p>${esc(x).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")}</p>`;
  if (!heading) return para(t);
  const tail = rest.join("\n").trim();
  return `<h2>${esc(heading[1])}</h2>${tail ? `\n${para(tail)}` : ""}`;
}

/** 正文按段落排版；配图标记按出现顺序换成对应图位（和 parseArticleImageMarkers 同一顺序） */
function bodyHtml(body: string, entries: ArticleImageEntry[]): string {
  let n = 0;
  const html: string[] = [];
  for (const block of body.replace(/\r/g, "").split(/\n+(?=#)|\n{2,}/)) {
    for (const part of block.split(/(\[IMAGE:[^\]]*\])/)) {
      const t = part.trim();
      if (!t) continue;
      if (!/^\[IMAGE:/.test(t)) { html.push(textHtml(t)); continue; }
      const k = n++;
      const e = entries.find((x) => x.index === k);
      html.push(e?.imagePath && e.status === "ready" ? `<figure><img src="${img(e.imagePath)}">${imageCaption(e)}</figure>` : e ? imageCaption(e) : "");
    }
  }
  return html.join("\n");
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
  return `<div class="covers">${cropHtml(c, "2.35:1", 300)}${cropHtml(c, "1:1", 128)}</div><p class="cap">主图 ${c.width}×${c.height}</p>`;
}

function headerHtml(i: PreviewInput): string {
  const titles = i.pkg.titleOptions.map((t, k) => `<li${t === i.pkg.chosenTitle ? ' class="chosen"' : ""}>${k + 1}. ${esc(t)}${t === i.pkg.chosenTitle ? "（已选）" : ""}</li>`).join("");
  const source = i.pkg.creationSource ? `${esc(i.pkg.creationSource.value)}（创始人确认：「${esc(i.pkg.creationSource.founderWords)}」）` : `未确认${i.suggestedSource ? `（建议：${esc(i.suggestedSource)}）` : ""}`;
  const problems = i.problems.length ? `<ul class="bad">${i.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : `<p>都齐了，可以批。</p>`;
  return [
    `<section class="meta"><h3>标题候选</h3><ol>${titles || "<li>还没有</li>"}</ol>`,
    `<h3>封面（一张主图，裁出 2.35:1 + 1:1）</h3>${coversHtml(i.pkg)}`,
    `<p>创作来源：${source}</p><p>正文 ${i.chars} 字${i.pkg.lengthOverride ? `（篇幅已放行：「${esc(i.pkg.lengthOverride.founderWords)}」）` : ""}</p>`,
    i.sourceNote ? `<p>底稿：${esc(i.sourceNote)}</p>` : "",
    `<p>批准状态：${esc(i.approval)}</p><h3>还差什么</h3>${problems}</section>`,
    diffHtml(i.rebindDiff ?? null),
  ].join("\n");
}

const CSS = `body{background:#ededed;margin:0;font-family:-apple-system,"PingFang SC",sans-serif}main{max-width:600px;margin:0 auto;background:#fff;padding:24px 20px;color:#333;line-height:1.85;font-size:16px}
h1{font-size:22px;line-height:1.4}h2{font-size:18px;margin-top:2em}figure{margin:1.2em 0}img{max-width:100%;display:block}.cap{font-size:12px;color:#888;text-align:center;margin:.4em 0}
.bad{color:#c0392b}.meta{background:#f7f7f7;padding:12px 16px;font-size:14px;margin-bottom:24px}.chosen{font-weight:600}.covers{display:flex;gap:12px;align-items:flex-end}.crop{border:1px solid #ddd}`;

export function renderArticlePreview(i: PreviewInput): string {
  const title = i.pkg.chosenTitle ?? i.pkg.titleOptions[0] ?? i.title;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${headerHtml(i)}<h1>${esc(title)}</h1>${bodyHtml(i.body, i.entries)}</main></body></html>`;
}

export async function writeArticlePreview(i: PreviewInput, dataDir?: string): Promise<string> {
  const target = projectFile(contentRoot(i.contentId, dataDir), "wechat-preview.html");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, renderArticlePreview(i), "utf-8");
  return target;
}
