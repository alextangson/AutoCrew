/**
 * 推送暂存（Codex 审 2b P1-1）：每次推送都在文章项目里新建一个只装这一包文件的目录——正文 markdown、
 * 按顺序的配图副本、封面主图副本。推送脚本在这个目录里排版、找 images/，不会捡到上一版留下的 img-01.png。
 * 复制完用副本重算整包指纹，必须等于批准指纹，才交给脚本。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contentFile, resolveContentProject } from "../../storage/content-project.js";
import { projectMarkdownExport } from "../../storage/project-record.js";
import type { ArticleImageEntry } from "../publish/article-images.js";
import { packageHash } from "./package.js";
import type { ArticleReviewState } from "./review.js";

export interface Staged { dir: string; articlePath: string; coverPath: string; images: string[] }

/** 推送用的 markdown：标题 + 正文；web 图位后面跟一行斜体署名，排版脚本把它变成图下说明 */
export function articleMarkdown(title: string, body: string, entries: ArticleImageEntry[]): string {
  let k = 0;
  const withCredits = body.replace(/\[IMAGE:\s*(.+?)\]/g, (marker) => {
    const n = k++;
    const e = entries.find((x) => x.index === n);
    const web = e && (e.kind === "web" || e.origin === "web") && e.credit;
    return web ? `${marker}\n\n*${e.credit!.replace(/\*/g, "")}*` : marker;
  });
  return `# ${title}\n\n${withCredits}\n`;
}

/** 新建暂存目录并拷入这一包；副本的整包指纹对不上批准指纹就抛错（不推） */
export async function stagePackage(contentId: string, s: ArticleReviewState, dataDir: string, now: Date): Promise<Staged> {
  const dir = path.join(path.dirname(contentFile(contentId, dataDir, "x")), "wechat-push", `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  const entries: ArticleImageEntry[] = [];
  const images: string[] = [];
  for (const e of s.images.entries) {
    if (!e.imagePath) { entries.push(e); continue; }
    const copy = path.join(dir, "src", `img-${String(e.index + 1).padStart(2, "0")}${path.extname(e.imagePath).toLowerCase() || ".png"}`);
    await fs.copyFile(e.imagePath, copy);
    images[e.index] = copy;
    entries.push({ ...e, imagePath: copy });
  }
  const cover = s.pkg.cover!;
  const coverPath = path.join(dir, "src", `cover${path.extname(cover.path).toLowerCase() || ".png"}`);
  await fs.copyFile(cover.path, coverPath);
  const hash = await packageHash(s.content, { ...s.pkg, cover: { ...cover, path: coverPath } }, { entries });
  if (hash !== s.hash) throw new Error("暂存的副本和批过的包对不上（拷贝时文件被改了）：重新核对审阅页再推");
  const md = articleMarkdown(s.pkg.chosenTitle!, s.content.body ?? "", entries);
  const project = resolveContentProject(contentId, dataDir);
  const articlePath = path.join(dir, "article.md");
  await fs.writeFile(articlePath, project ? projectMarkdownExport(md, project.project_root) : md, "utf-8");
  return { dir, articlePath, coverPath, images };
}

/** 草稿身份核对用：正文第一段和最后一段文字（去掉小标题、配图标记），各取前 40 字 */
export function edgeParagraphs(body: string): { first: string; last: string } {
  const paras = body.replace(/\r/g, "").split(/\n{2,}|\n(?=#)/).map((p) => p.replace(/\[IMAGE:[^\]]*\]/g, "").replace(/^#{1,4}\s+.*$/gm, "").replace(/\*\*/g, "").trim()).filter(Boolean);
  const cut = (p?: string) => (p ?? "").replace(/\s+/g, " ").slice(0, 40);
  return { first: cut(paras[0]), last: cut(paras.at(-1)) };
}
