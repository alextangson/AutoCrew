/**
 * 总编辑本机 agent 的进程内状态（spec §地基 1 / 4 / 5 / 6）。
 *
 * - 会话级 MCP 令牌：服务端记 {后端, 资料库, 对话, 轮次}，只认 /mcp，本轮结束即撤销；
 * - 全局只有一个活跃轮（v1 只跑 1 个 agent），check-and-set 全同步；
 * - 卡片按调用 id 去重，先落盘（run 记录）再推送。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendTurn, type ConversationMeta } from "../../storage/conversation-store.js";
import { enqueueConversationWrite } from "../chat-persist.js";
import type { ApprovalBinding } from "../approval-gate.js";
import { AskRegistry, type AskView } from "./asks.js";
import { backendStatuses, type BackendStatus, type LocalBackendId } from "./backends.js";
import type { AgentProcess, SpawnAgent } from "./acp-process.js";
import type { ContentSnapshot } from "./publish-gate.js";
import { RunStore, type RunRecord, type RunStatus } from "./run-store.js";

export interface TokenBinding {
  token: string;
  backend: LocalBackendId;
  dataDir: string;
  conversationId: string;
  turnId: string;
}

export interface ChiefEditorDeps {
  home: string;
  mcpUrl: string;
  spawnAgent: SpawnAgent;
  execMcp: (request: Record<string, unknown>, dataDir: string, turnId: string) => Promise<Record<string, unknown> | null>;
  approvals: {
    issue: (b: ApprovalBinding) => { token: string };
    consume: (token: string, b: ApprovalBinding) => { ok: true } | { ok: false; error: string };
  };
  /** SSE `agent` 事件出口 */
  emit: (data: Record<string, unknown>) => void;
  getContent: (id: string, dataDir: string) => Promise<ContentSnapshot | null>;
  /** 选题快照（删选题审批的指纹用）：title + 其余字段序列化进 body */
  getTopic?: (id: string, dataDir: string) => Promise<ContentSnapshot | null>;
  killGraceMs?: number;
  askTtlMs?: number;
}

/** 工作记录的一条（工具调用 / 自动放行 / 压缩） */
export interface WorkItem {
  id: string;
  name: string;
  status: "running" | "done" | "failed";
  error?: string;
  /** 旁注（如「等你批准」：业务审批拦下不算出错） */
  note?: string;
  kind?: "compact";
}

export interface ActiveTurn {
  turnId: string;
  clientId: string;
  conversationId: string;
  dataDir: string;
  backend: LocalBackendId;
  status: RunStatus;
  token?: string;
  process?: AgentProcess;
  sessionId?: string;
  cards: Record<string, unknown>[];
  /** 已完成的写动作（停止时列给人看，§边界 2） */
  writes: string[];
  /** 已开始、还没完成的写类工具（停止时如实说「可能已部分生效」） */
  inFlight: Map<string, string>;
  aborted: boolean;
  /** 工作记录：工具调用、自动放行、压缩——收尾时作为一张卡落进对话 */
  worklog: WorkItem[];
  /** 这段对话是「全部放行」档（轮次开始时读定，U1） */
  bypass: boolean;
  /** 最近一次 usage_update：上下文用量 */
  usage?: { used: number; size?: number };
}

export class ChiefEditor {
  readonly runs: RunStore;
  readonly asks: AskRegistry;
  readonly authFailed = new Set<LocalBackendId>();
  private readonly tokens = new Map<string, TokenBinding>();
  /** 「本对话都允许」：只在内存，换对话 / 守护进程重启即回到每次问（U5） */
  private readonly allowAll = new Set<string>();
  /** 适配器最近一次上报的模型 / 思考强度清单（按后端），切换器据此显示；没报就空 */
  readonly reported = new Map<LocalBackendId, { models: Array<{ value: string; label: string }>; efforts: Array<{ value: string; label: string }> }>();

  /** 记下适配器上报的清单并落盘：守护进程重启后切换器还能显示（没报过就只有「默认」，U2） */
  rememberChoices(backend: LocalBackendId, choices: { models: Array<{ value: string; label: string }>; efforts: Array<{ value: string; label: string }> }): void {
    this.reported.set(backend, choices);
    try {
      fs.mkdirSync(this.deps.home, { recursive: true });
      fs.writeFileSync(path.join(this.deps.home, "reported.json"), JSON.stringify(Object.fromEntries(this.reported)), "utf-8");
    } catch { /* 记不下来只影响下次启动前的显示 */ }
  }

  private loadReported(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.deps.home, "reported.json"), "utf-8")) as Record<string, { models?: unknown; efforts?: unknown }>;
      for (const [k, v] of Object.entries(raw)) {
        if (Array.isArray(v.models) && Array.isArray(v.efforts)) this.reported.set(k as LocalBackendId, { models: v.models as never, efforts: v.efforts as never });
      }
    } catch { /* 没有记录 = 没上报过 */ }
  }

  conversationAllowed(conversationId: string): boolean {
    return this.allowAll.has(conversationId);
  }

  setConversationAllow(conversationId: string, on: boolean): void {
    if (on) this.allowAll.add(conversationId);
    else this.allowAll.delete(conversationId);
  }
  active: ActiveTurn | null = null;

  constructor(readonly deps: ChiefEditorDeps) {
    this.runs = new RunStore(deps.home);
    this.loadReported();
    this.asks = new AskRegistry({
      issueApproval: (b) => deps.approvals.issue(b),
      emit: (e) => deps.emit(e),
      ...(deps.askTtlMs ? { ttlMs: deps.askTtlMs } : {}),
    });
  }

  issueToken(binding: Omit<TokenBinding, "token">): string {
    const token = `ce_${randomBytes(32).toString("base64url")}`;
    this.tokens.set(token, { ...binding, token });
    return token;
  }

  revokeToken(token: string | undefined): void {
    if (token) this.tokens.delete(token);
  }

  tokenLive(token: string): boolean {
    return this.tokens.has(token);
  }

  /** `Authorization: Bearer ce_…` → 绑定；未知/已撤销返回 null（调用方按普通鉴权走，最终 401） */
  bindingFor(authorization: string | string[] | undefined): TokenBinding | null {
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header?.startsWith("Bearer ce_")) return null;
    return this.tokens.get(header.slice(7)) ?? null;
  }

  /** 这枚令牌所属的轮此刻是否仍在进行（调用进入时据此归属，§地基 4） */
  liveTurnFor(binding: TokenBinding): string | null {
    const a = this.active;
    return a && a.turnId === binding.turnId && !a.aborted ? a.turnId : null;
  }

  setStatus(turn: ActiveTurn, status: RunStatus): void {
    turn.status = status;
    this.runs.patch(turn.turnId, { status });
    this.deps.emit({ type: "turn", turnId: turn.turnId, conversationId: turn.conversationId, status });
  }

  /**
   * 工具结果入账：调用进入时所属的轮仍在跑 → 进本轮卡片（先写 run 记录再推 SSE）；
   * 否则（停止后才返回、或根本没有进行中的轮）→ 记为后台结果追加到对话，不串到下一轮。
   */
  async recordCard(entryTurnId: string | null, binding: TokenBinding, card: Record<string, unknown>, write?: string): Promise<void> {
    const a = this.active;
    if (entryTurnId && a && a.turnId === entryTurnId && !a.aborted) {
      if (a.cards.some((c) => c.callId === card.callId)) return;
      a.cards.push(card);
      if (write) a.writes.push(write);
      this.runs.patch(a.turnId, { cards: a.cards, writes: a.writes });
      this.deps.emit({ type: "card", turnId: a.turnId, conversationId: a.conversationId, card });
      return;
    }
    const bg = { ...card, background: true };
    await appendConversation(binding.conversationId, { content: "（后台结果）", origin: "system" }, { content: "本机 agent 在轮次结束后返回了一条结果：", cards: [bg] }, binding.dataDir)
      .catch((err) => console.warn(`[chief-editor] 后台结果落盘失败：${err instanceof Error ? err.message : String(err)}`));
    this.deps.emit({ type: "background", conversationId: binding.conversationId, card: bg });
  }

  /**
   * 刷新/重连后的重挂视图。只给本资料库的：别的库里跑着的 agent 只经 statuses().running.otherLibrary 提示，
   * 它的卡不能在这边被批（评审 P2-15）。owner = 请求方就是发起这一轮的标签页；其余标签页只旁观（P2-14）。
   */
  pendingView(opts: { conversationId?: string; dataDir: string; clientId?: string }): { running: Record<string, unknown> | null; asks: AskView[] } {
    const a = this.active;
    if (!a || a.dataDir !== opts.dataDir) return { running: null, asks: [] };
    const running = !opts.conversationId || a.conversationId === opts.conversationId
      ? { turnId: a.turnId, conversationId: a.conversationId, status: a.status, backend: a.backend, cards: a.cards, worklog: a.worklog, owner: Boolean(opts.clientId) && opts.clientId === a.clientId }
      : null;
    return { running, asks: this.asks.pending(opts.conversationId ? { conversationId: opts.conversationId } : undefined) };
  }

  statuses(builtinConfigured: boolean, activeDataDir: string): { backends: BackendStatus[]; running: Record<string, unknown> | null } {
    const a = this.active;
    return {
      backends: backendStatuses({ authFailed: this.authFailed, builtinConfigured }).map((b) => {
        const r = this.reported.get(b.id as LocalBackendId);
        return r ? { ...b, models: r.models, efforts: r.efforts } : b;
      }),
      running: a ? { conversationId: a.conversationId, backend: a.backend, otherLibrary: a.dataDir !== activeDataDir } : null,
    };
  }

  /**
   * 守护进程启动：残留轮标中断、清孤儿进程组，并在各自对话里留一句（不自动重放）。
   * 这一轮已入账的卡片和写动作一起写进去——结果没来得及落盘的轮，在这里补上。
   */
  async recoverOnStartup(killGroup?: (pid: number, command: string) => boolean): Promise<RunRecord[]> {
    const leftovers = this.runs.recoverOnStartup(killGroup);
    for (const r of leftovers) {
      const writes = r.writes?.length ? `中断前已完成的写动作：${r.writes.join("；")}。` : "中断前没有记录到完成的写动作。";
      const content = `⚠️ 这一轮被中断了（守护进程重启）。${writes}已完成的写动作不会自动重做；需要的话直接重发，能续上原会话就续，续不上会说一句「已新开」。`;
      await appendConversation(r.conversationId, { content: r.message }, { content, cards: r.cards ?? [], turnId: r.turnId }, r.dataDir)
        .catch(() => { /* 对话已删：记录照样标中断 */ });
    }
    return leftovers;
  }
}

/** 会话写入一律走 chat-persist 的按会话串行队列 */
export function appendConversation(
  id: string,
  user: { content: string; origin?: "system" },
  assistant: { content: string; cards?: Record<string, unknown>[]; turnId?: string },
  dataDir: string,
): Promise<ConversationMeta | null> {
  return enqueueConversationWrite(id, () => appendTurn(id, user, assistant, dataDir));
}

let instance: ChiefEditor | null = null;

export function initChiefEditor(deps: ChiefEditorDeps): ChiefEditor {
  instance = new ChiefEditor(deps);
  return instance;
}

export function getChiefEditor(): ChiefEditor | null {
  return instance;
}

/** 测试用 */
export function resetChiefEditor(): void {
  instance = null;
}
