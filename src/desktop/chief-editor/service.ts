/**
 * 总编辑本机 agent 的进程内状态（spec §地基 1 / 4 / 5 / 6）。
 *
 * - 会话级 MCP 令牌：服务端记 {后端, 资料库, 对话, 轮次}，只认 /mcp，本轮结束即撤销；
 * - 全局只有一个活跃轮（v1 只跑 1 个 agent），check-and-set 全同步；
 * - 卡片按调用 id 去重，先落盘（run 记录）再推送。
 */
import { randomBytes } from "node:crypto";
import { appendTurn } from "../../storage/conversation-store.js";
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
  killGraceMs?: number;
  askTtlMs?: number;
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
}

export class ChiefEditor {
  readonly runs: RunStore;
  readonly asks: AskRegistry;
  readonly authFailed = new Set<LocalBackendId>();
  private readonly tokens = new Map<string, TokenBinding>();
  active: ActiveTurn | null = null;

  constructor(readonly deps: ChiefEditorDeps) {
    this.runs = new RunStore(deps.home);
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
    await appendTurn(binding.conversationId, { content: "（后台结果）", origin: "system" }, { content: "本机 agent 在轮次结束后返回了一条结果：", cards: [bg] }, binding.dataDir)
      .catch((err) => console.warn(`[chief-editor] 后台结果落盘失败：${err instanceof Error ? err.message : String(err)}`));
    this.deps.emit({ type: "background", conversationId: binding.conversationId, card: bg });
  }

  pendingView(conversationId?: string): { running: Record<string, unknown> | null; asks: AskView[] } {
    const a = this.active;
    const running = a && (!conversationId || a.conversationId === conversationId)
      ? { turnId: a.turnId, conversationId: a.conversationId, status: a.status, backend: a.backend, cards: a.cards }
      : null;
    return { running, asks: this.asks.pending(conversationId ? { conversationId } : undefined) };
  }

  statuses(builtinConfigured: boolean, activeDataDir: string): { backends: BackendStatus[]; running: Record<string, unknown> | null } {
    const a = this.active;
    return {
      backends: backendStatuses({ authFailed: this.authFailed, builtinConfigured }),
      running: a ? { conversationId: a.conversationId, backend: a.backend, otherLibrary: a.dataDir !== activeDataDir } : null,
    };
  }

  /** 守护进程启动：残留轮标中断、清孤儿进程组，并在各自对话里留一句（不自动重放） */
  async recoverOnStartup(killGroup?: (pid: number, command: string) => boolean): Promise<RunRecord[]> {
    const leftovers = this.runs.recoverOnStartup(killGroup);
    for (const r of leftovers) {
      await appendTurn(
        r.conversationId,
        { content: r.message },
        { content: "⚠️ 这一轮被中断了（守护进程重启）。已完成的写动作不会自动重做；需要的话直接重发，能续上原会话就续，续不上会说一句「已新开」。", turnId: r.turnId },
        r.dataDir,
      ).catch(() => { /* 对话已删：记录照样标中断 */ });
    }
    return leftovers;
  }
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
