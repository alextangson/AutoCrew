/**
 * 英文发布包的审阅页：缩略图、每个平台的标题 / 描述 / 帖子正文、YouTube 章节、成片文件名与时长、还差什么、批准状态。
 * 创始人从「等你拍板」的「英文发布包」那件打开；只读。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import type { EnPackageState } from "./package.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const dur = (ms: number | null) => (ms === null ? "时长未知" : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);

function kitHtml(platform: string, k: EnPackageState["kits"][string]): string {
  const chapters = k.chapters?.length ? `<h4>章节</h4><ol>${k.chapters.map((c) => `<li>${esc(c.at)} ${esc(c.title)}</li>`).join("")}</ol>` : "";
  const tags = k.tags?.length ? `<p class="tags">tags：${esc(k.tags.join(", "))}</p>` : "";
  const title = platform === "x" ? "" : `<h3>${esc(k.postTitle)}</h3>`;
  return `<section class="kit"><h2>${esc(platform === "x" ? "X 帖子" : "YouTube")}</h2>${title}<pre>${esc(k.caption)}</pre>${tags}${chapters}</section>`;
}

const CSS = `body{font-family:-apple-system,"PingFang SC",sans-serif;margin:0;background:#f4f4f4;color:#222}main{max-width:900px;margin:0 auto;background:#fff;padding:24px}
img.thumb{width:640px;max-width:100%;display:block;border:1px solid #ddd}pre{white-space:pre-wrap;font:15px/1.6 -apple-system,sans-serif;background:#fafafa;padding:12px}
.bad{color:#c0392b}.meta{background:#f7f7f7;padding:12px 16px;margin-bottom:16px}.kit{border-top:1px solid #eee;margin-top:16px}.tags{color:#666;font-size:13px}`;

export function renderEnPackagePreview(s: EnPackageState, approvalText: string): string {
  const problems = s.problems.length ? `<ul class="bad">${s.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "<p>都齐了，可以批。</p>";
  const thumb = s.thumbnail ? `<img class="thumb" src="${esc(pathToFileURL(s.thumbnail.path).href)}"><p>${s.thumbnail.width}×${s.thumbnail.height}</p>` : `<p class="bad">还没有 16:9 缩略图</p>`;
  const cut = s.cut ? `<p>成片：${esc(path.basename(s.cut.path))}（${dur(s.cut.durationMs)}）· 字幕：${esc(path.basename(s.cut.srtPath))}</p>` : `<p class="bad">还没有审过的英文成片</p>`;
  const kits = s.platforms.map((p) => (s.kits[p] ? kitHtml(p, s.kits[p]) : `<section class="kit"><h2>${esc(p)}</h2><p class="bad">还没有发布包</p></section>`)).join("\n");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>英文发布包｜${esc(s.content.title)}</title><style>${CSS}</style></head><body><main>
<h1>英文发布包：${esc(s.content.title)}</h1>
<section class="meta"><p>批准状态：${esc(approvalText)}</p><h3>还差什么</h3>${problems}</section>
<h2>缩略图（YouTube / X）</h2>${thumb}${cut}
${kits}
</main></body></html>`;
}

export async function writeEnPackagePreview(s: EnPackageState, approvalText: string, dataDir: string): Promise<string> {
  const target = projectFile(contentRoot(s.content.id, dataDir), "en-package-review.html");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, renderEnPackagePreview(s, approvalText), "utf-8");
  return target;
}

export function enPackageApprovalText(s: EnPackageState): string {
  if (s.approval.ok) return `已批准（${s.file.approval!.approvedAt}）`;
  return s.file.approval ? `批准已失效：${s.approval.reason}` : "还没批";
}
