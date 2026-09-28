/**
 * 待人应答的卡片：执行前审批卡 + shell/文件权限卡（spec §地基 2 / 3 / 9）。
 *
 * 纪律：
 * - 服务端 id、有期限（10 分钟没人理按拒绝）、**单次消费**——多标签页同时点，只有第一个算数；
 * - 停止 / 超时 / 进程退出都让它失效；
 * - 批准后的审批凭证（ApprovalGate token）只留在这里，agent 手里只有 approval_id。
 */
import { randomBytes } from "node:crypto";
import type { ApprovalBinding } from "../approval-gate.js";
import { redactAndTruncate } from "./redact.js";

export const ASK_TTL_MS = 10 * 60 * 1000;

export type AskKind = "approval" | "permission";
export type AskStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface AskView {
  id: string;
  kind: AskKind;
  turnId: string;
  conversationId: string;
  status: AskStatus;
  expiresAt: string;
  title: string;
  detail: string;
}

interface AskRecord extends AskView {
  /** 审批结果是否已经告诉过 agent（批准可能在 agent 还在说话时就到了，收尾后要补一句） */
  reported?: boolean;
  binding?: ApprovalBinding;
  approvalToken?: string;
  onSettle?: (status: AskStatus) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export type AskEvent = { type: "ask"; ask: AskView } | { type: "ask_resolved"; ask: AskView };

export interface AskDeps {
  issueApproval: (binding: ApprovalBinding) => { token: string };
  emit: (e: AskEvent) => void;
  ttlMs?: number;
  now?: () => number;
}

export class AskRegistry {
  private readonly asks = new Map<string, AskRecord>();

  constructor(private readonly deps: AskDeps) {}

  private view(r: AskRecord): AskView {
    const { id, kind, turnId, conversationId, status, expiresAt, title, detail } = r;
    return { id, kind, turnId, conversationId, status, expiresAt, title, detail };
  }

  private create(input: Omit<AskView, "id" | "status" | "expiresAt">, extra: Partial<AskRecord>): AskRecord {
    const ttl = this.deps.ttlMs ?? ASK_TTL_MS;
    const now = (this.deps.now ?? Date.now)();
    const record: AskRecord = {
      ...input,
      title: redactAndTruncate(input.title, 80),
      detail: redactAndTruncate(input.detail, 300),
      id: `ask-${randomBytes(9).toString("base64url")}`,
      status: "pending",
      expiresAt: new Date(now + ttl).toISOString(),
      ...extra,
    };
    record.timer = setTimeout(() => this.settle(record, "expired"), ttl);
    record.timer.unref?.();
    this.asks.set(record.id, record);
    this.deps.emit({ type: "ask", ask: this.view(record) });
    return record;
  }

  /** 权限卡：返回的 promise 在应答/超时/取消时落定，超时与取消都算拒绝 */
  requestPermission(input: { turnId: string; conversationId: string; title: string; detail: string }): { id: string; decision: Promise<"allow" | "deny"> } {
    let resolve!: (d: "allow" | "deny") => void;
    const decision = new Promise<"allow" | "deny">((r) => { resolve = r; });
    const record = this.create({ ...input, kind: "permission" }, {
      onSettle: (status) => resolve(status === "approved" ? "allow" : "deny"),
    });
    return { id: record.id, decision };
  }

  requestApproval(input: { turnId: string; conversationId: string; title: string; detail: string; binding: ApprovalBinding }): AskView {
    const { binding, ...rest } = input;
    return this.view(this.create({ ...rest, kind: "approval" }, { binding }));
  }

  private settle(record: AskRecord, status: AskStatus): void {
    if (record.status !== "pending") return;
    record.status = status;
    if (record.timer) clearTimeout(record.timer);
    if (status === "approved" && record.binding) record.approvalToken = this.deps.issueApproval(record.binding).token;
    record.onSettle?.(status);
    this.deps.emit({ type: "ask_resolved", ask: this.view(record) });
  }

  /** 人的应答：单次消费，第二个标签页拿到「已在别处处理」 */
  answer(id: string, decision: "allow" | "deny"): { ok: true; ask: AskView } | { ok: false; error: string } {
    const record = this.asks.get(id);
    if (!record) return { ok: false, error: "这张卡已失效（停止、超时或守护进程重启过）" };
    if (record.status !== "pending") return { ok: false, error: `这张卡已经处理过了（${STATUS_TEXT[record.status]}）` };
    this.settle(record, decision === "allow" ? "approved" : "denied");
    return { ok: true, ask: this.view(record) };
  }

  /** 停止 / 进程退出：本轮所有待处理卡作废 */
  cancelTurn(turnId: string): void {
    for (const r of this.asks.values()) if (r.turnId === turnId) this.settle(r, "cancelled");
  }

  pending(filter?: { conversationId?: string }): AskView[] {
    return [...this.asks.values()]
      .filter((r) => r.status === "pending" && (!filter?.conversationId || r.conversationId === filter.conversationId))
      .map((r) => this.view(r));
  }

  /** 本轮还没告诉过 agent 结果的审批卡（含仍在等的） */
  unreportedApprovals(turnId: string): AskView[] {
    return [...this.asks.values()].filter((r) => r.turnId === turnId && r.kind === "approval" && !r.reported).map((r) => this.view(r));
  }

  markReported(ids: string[]): void {
    for (const id of ids) { const r = this.asks.get(id); if (r) r.reported = true; }
  }

  pendingApprovals(turnId: string): AskView[] {
    return [...this.asks.values()].filter((r) => r.turnId === turnId && r.kind === "approval" && r.status === "pending").map((r) => this.view(r));
  }

  /** 等本轮所有审批卡落定（批准 / 拒绝 / 超时 / 取消），返回落定后的卡 */
  async settledApprovals(turnId: string, ids: string[]): Promise<AskView[]> {
    await Promise.all(ids.map((id) => new Promise<void>((resolve) => {
      const r = this.asks.get(id);
      if (!r || r.status !== "pending") return resolve();
      const prev = r.onSettle;
      r.onSettle = (s) => { prev?.(s); resolve(); };
    })));
    return ids.map((id) => this.asks.get(id)).filter((r): r is AskRecord => Boolean(r) && r!.turnId === turnId).map((r) => this.view(r));
  }

  /** agent 带 approval_id 重调时取回审批（只认已批准、未消费的） */
  approvedToken(approvalId: string): { token: string; binding: ApprovalBinding; conversationId: string } | null {
    const r = this.asks.get(approvalId);
    if (!r || r.kind !== "approval" || r.status !== "approved" || !r.approvalToken || !r.binding) return null;
    return { token: r.approvalToken, binding: r.binding, conversationId: r.conversationId };
  }

  /** 凭证用过一次就作废（ApprovalGate 本身也是单次，这里同步清掉，别让它重复出现在视图里） */
  consumed(approvalId: string): void {
    const r = this.asks.get(approvalId);
    if (r) r.approvalToken = undefined;
  }
}

export const STATUS_TEXT: Record<AskStatus, string> = {
  pending: "等你处理",
  approved: "已允许",
  denied: "已拒绝",
  expired: "超过 10 分钟没人处理，按拒绝",
  cancelled: "本轮已停，作废",
};
