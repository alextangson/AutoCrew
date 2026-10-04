/**
 * 选题会的并行调研（创始人 2026-10-04 规则 1、2）。
 *
 * 宿主研究原来一个选题一份任务、一个持有者，四个视角只能串着做。现在每个视角可以单独认领：
 * `claim{perspective}` 发一枚视角令牌，主会话把令牌交给子代理，各自 search / read_page / 提交，
 * 互不等待。同一视角已被活着的令牌占着 → `perspective_claimed`；令牌闲置 30 分钟算超时，
 * 回执里明写 timed_out，可被重新认领。做不下去就 `fail_perspective` 说明原因，回执里一直摆着，
 * 重领重跑；综合必须五路齐（四个调研视角 + 账号数据），缺一路就拒绝，不静默跳过。
 *
 * 第五路「账号数据」由排期会简报确定性生成（不调模型）：按形式/画像的同龄表现，带 n；
 * 数据不够就照实写不够。读失败同样记成失败视角，`account_data` 可单独重跑。
 */
import crypto from "node:crypto";
import { buildMeetingBrief } from "../modules/meetings/meeting-brief.js";
import { listContentsStrict } from "../storage/local-store.js";
import { formatSummaryOf } from "../modules/meetings/meeting-angle.js";
import type { GroupRow } from "../modules/meetings/meeting-works.js";
import { HostResearchError, type AccountDataPerspective, type HostResearchTask } from "../modules/research/host-research-store.js";
import { PERSPECTIVE_NAMES, type PerspectiveName } from "../modules/research/research-job-store.js";

export const ACCOUNT_PERSPECTIVE = "account";
export const CLAIM_IDLE_MS = 30 * 60_000;

export type PerspectiveState = "submitted" | "claimed" | "timed_out" | "failed" | "pending";

const isLive = (touchedAt: string, now: number) => now - Date.parse(touchedAt) < CLAIM_IDLE_MS;

export function perspectiveState(task: HostResearchTask, name: PerspectiveName, now = Date.now()): PerspectiveState {
  if (task.perspectives[name]) return "submitted";
  const claim = task.perspectiveClaims?.[name];
  if (claim) return isLive(claim.touchedAt, now) ? "claimed" : "timed_out";
  return task.perspectiveFailures?.[name] ? "failed" : "pending";
}

/** 五路进度：调研视角的认领/失败/超时与账号数据视角都明摆着 */
export function perspectivesView(task: HostResearchTask, now = Date.now()): Record<string, unknown>[] {
  const research = PERSPECTIVE_NAMES.map((name) => {
    const claim = task.perspectiveClaims?.[name];
    const failure = task.perspectiveFailures?.[name];
    const state = perspectiveState(task, name, now);
    return {
      name, status: state,
      ...(claim && state !== "submitted" ? { holder: claim.host, claimed_at: claim.claimedAt, expires_at: new Date(Date.parse(claim.touchedAt) + CLAIM_IDLE_MS).toISOString() } : {}),
      ...(failure && state !== "submitted" ? { last_failure: failure.reason, failed_at: failure.at } : {}),
    };
  });
  const account = task.accountData;
  return [...research, {
    name: ACCOUNT_PERSPECTIVE,
    status: !account ? "pending" : account.status === "ok" ? "submitted" : "failed",
    ...(account?.status === "failed" ? { last_failure: account.reason } : {}),
  }];
}

/** 还没齐的路：调研视角缺提交、账号数据没生成或失败 */
export function missingForSynthesis(task: HostResearchTask): string[] {
  const missing: string[] = PERSPECTIVE_NAMES.filter((n) => !task.perspectives[n]);
  if (task.accountData?.status !== "ok") missing.push(ACCOUNT_PERSPECTIVE);
  return missing;
}

/** 认领一个视角，发令牌。已提交 / 被活令牌占着 → 拒绝；超时或失败过的可以重领 */
export function claimPerspective(task: HostResearchTask, name: PerspectiveName, host: string, now = Date.now()): string {
  const state = perspectiveState(task, name, now);
  if (state === "submitted") throw new HostResearchError("perspective_done", `${name} 视角已提交，不用再领`);
  if (state === "claimed") {
    const claim = task.perspectiveClaims![name]!;
    throw new HostResearchError("perspective_claimed", `${name} 视角正由 ${claim.host} 认领在做；换一个视角，或等它闲置 30 分钟超时后再领`, {
      holder: claim.host, expires_at: new Date(Date.parse(claim.touchedAt) + CLAIM_IDLE_MS).toISOString(),
    });
  }
  const at = new Date(now).toISOString();
  const token = `pt-${crypto.randomUUID()}`;
  task.perspectiveClaims = { ...task.perspectiveClaims, [name]: { token, host, claimedAt: at, touchedAt: at } };
  return token;
}

/**
 * 这次调用能不能动这个视角：带令牌 → 必须是活令牌（指定了视角就得是那个视角的令牌），并续期；
 * 不带令牌 → 视角被别人的活令牌占着就拒。返回 true = 凭令牌访问（跳过整份任务的持有者检查）。
 */
export function checkPerspectiveAccess(task: HostResearchTask, name: PerspectiveName | undefined, token: string, now = Date.now()): boolean {
  if (token) {
    const entry = Object.entries(task.perspectiveClaims ?? {}).find(([, c]) => c?.token === token);
    if (!entry || !isLive(entry[1]!.touchedAt, now) || (name && entry[0] !== name)) {
      throw new HostResearchError("perspective_token_invalid", "视角令牌无效、已超时或不属于这个视角；重新 claim 再做");
    }
    entry[1]!.touchedAt = new Date(now).toISOString();
    return true;
  }
  const claim = name ? task.perspectiveClaims?.[name] : undefined;
  if (claim && isLive(claim.touchedAt, now)) {
    throw new HostResearchError("perspective_claimed", `${name} 视角正由 ${claim.host} 认领在做；带上它的 perspective_token 才能提交`, { holder: claim.host });
  }
  return false;
}

/** 视角做完：令牌收回，旧的失败记录清掉 */
export function settlePerspective(task: HostResearchTask, name: PerspectiveName): void {
  if (task.perspectiveClaims) delete task.perspectiveClaims[name];
  if (task.perspectiveFailures) delete task.perspectiveFailures[name];
}

export function failPerspective(task: HostResearchTask, name: PerspectiveName, reason: string, host: string, now = Date.now()): void {
  if (task.perspectives[name]) throw new HostResearchError("perspective_done", `${name} 视角已提交，不能再标失败`);
  if (task.perspectiveClaims) delete task.perspectiveClaims[name];
  task.perspectiveFailures = { ...task.perspectiveFailures, [name]: { reason, at: new Date(now).toISOString(), by: host } };
}

const METRIC_LABEL: Record<string, string> = { views: "播放", completion5s: "5秒完播率" };

function personaLines(groups: GroupRow[]): string {
  const lines = groups.filter((g) => g.dimension === "persona" && g.key !== "未标").map((g) => {
    const head = `${g.platform} D+${g.day} ${METRIC_LABEL[g.metric] ?? g.metric}｜${g.key}`;
    return g.stat.status === "ok" ? `${head}：中位 ${g.stat.median}（n=${g.stat.n}）` : `${head}：n=${g.stat.n} 不足 5，只列数 ${g.stat.values.join("、")}`;
  });
  return lines.length ? lines.join("\n") : "暂无按画像的同龄数据，不作依据。";
}

/** 账号数据视角：确定性、不调模型；读失败记成失败视角，不冒充「没有数据」 */
export async function buildAccountData(dataDir: string, now = new Date()): Promise<AccountDataPerspective> {
  const builtAt = now.toISOString();
  try {
    // 简报的稿件枚举会跳过读坏的记录；先严格枚举一遍，坏一条就把这一路记成失败，不冒充「数据齐了」
    await listContentsStrict(dataDir);
    const brief = await buildMeetingBrief(dataDir, now);
    const summary = [
      "## 账号数据（按形式，同平台同龄中位数）", formatSummaryOf(brief.groups),
      "## 账号数据（按画像）", personaLines(brief.groups),
      ...(brief.attention.length ? ["## 数据口径提醒", ...brief.attention.map((a) => `- ${a}`)] : []),
    ].join("\n");
    return { status: "ok", summary, builtAt };
  } catch (err) {
    return { status: "failed", reason: `账号数据读取失败：${err instanceof Error ? err.message : String(err)}`, builtAt };
  }
}

/** 立意阶段：每张卡必须写 why_may_perform（引账号数据视角，或照写「无数据依据」） */
export function readWhyMayPerform(payload: Record<string, unknown>, count: number): string[] {
  const items = Array.isArray(payload.candidates ?? payload.cards) ? (payload.candidates ?? payload.cards) as unknown[] : [];
  const out = items.slice(0, count).map((c) => (c && typeof c === "object" ? String((c as Record<string, unknown>).why_may_perform ?? "").trim() : ""));
  const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    throw new HostResearchError("missing_why_may_perform", `第 ${missing.map((i) => i + 1).join("、")} 张卡缺 why_may_perform：引账号数据视角里的具体数字（带 n），没有就写「无数据依据」`);
  }
  return out;
}

export const WHY_MAY_PERFORM_SCHEMA = {
  type: "string",
  description: "凭什么可能跑得好：只引账号数据视角里的数字（带 n）；没有可用数据就照写「无数据依据」",
};
