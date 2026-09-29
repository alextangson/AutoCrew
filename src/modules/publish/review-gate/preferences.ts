/**
 * 发布偏好（发布前把关 spec §3、E6）：封面上传槽覆盖 `coverRatios` 与自由文本 `publishRules`。
 *
 * - agent 只能提议（propose_preference → 待确认）；写进档案只有两条路：创始人在网页点「确认」，
 *   或在设置页直接改——两者都走浏览器会话路由（desktop/publish-prefs-route.ts），MCP / /api/invoke 到不了。
 * - 偏好表版本 = coverRatios + publishRules 的哈希，进检查指纹：偏好一改，旧的语义结果不再复用。
 */
import crypto from "node:crypto";
import { loadProfile, mutateProfile, type PreferenceProposal, type PublishRule } from "../../profile/creator-profile.js";
import { ratioValue } from "../../cover/platform-ratios.js";
import { normalizePlatform } from "./platforms.js";

export interface PublishPrefs { coverRatios: Record<string, string[]>; publishRules: PublishRule[] }

export async function readPublishPrefs(dataDir?: string): Promise<PublishPrefs> {
  const p = await loadProfile(dataDir);
  return { coverRatios: p?.coverRatios ?? {}, publishRules: p?.publishRules ?? [] };
}

export function prefsVersion(prefs: PublishPrefs): string {
  const sorted = Object.fromEntries(Object.entries(prefs.coverRatios).sort(([a], [b]) => a.localeCompare(b)));
  return crypto.createHash("sha256").update(JSON.stringify({ c: sorted, r: prefs.publishRules.map((r) => [r.id, r.text, r.platform ?? null]) })).digest("hex").slice(0, 16);
}

/** 比例列表：数组或 "3:4,4:3" 字符串（宿主可能把数组传成字符串）；有一个认不出就整体拒 */
export function parseRatios(raw: unknown): string[] | null {
  let list: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("[")) { try { list = JSON.parse(t); } catch { return null; } } else list = t.split(/[,，、\s]+/).filter(Boolean);
  }
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = list.map((r) => (typeof r === "string" ? r.trim() : ""));
  return out.every((r) => ratioValue(r) !== null) ? [...new Set(out)] : null;
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

export type ProposeResult = { ok: true; proposal: PreferenceProposal; duplicate: boolean } | { ok: false; code: string; error: string };

export async function proposePreference(args: Record<string, unknown>, host: string, dataDir?: string): Promise<ProposeResult> {
  const kind = args.kind;
  const quote = typeof args.founder_quote === "string" ? args.founder_quote.trim() : "";
  if (kind !== "cover_ratio" && kind !== "rule") return { ok: false, code: "bad_kind", error: "kind 只能是 cover_ratio 或 rule" };
  if (!quote) return { ok: false, code: "quote_required", error: "founder_quote 必填：创始人这次说的原话，逐字" };
  const platformRaw = typeof args.platform === "string" && args.platform.trim() ? args.platform : undefined;
  const platform = platformRaw ? normalizePlatform(platformRaw) : undefined;
  if (platformRaw && !platform) return { ok: false, code: "bad_platform", error: `认不出平台：${platformRaw}` };
  let value: string[] | string;
  if (kind === "cover_ratio") {
    if (!platform) return { ok: false, code: "platform_required", error: "cover_ratio 要带 platform" };
    const ratios = parseRatios(args.value);
    if (!ratios) return { ok: false, code: "bad_value", error: "value 要是比例列表，如 [\"3:4\",\"4:3\"]" };
    value = ratios;
  } else {
    const text = typeof args.value === "string" ? args.value.trim() : "";
    if (!text) return { ok: false, code: "bad_value", error: "rule 的 value 是规则原文（一句话）" };
    value = text;
  }
  const { result } = await mutateProfile((profile) => {
    const list = (profile.preferenceProposals ??= []);
    const same = list.find((p) => p.status === "pending" && p.kind === kind && p.platform === platform && JSON.stringify(p.value) === JSON.stringify(value));
    if (same) return { proposal: same, duplicate: true };
    const proposal: PreferenceProposal = { id: newId("pref"), kind, ...(platform ? { platform } : {}), value, founder_quote: quote, host, at: new Date().toISOString(), status: "pending" };
    list.push(proposal);
    return { proposal, duplicate: false };
  }, dataDir);
  return { ok: true, ...result };
}

export async function pendingProposals(dataDir?: string): Promise<PreferenceProposal[]> {
  return ((await loadProfile(dataDir))?.preferenceProposals ?? []).filter((p) => p.status === "pending");
}

/** 创始人在网页点确认 / 不要；已处理过的再点报冲突，不重复写 */
export async function decideProposal(id: string, decision: "confirm" | "dismiss", dataDir?: string): Promise<{ ok: true; proposal: PreferenceProposal } | { ok: false; error: string }> {
  const { result } = await mutateProfile((profile) => {
    const p = profile.preferenceProposals?.find((x) => x.id === id);
    if (!p) return { ok: false as const, error: "提议不存在" };
    if (p.status !== "pending") return { ok: false as const, error: `这条提议已经${p.status === "confirmed" ? "确认" : "放弃"}过了` };
    p.status = decision === "confirm" ? "confirmed" : "dismissed";
    p.decided_at = new Date().toISOString();
    if (decision === "confirm" && p.kind === "cover_ratio" && p.platform) profile.coverRatios = { ...(profile.coverRatios ?? {}), [p.platform]: p.value as string[] };
    if (decision === "confirm" && p.kind === "rule") (profile.publishRules ??= []).push({ id: newId("rule"), text: p.value as string, ...(p.platform ? { platform: p.platform } : {}), added_at: p.decided_at });
    return { ok: true as const, proposal: p };
  }, dataDir);
  return result;
}

/** 设置页直接改（创始人本人）：比例空数组 = 删掉覆盖，回默认表 */
export async function setCoverRatios(platform: string, raw: unknown, dataDir?: string): Promise<{ ok: true; prefs: PublishPrefs } | { ok: false; error: string }> {
  const p = normalizePlatform(platform);
  if (!p) return { ok: false, error: `认不出平台：${platform}` };
  const clear = Array.isArray(raw) && raw.length === 0;
  const ratios = clear ? [] : parseRatios(raw);
  if (!ratios) return { ok: false, error: "比例要写成 3:4、4:3 这样，逗号分隔" };
  await mutateProfile((profile) => {
    const next = { ...(profile.coverRatios ?? {}) };
    if (clear) delete next[p]; else next[p] = ratios;
    profile.coverRatios = next;
  }, dataDir);
  return { ok: true, prefs: await readPublishPrefs(dataDir) };
}

export async function addPublishRule(text: string, platform: string | undefined, dataDir?: string): Promise<{ ok: true; prefs: PublishPrefs } | { ok: false; error: string }> {
  const t = text.trim();
  if (!t) return { ok: false, error: "规则不能是空的" };
  const p = platform ? normalizePlatform(platform) : undefined;
  if (platform && !p) return { ok: false, error: `认不出平台：${platform}` };
  await mutateProfile((profile) => { (profile.publishRules ??= []).push({ id: newId("rule"), text: t, ...(p ? { platform: p } : {}), added_at: new Date().toISOString() }); }, dataDir);
  return { ok: true, prefs: await readPublishPrefs(dataDir) };
}

export async function removePublishRule(id: string, dataDir?: string): Promise<{ ok: true; prefs: PublishPrefs } | { ok: false; error: string }> {
  const { result } = await mutateProfile((profile) => {
    const before = profile.publishRules?.length ?? 0;
    profile.publishRules = (profile.publishRules ?? []).filter((r) => r.id !== id);
    return before !== profile.publishRules.length;
  }, dataDir);
  return result ? { ok: true, prefs: await readPublishPrefs(dataDir) } : { ok: false, error: "规则不存在" };
}
