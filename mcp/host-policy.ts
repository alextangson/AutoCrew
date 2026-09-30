/**
 * 按宿主限权（P6 spec §3.4；codex 评审 #9）——服务端的硬门，不靠人设自觉。
 *
 * Codex 在 P6 里只是剪辑工位：唯一的写动作是 `autocrew_video register`（外加撤回自己那一代交接），
 * 其余只读查询。写稿、审稿、发布都在 Claude 会话里做——人设写「不许调」挡不住模型照调，
 * 这里挡得住。别的宿主（claude-code / dsh / local-user）不受限。
 *
 * 只按宿主名判：MCP 层看得到的身份就是命名 token 的主体，看不到它此刻「扮演」哪个岗位。
 */
import type { McpAccessContext, McpPrincipal } from "./access.js";
import { LOCAL_HOST } from "../src/storage/local-store.js";
import { isOntologyEnabled } from "../src/storage/production-store.js";
import { closedResult } from "../src/modules/production/closed.js";

/** `result`：拒绝时要回给宿主的结构化回执（带 code / next_action），没有就只回一句话 */
export type PolicyDecision = { ok: true } | { ok: false; error: string; result?: Record<string, unknown> };

export const CODEX_EDITOR_DENIED = "剪辑工位（codex）只允许 match/confirm/handoff(带确认)/register/report/status/revoke、asset add（登记素材路径）、publish check / propose_preference 与只读查询；写稿与其他发布动作在 Claude 会话里做";

/** 工具 → 放行的 action（`*` = 整个工具放行） */
type Allowlist = Readonly<Record<string, ReadonlySet<string> | "*">>;

const HOST_ALLOWLISTS: Readonly<Record<string, Allowlist>> = {
  codex: {
    autocrew_video: new Set(["register", "status", "revoke", "report", "match", "confirm"]),
    // 本体 §3：剪辑工位只报事实（原片 / 成片 / 字幕 / 封面 / ChatCut 工程），不带任何批准语义
    // check_slivers：导出前自查抽帧缝，只读（spec 2026-09-30 §7）
    // 等你拍板 2a：剪辑途中请示创始人（ask / 转述回答 / 撤回）、给成片补标「可以审了」
    autocrew_content: new Set(["get", "summary", "record", "check_slivers", "ask", "answer_ask", "withdraw_ask", "mark_ready"]),
    // 素材只写路径（§13.4-F）：库内记相对路径，库外挪进项目再记
    autocrew_asset: new Set(["add"]),
    autocrew_desk: new Set(["inbox", "claim", "release"]),
    autocrew_status: "*",
    // 发布前把关 §2：Codex 发布时只能跑检查、提议偏好；其他发布动作（出包、推草稿、标已发布）照旧不给
    autocrew_publish: new Set(["check", "propose_preference"]),
  },
};

const DENIED_MESSAGE: Readonly<Record<string, string>> = { codex: CODEX_EDITOR_DENIED };

/** 启用本体后的剪辑工位：只报事实，不再 match / confirm / handoff */
export const CODEX_EDITOR_DENIED_ONTOLOGY = "剪辑工位（codex）在本体下只报事实：autocrew_content record（原片 / 成片 / 字幕 / 封面 / ChatCut 工程 / 分镜审阅页）、content get / summary / check_slivers / mark_ready / ask / answer_ask / withdraw_ask、asset add、publish check / propose_preference 与只读查询；审片、选封面、发布只有创始人在「等你拍板」里点";

/**
 * 所有命名宿主共用的硬拒（P6-e r3：模型绕开 handoff 的门后，转而用 `autocrew_content adoption`
 * 替创作者记「采纳」——那是采纳率北极星的读数）。采纳是创作者自己的动作：只在工作台记，
 * 或发布时隐式推导；宿主不能代填。
 */
export const ADOPTION_HOST_DENIED = "采纳是创作者自己的动作：只在工作台记，或发布时隐式推导；宿主不能代填 autocrew_content adoption";
const HOST_DENIED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = { autocrew_content: new Set(["adoption"]) };

export const CODEX_HANDOFF_NEEDS_CONFIRMATION = "剪辑工位发起交接必须带 confirmation_id：先 autocrew_video match、再 confirm 让创始人在 Mac 弹窗里点确认";

/** codex 的 handoff 只在带着确认记录（或撤回）时放行；记录是否有效由 handoff 自己核 */
function codexHandoff(args: Record<string, unknown>, ontology: boolean): PolicyDecision {
  // 本体已启用：不再交接，和工具里关掉的旧入口说同一句（不再要求 confirmation_id）
  if (ontology) { const r = closedResult(typeof args.content_id === "string" ? args.content_id : undefined); return { ok: false, error: r.error, result: r }; }
  const confirmed = typeof args.confirmation_id === "string" && args.confirmation_id.trim() !== "";
  if (confirmed || args.revoke === true) return { ok: true };
  return { ok: false, error: CODEX_HANDOFF_NEEDS_CONFIRMATION, result: {
    ok: false, code: "confirmation_required", error: CODEX_HANDOFF_NEEDS_CONFIRMATION,
    next_action: "先调 autocrew_video match{aroll_path, request_id} 拿回执，再调 confirm{receipt_id, cover_text, target_seconds, request_id} 让创始人在弹窗里点确认，最后带 confirmation_id 调 handoff。",
  } };
}

export function hostPolicy(host: string, tool: string, args: Record<string, unknown>, ontology = false): PolicyDecision {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (host === "codex" && tool === "autocrew_video" && action === "handoff") return codexHandoff(args, ontology);
  if (host !== LOCAL_HOST && HOST_DENIED_ACTIONS[tool]?.has(action)) return { ok: false, error: ADOPTION_HOST_DENIED };
  const allowlist = HOST_ALLOWLISTS[host];
  if (!allowlist) return { ok: true };
  const allowed = allowlist[tool];
  if (allowed === "*" || (allowed && allowed.has(action))) return { ok: true };
  return { ok: false, error: (ontology && host === "codex" ? CODEX_EDITOR_DENIED_ONTOLOGY : DENIED_MESSAGE[host]) ?? `宿主 ${host} 不允许调用 ${tool} ${action}` };
}

/** 接到 `McpAccessContext.authorize` 上：宿主名就是命名 token 的主体 */
export function hostAuthorize(host: string): NonNullable<McpAccessContext["authorize"]> {
  return async (_principal: McpPrincipal, tool: string, args: Record<string, unknown>) => hostPolicy(host, tool, args, await isOntologyEnabled().catch(() => false));
}

/**
 * 工具表面瘦身（P6 §3.7）：宿主会话默认不列的工具——老的一步生成/改写/润色线与低频管理面。
 * 只是不列：注册表不动，工作台/CLI/dsh 照样全有；宿主硬调照样执行，回执多一句 `host_note`。
 */
export const HOST_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "autocrew_generate",
  "autocrew_rewrite",
  "autocrew_revise",
  "autocrew_humanize",
  "autocrew_style",
  "autocrew_memory",
  "autocrew_flywheel",
  "autocrew_pro_status",
  "autocrew_init",
]);

/**
 * `tools/list` 按宿主过滤：`local-user`（工作台、老 token）全列；命名宿主去掉隐藏工具；
 * 有白名单的宿主（codex）只列它调得动的——列出来却一调就拒，等于白占上下文还诱导它去调。
 */
export function hostListsTool(host: string, tool: string): boolean {
  if (host === LOCAL_HOST) return true;
  if (HOST_HIDDEN_TOOLS.has(tool)) return false;
  const allowlist = HOST_ALLOWLISTS[host];
  return !allowlist || Object.hasOwn(allowlist, tool);
}

/** 宿主硬调了一个不列的工具：照常执行，回执带这一句，让它知道主路不在这儿 */
export function hiddenToolNote(host: string, tool: string): string | undefined {
  if (host === LOCAL_HOST || !HOST_HIDDEN_TOOLS.has(tool)) return undefined;
  return `${tool} 不在宿主工具清单里（留给工作台/CLI）；本次照常执行，写稿主路走 autocrew_workflow → autocrew_writer`;
}
