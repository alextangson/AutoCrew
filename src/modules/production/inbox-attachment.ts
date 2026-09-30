/**
 * 请示附件怎么打开（review-inbox §5.4，Codex 21，R19）：
 * - HTML（分镜审阅页）**不从 AutoCrew 自己的网址提供**——页面脚本会借创始人的登录调决定接口；走「在系统浏览器里打开本地文件」。
 * - 视频 / 图片：只读流式提供，`Content-Security-Policy: sandbox` + `X-Content-Type-Options: nosniff`，只认创建请示时绑定的 sha。
 */
import fs from "node:fs";
import path from "node:path";
import { contentRoot } from "../../storage/content-project.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { isWithin } from "../../storage/storage-roots.js";
import { sha256File } from "../video/handoff/manifest.js";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

export const ATTACHMENT_HEADERS = { "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } as const;

export type AttachmentOpen = { ok: true; file: string; size: number; type: string } | { ok: false; status: number; error: string };

export async function openAttachment(contentId: string, askId: string, index: number, dataDir: string): Promise<AttachmentOpen> {
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const a = (doc.asks ?? []).find((x) => x.id === askId)?.attachments[index];
  if (!a) return { ok: false, status: 404, error: "没有这个附件" };
  const ext = path.extname(a.path).toLowerCase();
  if (ext === ".html" || ext === ".htm") return { ok: false, status: 403, error: "HTML 附件不从这里打开：用「在浏览器里打开」（本机文件）" };
  const type = TYPES[ext];
  if (!type) return { ok: false, status: 415, error: "这种附件不能在网页里预览，到项目文件夹里看" };
  const root = await fs.promises.realpath(contentRoot(contentId, dataDir));
  const file = path.join(root, a.path);
  const real = await fs.promises.realpath(file).catch(() => null);
  if (!real || !isWithin(root, real)) return { ok: false, status: 404, error: "附件不在项目里了" };
  const st = await fs.promises.lstat(file);
  if (!st.isFile()) return { ok: false, status: 404, error: "附件不是普通文件" };
  if ((await sha256File(real)) !== a.sha256) return { ok: false, status: 409, error: "附件刚变过：和 agent 问你时的那份不一样了" };
  return { ok: true, file: real, size: st.size, type };
}

export function attachmentStream(file: string): fs.ReadStream {
  return fs.createReadStream(file);
}

/**
 * 条目预览（成片、封面、候选）：按 fact_id 取文件，页面拿不到路径（条目里不放路径）。只读、sandbox + nosniff、
 * 只认事实记下的 sha；被否掉的不给。项目内的要真在项目里，库外候选按记下的绝对路径。
 */
export async function openFactMedia(contentId: string, factId: string, dataDir: string): Promise<AttachmentOpen> {
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const f = doc.facts.find((x) => x.id === factId);
  if (!f || f.state === "rejected" || !f.path || !f.sha256 || !["cut", "cover", "aroll"].includes(f.kind)) return { ok: false, status: 404, error: "没有这个文件" };
  const type = TYPES[path.extname(f.path).toLowerCase()];
  if (!type) return { ok: false, status: 415, error: "这种文件不能在网页里预览" };
  const root = await fs.promises.realpath(contentRoot(contentId, dataDir));
  const file = path.isAbsolute(f.path) ? f.path : path.join(root, f.path);
  const real = await fs.promises.realpath(file).catch(() => null);
  if (!real || (!path.isAbsolute(f.path) && !isWithin(root, real))) return { ok: false, status: 404, error: "文件不在了" };
  const st = await fs.promises.stat(real);
  if (!st.isFile()) return { ok: false, status: 404, error: "不是普通文件" };
  if ((await sha256File(real)) !== f.sha256) return { ok: false, status: 409, error: "文件变过了" };
  return { ok: true, file: real, size: st.size, type };
}
