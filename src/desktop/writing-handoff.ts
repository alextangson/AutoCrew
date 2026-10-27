/**
 * 把写稿 / 看稿交给本机的某个 AI（spec 2026-10-15 §B2–B5）。
 * - Claude：claude:// 深链带上指令，打开新会话（只预填，不发送）。
 * - Codex：打开 codex://threads/new（深链带不了文字），指令交给前端放进剪贴板，让人粘贴发送。
 * - WorkBuddy：不打开，指令进剪贴板，粘到 WorkBuddy 里发出去。
 * 打不开（不是 macOS / 没装）照实回原因，由前端退回剪贴板。指令对任何接了 AutoCrew MCP 的 agent 都看得懂。
 * 交出去写（write）的时刻记在稿上（writingHandoff），看板据此说「已交给 X，等它接手」。
 */
import { activeClaim } from "../storage/claims.js";
import { getEngineSettings } from "./settings-engine.js";
import { getContent, updateContent } from "../storage/local-store.js";
import { isContentId } from "../storage/entity-id.js";
import { claudeLink, openLink, PROGRAM_DIR, type OpenDeps } from "./board-actions.js";
import { defaultHostEnv } from "./host-connect/env.js";
import { pickWriter, type WriterPick } from "./host-connect/writing-host.js";
import type { ConnectHost } from "./host-connect/detect.js";
import { holderLabel } from "../modules/production/handoff-view.js";

export type HandOffMode = "write" | "look";
export interface HandOffDeps extends OpenDeps {
  writer?: (override?: string | null) => WriterPick;
  /** 测试注入：内置引擎（总编辑）配好了没有 */
  engineReady?: (dataDir: string) => Promise<boolean>;
}
/** chief = 右侧的总编辑（只配了模型钥匙、没接本机 AI 时交给它）：前端把指令填进对话框，不自动发送 */
export type WriteHost = ConnectHost | "chief";
export interface Delivery { host: WriteHost; label: string; prompt: string; opened: boolean; paste: boolean; open_error?: string }

export const CHIEF = { ok: true as const, host: "chief" as const, label: "总编辑" };
export type Target = WriterPick | typeof CHIEF;

export const pickFor = (deps: HandOffDeps, override?: string | null): WriterPick => (deps.writer ?? ((o) => pickWriter(defaultHostEnv(), o)))(override);

async function engineConfigured(dataDir: string): Promise<boolean> {
  const r = await getEngineSettings({ _dataDir: dataDir });
  return Boolean(r.ok && (r.data as { configured?: boolean } | undefined)?.configured);
}

/**
 * 交给谁（spec 2026-10-15 §B 边界）：本机 AI 一个都没接、但配了模型钥匙 → 交给总编辑；两样都没有才 no_writer。
 * 默认的断开了（default_gone）照旧明说，不悄悄换成总编辑。
 */
export async function resolveTarget(deps: HandOffDeps, override: string | null | undefined, dataDir: string): Promise<Target> {
  const ready = () => (deps.engineReady ?? engineConfigured)(dataDir);
  if (override === "chief") return (await ready()) ? CHIEF : { ok: false, code: "no_writer", error: "总编辑还没配模型钥匙：先接一个 AI，或在设置里填钥匙" };
  const pick = pickFor(deps, override);
  if (pick.ok || pick.code !== "no_writer") return pick;
  return (await ready()) ? CHIEF : pick;
}

/** 开工指令：「这条视频开工」仍能触发 Claude 的 video-session 技能；其余写明工具、稿件 id、平台，任何 agent 都照着做得下去 */
export function writePrompt(title: string, topicId: string | null, contentId: string, platform: string): string {
  const short = Array.from(title).slice(0, 60).join("");
  return `这条视频开工：「${short}」。用导演椅 MCP 的 autocrew_draft 接手：先调 start{content_id:"${contentId}"}，再照返回的 next_action 一步步写（平台 ${platform}${topicId ? `，选题 ${topicId}` : ""}）。`;
}

/** 只读看看（原「复制给 WorkBuddy」那句，创始人认过的措辞） */
export function lookPrompt(title: string, id: string): string {
  return `通过 autocrew MCP 调用 autocrew_content summary 查看《${title}》（id: ${id}），总结这篇现在在哪一步、卡在哪，然后等我指示，先不要改任何东西。`;
}

export async function deliver(host: WriteHost, label: string, prompt: string, deps: OpenDeps): Promise<Delivery> {
  if (host === "chief") return { host, label, prompt, opened: false, paste: false };
  if (host === "workbuddy") return { host, label, prompt, opened: false, paste: true };
  const link = host === "claude" ? claudeLink(prompt, deps.programDir ?? PROGRAM_DIR) : "codex://threads/new";
  const r = await openLink(link, deps, host === "claude" ? "Claude 桌面版" : "Codex 桌面版");
  return { host, label, prompt, opened: r.opened, paste: host === "codex" || !r.opened, ...(r.error ? { open_error: r.error } : {}) };
}

const WRITING = new Set(["topic_saved", "drafting", "draft_ready", "reviewing", "revision", "needs_evidence"]);

export type HandOffResult = ({ ok: true; content_id: string } & Delivery) | Exclude<WriterPick, { ok: true }> | { ok: false; code: string; error: string; holder?: string };

/** 已有稿件「交给 X 写 / 看」：写只在写稿阶段；别的会话正认领着就照实说谁在写，不抢 */
export async function handOff(contentId: string, input: { host?: string | null; mode: HandOffMode }, dataDir: string, deps: HandOffDeps = {}): Promise<HandOffResult> {
  if (!isContentId(contentId) || (input.mode !== "write" && input.mode !== "look")) return { ok: false, code: "bad_request", error: "参数不对" };
  const c = await getContent(contentId, dataDir);
  if (!c || c.deletedAt) return { ok: false, code: "not_found", error: "找不到这条稿" };
  if (input.mode === "write" && !WRITING.has(c.status)) return { ok: false, code: "wrong_stage", error: "这条已经过了写稿这一步，交给 AI 看就行" };
  const claim = input.mode === "write" ? activeClaim(c) : null;
  if (claim) return { ok: false, code: "claim_held", holder: holderLabel(claim.host), error: `${holderLabel(claim.host)} 正在写这篇，不用再交` };
  const pick = await resolveTarget(deps, input.host, dataDir);
  if (!pick.ok) return pick;
  const prompt = input.mode === "write" ? writePrompt(c.title, c.topicId ?? null, c.id, c.platform ?? "douyin") : lookPrompt(c.title, c.id);
  const d = await deliver(pick.host, pick.label, prompt, deps);
  if (input.mode === "write") await updateContent(c.id, { writingHandoff: { host: pick.host, at: new Date().toISOString() } }, dataDir);
  return { ok: true, content_id: c.id, ...d };
}
