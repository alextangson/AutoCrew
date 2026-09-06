/**
 * 稿卡与编辑器的宿主徽章（P3 spec §6.1 / §5.3）——「这一篇谁在动」。
 *
 * 三种事实，各出一枚徽章：
 *   - `writtenBy`：这一稿是谁写的（哪个宿主，或产品内部写手用的哪条线）。
 *   - `claim`   ：现在谁认领着、认领多久了；租约过期就灰掉——过期不等于没人管，
 *                 它等于「别人现在可以接管，而它的迟到写入会被拒」，这两件事都要说。
 *   - `pack`    ：包发出去了但没收到稿。这一格今天最容易被误读成「后台生成中」，
 *                 所以必须自己出一枚，而不是让稿卡沉默。
 *
 * 全部字段都当**可能不存在**处理：老稿没有这些字段，不该被扣一顶帽子；
 * 后端半片还没上线时前端也不许崩。
 */
import { relativeTime } from "./engine-lib";

export interface ContentClaim {
  employee?: string;
  host?: string;
  at?: string;
  leaseUntil?: string;
}

export interface ContentWrittenBy {
  kind?: string;
  host?: string;
  provider?: string;
  model?: string;
}

export interface ContentPack {
  packId?: string;
  issuedAt?: string;
  host?: string;
  submittedAt?: string;
}

/** 稿卡只用得到这几个字段，所以这里不 import 整个 Content——两边都能独立演进。 */
export interface HostBadgeInput {
  status?: string;
  writtenBy?: ContentWrittenBy | null;
  claim?: ContentClaim | null;
  pack?: ContentPack | null;
}

export type BadgeTone = "host" | "stale";

export interface HostBadge {
  key: "written" | "claim" | "pack";
  text: string;
  /** hover 详情：徽章只放一行，理由和时间放这里 */
  title: string;
  tone: BadgeTone;
}

const HOST_LABEL: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  dsh: "dsh",
  "local-user": "工作台",
};

const EMPLOYEE_LABEL: Record<string, string> = {
  writer: "写",
  cover: "封面",
  editor: "剪辑",
};

/** 宿主名 → 人看的名字。不认识的原样显示，绝不猜成某个已知宿主。 */
export function hostLabel(host?: string | null): string {
  const key = (host ?? "").trim();
  if (!key) return "未知宿主";
  return HOST_LABEL[key] ?? key;
}

export function employeeLabel(employee?: string | null): string {
  const key = (employee ?? "").trim();
  return EMPLOYEE_LABEL[key] ?? (key || "在岗");
}

/** 「Claude 写」「Codex 写」「DeepSeek 写」——最后一种是产品内部写手，报的是线路名。 */
export function writtenByBadge(c: HostBadgeInput): HostBadge | null {
  const w = c.writtenBy;
  if (!w) return null;
  if (w.kind === "host" && w.host) {
    return {
      key: "written",
      text: `${hostLabel(w.host)} 写`,
      title: `这一稿由宿主 ${w.host} 动笔，走的是同一套格式门 / 数字门 / 质量门与审稿人。`,
      tone: "host",
    };
  }
  if (w.kind === "engine" && w.provider) {
    const line = w.model ? `${w.provider} · ${w.model}` : w.provider;
    return {
      key: "written",
      text: `${w.provider} 写`,
      title: `这一稿由产品内部写手生成，线路 ${line}。`,
      tone: "host",
    };
  }
  return null;
}

/** 「Codex 封面中 · 12 分钟前」；租约过了就灰显「租约过期」。 */
export function claimBadge(c: HostBadgeInput, now = Date.now()): HostBadge | null {
  const claim = c.claim;
  if (!claim?.host || !claim.leaseUntil) return null;
  const until = new Date(claim.leaseUntil).getTime();
  if (!isFinite(until)) return null;
  const who = hostLabel(claim.host);
  const job = employeeLabel(claim.employee);
  if (until > now) {
    const since = claim.at ? ` · ${relativeTime(claim.at, now)}` : "";
    return {
      key: "claim",
      text: `${who} ${job}中${since}`,
      title: `${who} 认领了这一篇（${job}），租约 ${relativeTime(claim.leaseUntil, now)}到期。\n别的宿主现在写它会被拒并告知持有者。`,
      tone: "host",
    };
  }
  return {
    key: "claim",
    text: "租约过期",
    title: `${who} 的租约已经到期（${relativeTime(claim.leaseUntil, now)}）。\n别的宿主可以接管；它拿旧令牌的迟到写入会被拒。也可以在这里直接接着改。`,
    tone: "stale",
  };
}

/** 「领包不提交」（§8）：包发出去了、稿没回来。不许再被误报成「后台生成中」。 */
export function packWaitBadge(c: HostBadgeInput, now = Date.now()): HostBadge | null {
  const pack = c.pack;
  if (!pack?.issuedAt || pack.submittedAt) return null;
  if (c.status !== "drafting" && c.status !== "revision") return null;
  const who = hostLabel(pack.host);
  const since = relativeTime(pack.issuedAt, now);
  return {
    key: "pack",
    text: `未收到稿 · ${since}`,
    title: `写作包已发给 ${who}（${since}），还没收到稿。\n它可能还在写；要换人写就让宿主重新领一次包，旧包号当场作废。`,
    tone: "stale",
  };
}

/** 稿卡/编辑器一次要的全部徽章，按「谁写的 → 谁在动 → 领了没交」排。 */
export function hostBadges(c: HostBadgeInput, now = Date.now()): HostBadge[] {
  return [writtenByBadge(c), claimBadge(c, now), packWaitBadge(c, now)].filter(
    (b): b is HostBadge => b !== null,
  );
}
