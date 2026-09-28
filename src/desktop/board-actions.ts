/**
 * 看板上的两类写操作（看板规格 §B、§D.22）：
 * - 「开始写」：选题 → 建稿件（写稿中）+ 打开 Claude 桌面版新会话并预填指令（只预填，不发送）。
 *   同一选题已有稿件就直接回那篇，不建第二篇（§11）；同一进程里的并发点击合并成一次。
 * - 「我发了」：按平台记一条手动发布，可撤销；任一平台已发出去就同步为已发布。
 * spawn 可注入，测试不真开窗。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getContent, getTopic, listContents, saveContent, transitionStatus, updateContent,
  type Content, type ManualPublication,
} from "../storage/local-store.js";
import { isContentId, isTopicId } from "../storage/entity-id.js";
import { isVideoPlatform } from "../storage/stage-guard.js";
import { anySubmitted, readPublishRecord } from "../storage/publish-record.js";

export const PROGRAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface OpenDeps { spawnImpl?: typeof spawn; platform?: NodeJS.Platform; programDir?: string }

export type StartResult =
  | { ok: true; created: boolean; content_id: string; prompt?: string; link?: string; opened?: boolean; open_error?: string }
  | { ok: false; code: "bad_request" | "topic_gone"; error: string };

/** 预填给 Claude 的指令：video-session 技能的触发说法 + 标题 + id，保持简短（App 对 q 有长度上限） */
export function startPrompt(title: string, topicId: string, contentId: string, platform: string): string {
  const short = Array.from(title).slice(0, 60).join("");
  return `这条视频开工：「${short}」（topic_id ${topicId}，稿件 ${contentId}，平台 ${platform}）`;
}

export function claudeLink(prompt: string, folder: string): string {
  return `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(folder)}`;
}

/** darwin 用 `open`；其他平台或打不开都回原因，由前端退回剪贴板 */
export async function openLink(link: string, deps: OpenDeps = {}): Promise<{ opened: boolean; error?: string }> {
  if ((deps.platform ?? process.platform) !== "darwin") return { opened: false, error: "这台机器不是 macOS，打不开 Claude 桌面版" };
  const code = await new Promise<number | string>((resolve) => {
    try {
      const child = (deps.spawnImpl ?? spawn)("open", [link], { stdio: "ignore" });
      child.on("error", (e) => resolve(e.message));
      child.on("exit", (c) => resolve(c ?? "被中断"));
    } catch (e) { resolve(e instanceof Error ? e.message : String(e)); }
  });
  if (code === 0) return { opened: true };
  return { opened: false, error: typeof code === "number" ? `open 退出码 ${code}，可能没装 Claude 桌面版` : code };
}

function existingDraft(contents: Content[], topicId: string): Content | undefined {
  return contents.find((c) => c.topicId === topicId && c.status !== "archived");
}

async function startOnce(topicId: string, platform: string, dataDir: string, deps: OpenDeps): Promise<StartResult> {
  const existing = existingDraft(await listContents(dataDir), topicId);
  if (existing) return { ok: true, created: false, content_id: existing.id };
  const topic = await getTopic(topicId, dataDir);
  if (!topic || topic.deletedAt) return { ok: false, code: "topic_gone", error: "这条选题已经不在了（可能被删或过期清理）" };
  const content = await saveContent({ title: topic.title, body: "", platform, topicId, status: "drafting", tags: [] }, dataDir);
  const prompt = startPrompt(topic.title, topicId, content.id, platform);
  const link = claudeLink(prompt, deps.programDir ?? PROGRAM_DIR);
  const opened = await openLink(link, deps);
  return { ok: true, created: true, content_id: content.id, prompt, link, opened: opened.opened, ...(opened.error ? { open_error: opened.error } : {}) };
}

const inflight = new Map<string, Promise<StartResult>>();

export function startWriting(topicId: string, platform: string | undefined, dataDir: string, deps: OpenDeps = {}): Promise<StartResult> {
  if (!isTopicId(topicId)) return Promise.resolve({ ok: false, code: "bad_request", error: "参数不对" });
  const target = platform && isVideoPlatform(platform) ? platform : "douyin";
  const running = inflight.get(topicId);
  if (running) return running.then((r) => (r.ok && r.created ? { ok: true, created: false, content_id: r.content_id } : r));
  const job = startOnce(topicId, target, dataDir, deps).finally(() => inflight.delete(topicId));
  inflight.set(topicId, job);
  return job;
}

export type MarkResult = { ok: true; content: Content } | { ok: false; code: "bad_request" | "not_found" | "wrong_stage" | "failed"; error: string };

const MARKABLE = new Set(["publish_ready", "publishing", "published"]);

export function validMarkUrl(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  try { const u = new URL(raw.trim()); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}

/** 「我发了」：记一条手动发布（同平台覆盖），待发布的稿同步为已发布 */
export async function markPublished(id: string, platform: string, url: unknown, dataDir: string): Promise<MarkResult> {
  if (!isContentId(id) || !/^[a-z_]{2,32}$/.test(platform)) return { ok: false, code: "bad_request", error: "参数不对" };
  const link = validMarkUrl(url);
  if (link === null) return { ok: false, code: "bad_request", error: "链接要是 http(s) 地址" };
  const content = await getContent(id, dataDir);
  if (!content) return { ok: false, code: "not_found", error: "找不到这条稿" };
  if (!MARKABLE.has(content.status)) return { ok: false, code: "wrong_stage", error: "这条还没到发布这一步" };
  const mark: ManualPublication = { platform, at: new Date().toISOString(), ...(link ? { url: link } : {}) };
  const patch = (cur: Content) => ({ manualPublications: [...(cur.manualPublications ?? []).filter((m) => m.platform !== platform), mark] });
  const r = content.status === "published"
    ? { ok: true, content: await updateContent(id, patch(content), dataDir) }
    : await transitionStatus(id, "published", { force: true, expectedStatus: content.status, patch }, dataDir);
  if (!r.ok || !r.content) return { ok: false, code: "failed", error: ("error" in r && r.error) || "没记上，刷新后再试" };
  return { ok: true, content: r.content };
}

/** 撤销「我发了」；撤完一个平台都没发出去，就退回待发布 */
export async function unmarkPublished(id: string, platform: string, dataDir: string): Promise<MarkResult> {
  if (!isContentId(id) || !/^[a-z_]{2,32}$/.test(platform)) return { ok: false, code: "bad_request", error: "参数不对" };
  const content = await getContent(id, dataDir);
  if (!content) return { ok: false, code: "not_found", error: "找不到这条稿" };
  const rest = (content.manualPublications ?? []).filter((m) => m.platform !== platform);
  const record = await readPublishRecord(id, rest, dataDir);
  const patch = { manualPublications: rest };
  const r = content.status === "published" && !anySubmitted(record)
    ? await transitionStatus(id, "publish_ready", { expectedStatus: "published", patch: { ...patch, publishedAt: null } }, dataDir)
    : { ok: true, content: await updateContent(id, patch, dataDir) };
  if (!r.ok || !r.content) return { ok: false, code: "failed", error: ("error" in r && r.error) || "没撤销成功，刷新后再试" };
  return { ok: true, content: r.content };
}
