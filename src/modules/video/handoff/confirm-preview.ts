/**
 * 认稿确认窗给足信息（2026-09-29 spec）：原片时长与修改时间、认稿依据、定稿首句、补交接时已有的成片/封面；
 * 「查看 / 修改…」里的预览动作（open 原片 / 定稿 / 工作台）。预览一律不写记录；打不开就把原因带回确认窗。
 * 交接成功后的通知窗也在这里：不阻塞，弹不出来只进 warning。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentFile, resolveContentProject } from "../../../storage/content-project.js";
import type { Content } from "../../../storage/local-store.js";
import type { ReceiptCandidate } from "./match.js";
import { pullDeps } from "./pull-deps.js";

export const MENU_BUTTON = "查看 / 修改…";
export const MENU = { aroll: "预览原片", script: "看定稿", bench: "在工作台打开", edit: "改封面字和时长" } as const;
export type MenuAction = keyof typeof MENU;

const VIDEO_EXT = new Set([".mp4", ".mov"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function benchUrl(contentId: string): string {
  return `http://127.0.0.1:${pullDeps().benchPort}/#/editor/${encodeURIComponent(contentId)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "时长读不出";
  const total = Math.round(ms / 1000);
  return total >= 60 ? `${Math.floor(total / 60)} 分 ${total % 60} 秒` : `${total} 秒`;
}

function localTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 正文首个句子，截 40 字 */
export function firstSentence(body: string): string {
  const first = body.trim().split(/(?<=[。！？!?])|\n/)[0]?.trim() ?? "";
  const chars = Array.from(first);
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : first;
}

function evidenceLine(c: ReceiptCandidate): string {
  const score = c.layer === "l2" ? `（相似度 ${c.score.toFixed(2)}）` : "";
  return `认稿依据：${c.evidence || "没有记录"}${score}`;
}

function projectRootOf(content: Content, dataDir: string): string | null {
  try {
    return resolveContentProject(content.id, dataDir)?.project_root ?? content.video?.handoff?.project_root ?? null;
  } catch {
    return content.video?.handoff?.project_root ?? null;
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return names.map(String);
}

/** 补交接：项目里已有的成片候选（04-edit 下最新的 mp4/mov）与封面图（05-cover 子目录里的图）；没有就不出这行 */
export async function artifactsLine(content: Content, dataDir: string): Promise<string | null> {
  const root = projectRootOf(content, dataDir);
  if (!root) return null;
  const parts: string[] = [];
  const editDir = path.join(root, "04-edit");
  const videos = (await filesUnder(editDir)).filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()));
  const stamped = await Promise.all(videos.map(async (f) => ({ f, t: (await fs.stat(path.join(editDir, f)).catch(() => null))?.mtimeMs ?? -1 })));
  const latest = stamped.filter((s) => s.t >= 0).sort((a, b) => b.t - a.t)[0];
  if (latest) {
    const ms = await pullDeps().duration(path.join(editDir, latest.f)).catch(() => null);
    parts.push(`已找到成片：${path.basename(latest.f)}（${formatDuration(ms)}）`);
  }
  const covers = (await filesUnder(path.join(root, "05-cover")))
    .filter((f) => f.includes(path.sep) && IMAGE_EXT.has(path.extname(f).toLowerCase())).length;
  if (covers) parts.push(`已找到封面：${covers} 张（去工作台批）`);
  return parts.length ? parts.join(" ／ ") : null;
}

/** 确认窗里固定不变的几行：弹窗前算一次 */
export async function previewFacts(arollPath: string, cand: ReceiptCandidate, content: Content, dataDir: string): Promise<{ aroll: string[]; draft: string[]; tail: string[] }> {
  const ms = await pullDeps().duration(arollPath).catch(() => null);
  const st = await fs.stat(arollPath).catch(() => null);
  const aroll = [`原片时长：${formatDuration(ms)}${st ? `，修改于 ${localTime(st.mtimeMs)}` : ""}`];
  const draft = [`定稿首句：${firstSentence(content.body)}`, evidenceLine(cand)];
  const line = await artifactsLine(content, dataDir);
  return { aroll, draft, tail: line ? [line] : [] };
}

async function openFile(file: string, missing: string): Promise<string | null> {
  if (!(await fs.access(file).then(() => true, () => false))) return `${missing}：${file}`;
  const r = await pullDeps().opener(file);
  return r.ok ? null : r.reason;
}

/** 执行一个预览动作；打不开回原因（给下一次确认窗顶部），打开了回 null。不写任何记录 */
export async function runPreview(action: Exclude<MenuAction, "edit">, arollPath: string, contentId: string, dataDir: string): Promise<string | null> {
  if (action === "aroll") return openFile(arollPath, "原片找不到了（可能挪走或删了）");
  if (action === "script") return openFile(contentFile(contentId, dataDir, "draft.md"), "定稿文件不在");
  const deps = pullDeps();
  if (!(await deps.benchReachable(`http://127.0.0.1:${deps.benchPort}/`))) return "工作台没在运行，打不开";
  const r = await deps.opener(benchUrl(contentId));
  return r.ok ? null : r.reason;
}

/** 交接真正提交后调一次：不阻塞的通知窗；弹不出来只回 warning，不影响交接 */
export function announceHandoff(contentId: string, title: string): Record<string, unknown> {
  const r = pullDeps().notifier({ title: "AutoCrew", message: `已交给剪辑：${title}。成片和封面到了会出现在工作台。`, url: benchUrl(contentId) });
  return r.ok ? {} : { warnings: [`交接成功通知没弹出来：${r.reason}`] };
}
