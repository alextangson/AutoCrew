import { randomBytes } from "node:crypto";

export type ApprovalAction = "wechat_mp_draft";

interface ApprovalRecord {
  action: ApprovalAction;
  contentId: string;
  workspaceDir: string;
  contentFingerprint: string;
  expiresAt: number;
}

export interface ApprovalBinding {
  action: ApprovalAction;
  contentId: string;
  workspaceDir: string;
  contentFingerprint: string;
}

/** One-shot, version-bound approval capabilities for irreversible/external writes. */
export class ApprovalGate {
  private readonly records = new Map<string, ApprovalRecord>();

  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(binding: ApprovalBinding): { token: string; expiresAt: string } {
    this.sweepExpired();
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.now() + this.ttlMs;
    this.records.set(token, { ...binding, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(token: string, binding: ApprovalBinding): { ok: true } | { ok: false; error: string } {
    const record = this.records.get(token);
    if (!record) return { ok: false, error: "审批凭证无效或已使用，请重新确认" };
    if (record.expiresAt <= this.now()) {
      this.records.delete(token);
      return { ok: false, error: "审批凭证已过期，请重新确认" };
    }
    const matches =
      record.action === binding.action &&
      record.contentId === binding.contentId &&
      record.workspaceDir === binding.workspaceDir &&
      record.contentFingerprint === binding.contentFingerprint;
    if (!matches) return { ok: false, error: "稿件或工作区已变化，请重新确认" };
    this.records.delete(token);
    return { ok: true };
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [token, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(token);
    }
  }
}
