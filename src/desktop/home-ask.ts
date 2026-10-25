/**
 * 首页「让 AI 看看」（管线重规划 §1、§8-11）：账号洞察 / 开排期会 / 复盘刚发那条。
 * 网页不自己跑分析：服务端拼好指令，走写稿交接同一个 deliver()（Claude 预填 / Codex 粘贴 / 总编辑填进对话框）。
 * 指令点名要调的 MCP 工具和技能、范围和「数据缺了就说缺」，任何接了 AutoCrew MCP 的 agent 都照着做得下去。
 */
import { getContent } from "../storage/local-store.js";
import { isContentId } from "../storage/entity-id.js";
import { deliver, resolveTarget, type Delivery, type HandOffDeps } from "./writing-handoff.js";
import type { WriterPick } from "./host-connect/writing-host.js";

export type AskKind = "insights" | "meeting" | "retro";
export const ASK_KINDS: readonly AskKind[] = ["insights", "meeting", "retro"];

const NO_MAKEUP = "数据缺了、读失败了就照实说缺什么，不编数字、不拿旧数字当今天。";

export function insightsPrompt(): string {
  return [
    "做一次账号洞察：用 AutoCrew MCP 的 autocrew_insights。",
    "先调 action:\"prepare\" 冻结近 30 天的账号事实（只看我在设置里勾了的运营平台），读它返回的事实和 next_action；",
    "分析哪类题在涨粉 / 涨播放、哪类在掉，每条结论都要指到具体作品和数字；",
    "分析完用 action:\"submit\" 把报告存回去，最后给我三条结论和一条下周可以试的做法。",
    NO_MAKEUP,
    "只分析，不要改任何稿件或设置。",
  ].join("");
}

export function meetingPrompt(): string {
  return [
    "开排期会：照 schedule-meeting 技能走。",
    "先用 AutoCrew MCP 的 autocrew_insights action:\"meeting_brief\" 读确定性简报（回流健康度、作品 D+3/D+7、同平台基线、上次下注对账）；读失败就把原始错误告诉我并停会。",
    "然后结合选题库和在写的稿（autocrew_content summary）提下周片单，每条写清理由；片单要我用原话定了，才用 meeting_save 存。",
    NO_MAKEUP,
  ].join("");
}

export function retroPrompt(title: string, contentId: string): string {
  const short = Array.from(title).slice(0, 60).join("");
  return [
    `复盘刚发那条《${short}》（content_id: ${contentId}）：`,
    `先用 AutoCrew MCP 的 autocrew_content summary 看这条现在的状态和发布记录；`,
    "再用 autocrew_insights action:\"calib_status\" 看它有没有待复盘的预测——有就按 calib_retro{content_id} 的要求做 T+3 复盘（验证 / 推翻每个因素），没有就只做数据对比；",
    "各平台的回流数字跟这个平台平时同发出时长比，说清哪个平台好、哪个差、最可能的原因和下一条要改的一件事。",
    NO_MAKEUP,
    "复盘结论要我认了才写回，不要改稿。",
  ].join("");
}

export type AskResult = ({ ok: true; kind: AskKind } & Delivery) | Exclude<WriterPick, { ok: true }> | { ok: false; code: string; error: string };

/** 拼指令 → 选交给谁（同写稿交接：本机 AI 优先，没有就总编辑，都没有 = no_writer）→ deliver */
export async function askAI(input: { kind: string; content_id?: unknown; host?: string | null }, dataDir: string, deps: HandOffDeps = {}): Promise<AskResult> {
  const kind = input.kind as AskKind;
  if (!ASK_KINDS.includes(kind)) return { ok: false, code: "bad_request", error: "不认识的分析类型" };
  let prompt: string;
  if (kind === "retro") {
    const id = typeof input.content_id === "string" ? input.content_id : "";
    if (!isContentId(id)) return { ok: false, code: "no_latest", error: "还没有能复盘的那条：刚发那条还没关联到稿件" };
    let c: Awaited<ReturnType<typeof getContent>>;
    try { c = await getContent(id, dataDir); } catch (e) { return { ok: false, code: "read_failed", error: `这条稿读不出来：${e instanceof Error ? e.message : String(e)}` }; }
    if (!c || c.deletedAt) return { ok: false, code: "not_found", error: "找不到这条稿" };
    prompt = retroPrompt(c.title, c.id);
  } else prompt = kind === "insights" ? insightsPrompt() : meetingPrompt();
  const pick = await resolveTarget(deps, input.host ?? null, dataDir);
  if (!pick.ok) return pick;
  return { ok: true, kind, ...(await deliver(pick.host, pick.label, prompt, deps)) };
}
