/**
 * 引擎健康视图的**纯函数层**（P2 spec §4.3、§5.2）——横幅、状态点、引用者、岗位摘要
 * 全部从 `engine:health` / `settings:get` 的同一份数据派生，前端不另存一份「线路状态」。
 *
 * 三条纪律：
 * 1. **没探过就说没探过**。`probe`/`live` 都是 null = 「未测」，绝不画成「坏」——
 *    把没测过说成坏，用户会去修一条本来好的线。
 * 2. **取最近的那条，不取最坏的那条**。探针 5 分钟前失败、真实调用 1 分钟前成功，
 *    这条线现在是好的；spec §4.3 明写「恢复（探针或真实调用成功）自动消失」，
 *    「取最坏」会让横幅永远挂着。
 * 3. **错误文案原样透出**。后端 `failure-text.ts` 已经是全产品唯一的翻译器，
 *    前端只负责摆位置，不再改写一个字。
 */

export interface ProbeHealth {
  at: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface LiveHealth {
  at: string;
  ok: boolean;
  role: string;
  jobId?: string;
  error?: string;
}

export interface HealthProvider {
  id: string;
  name: string;
  host: string;
  /** null = 没探过（不是「坏」） */
  probe: ProbeHealth | null;
  /** null = 没跑过真实调用（不是「坏」） */
  live: LiveHealth | null;
}

export interface EnginePointer {
  provider: string;
  strong: string;
  fast: string;
}

export interface EngineAssignment {
  provider: string;
  model: string;
}

export interface EngineHealthView {
  configured: boolean;
  providers: HealthProvider[];
  main: EnginePointer | null;
  fallback: EnginePointer | null;
  assignments: Record<string, EngineAssignment | null>;
  warnings: string[];
}

export const ROLE_KEYS = ["writer", "reviewer", "scout", "analytics"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** 与后端 `ENGINE_ROLE_LABELS` 同一套词，前后端说同一句话 */
export const ROLE_LABEL: Record<RoleKey, string> = {
  writer: "写稿专线",
  reviewer: "审稿专线",
  scout: "调研专线",
  analytics: "复盘专线",
};

/** 折叠标题里的短名（「写稿、审稿 → newcli」） */
export const ROLE_SHORT: Record<RoleKey, string> = {
  writer: "写稿",
  reviewer: "审稿",
  scout: "调研",
  analytics: "复盘",
};

/** 「…会失败」里的那个动词 */
export const ROLE_ACTION: Record<RoleKey, string> = {
  writer: "写稿",
  reviewer: "审稿",
  scout: "深调研",
  analytics: "复盘",
};

export const ROLE_NOTE: Record<RoleKey, string> = {
  writer: "生成初稿、改稿、平台适配",
  reviewer: "AI 审稿、去 AI 味复核",
  scout: "雷达筛选、灵感提炼、深调研",
  analytics: "复盘报告、campaign 重排",
};

// ── 状态点 ──────────────────────────────────────────────────────────────────

export type HealthTone = "idle" | "ok" | "bad";

export interface ProviderDot {
  tone: HealthTone;
  text: string;
  /** hover 全文（坏的时候是完整那句话，点上去能看清） */
  title: string;
}

interface LatestRecord {
  at: string;
  ok: boolean;
  ms?: number;
  error?: string;
}

/** 探针与真实调用取**时间靠后**的那条：它才是「此刻已知的状态」 */
export function latestRecord(p: Pick<HealthProvider, "probe" | "live">): LatestRecord | null {
  const probe = p.probe ? { at: p.probe.at, ok: p.probe.ok, ms: p.probe.ms, ...(p.probe.error ? { error: p.probe.error } : {}) } : null;
  const live = p.live ? { at: p.live.at, ok: p.live.ok, ...(p.live.error ? { error: p.live.error } : {}) } : null;
  if (!probe) return live;
  if (!live) return probe;
  // 时间戳并列时取真实调用：它是生产流量的回执，比探针更有说服力
  return new Date(live.at).getTime() >= new Date(probe.at).getTime() ? live : probe;
}

function clip(text: string, max = 40): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 设置页每行端点那一枚点：未测 / 通 · 1.5s / 坏 · 原因 */
export function providerDot(p: Pick<HealthProvider, "probe" | "live">): ProviderDot {
  const last = latestRecord(p);
  if (!last) return { tone: "idle", text: "未测", title: "还没测过这个端点——点「测试」发一次极小调用" };
  if (last.ok) {
    const ms = typeof last.ms === "number" && last.ms > 0 ? ` · ${(last.ms / 1000).toFixed(1)}s` : "";
    return { tone: "ok", text: `通${ms}`, title: `最近一次成功：${last.at}` };
  }
  const reason = last.error ?? "原因未记录";
  return { tone: "bad", text: `坏 · ${clip(reason)}`, title: reason };
}

// ── 引用关系（删除拦截、横幅归因共用同一把尺）────────────────────────────────

export interface EnginePointers {
  main: EnginePointer | null;
  fallback: EnginePointer | null;
  assignments: Record<string, EngineAssignment | null>;
}

/** 谁在用这个端点。删除按钮拿它拒绝，横幅拿它说「哪条线坏了」 */
export function referrersOf(providerId: string, pointers: EnginePointers): string[] {
  const out: string[] = [];
  if (pointers.main?.provider === providerId) out.push("主端点");
  if (pointers.fallback?.provider === providerId) out.push("备用端点");
  for (const role of ROLE_KEYS) {
    if (pointers.assignments?.[role]?.provider === providerId) out.push(ROLE_LABEL[role]);
  }
  return out;
}

/** 被任何指针引用的端点 id（横幅只看这些——没人用的端点坏了不该弹横幅） */
export function referencedProviderIds(pointers: EnginePointers): string[] {
  const ids: string[] = [];
  const push = (id?: string) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  push(pointers.main?.provider);
  push(pointers.fallback?.provider);
  for (const role of ROLE_KEYS) push(pointers.assignments?.[role]?.provider);
  return ids;
}

/** 岗位分配折叠区的标题：不展开也知道现在是什么局面 */
export function assignmentSummary(assignments: Record<string, EngineAssignment | null>): string {
  const groups = new Map<string, string[]>();
  for (const role of ROLE_KEYS) {
    const a = assignments?.[role];
    if (!a) continue;
    const list = groups.get(a.provider) ?? [];
    list.push(ROLE_SHORT[role]);
    groups.set(a.provider, list);
  }
  if (groups.size === 0) return "4 个岗位全部跟随主端点";
  const parts = [...groups.entries()].map(([provider, roles]) => `${roles.join("、")} → ${provider}`);
  const assigned = [...groups.values()].reduce((n, list) => n + list.length, 0);
  return assigned === ROLE_KEYS.length ? parts.join("；") : `${parts.join("；")}；其余跟随主端点`;
}

// ── 顶栏横幅 ────────────────────────────────────────────────────────────────

export function relativeTime(at: string, now: number): string {
  const t = new Date(at).getTime();
  if (!isFinite(t)) return "时间未知";
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 这条端点坏了，会连累哪些动作 */
function affectedActions(providerId: string, pointers: EnginePointers): string[] {
  const actions: string[] = [];
  for (const role of ROLE_KEYS) {
    if (pointers.assignments?.[role]?.provider === providerId) actions.push(ROLE_ACTION[role]);
  }
  if (pointers.main?.provider === providerId) {
    // 主端点顶着对话与所有没单独分配的岗位
    const followers = ROLE_KEYS.filter((r) => !pointers.assignments?.[r]).map((r) => ROLE_ACTION[r]);
    actions.push("对话", ...followers);
  }
  return [...new Set(actions)];
}

function isBad(view: EngineHealthView, providerId: string): boolean {
  const p = view.providers.find((x) => x.id === providerId);
  if (!p) return false;
  const last = latestRecord(p);
  return Boolean(last && !last.ok);
}

function outcomeClause(view: EngineHealthView, providerId: string, actions: string[]): string {
  const act = actions.length ? actions.join("、") : "本次调用";
  const onlyFallback = view.fallback?.provider === providerId && actions.length === 0;
  if (onlyFallback) return "主线还在，但主线一旦失败就没有东西可顶。";
  const fb = view.fallback;
  if (!fb) return `没有备用端点，${act}会失败。`;
  if (fb.provider === providerId || isBad(view, fb.provider)) return `备用 ${fb.provider} 也不通，${act}会失败。`;
  return `下次${act}将由备用 ${fb.provider} 顶上。`;
}

export interface BannerLine {
  providerId: string;
  text: string;
}

/**
 * 顶栏横幅（spec §4.3）：任一**被引用**的端点最近状态为坏就出一行，恢复即消失。
 * 未配置引擎时不出——那是首次开机卡的活，不是横幅的活。
 */
const ROLE_PREFIX_RE = /^(端点|主端点|写稿专线|审稿专线|调研专线|复盘专线)\s+/;
const OUTCOME_TAIL_RE = /[^。]*已中断。\s*$/;

/** 「主端点 dead（host）连不上：…。这次没有备用端点，写稿已中断。」→「dead（host）连不上：…。」 */
export function stripRoleAndOutcome(sentence: string): string {
  return sentence.replace(ROLE_PREFIX_RE, "").replace(OUTCOME_TAIL_RE, "").trim();
}

export function engineBannerLines(view: EngineHealthView | null, now: number): BannerLine[] {
  if (!view?.configured) return [];
  const pointers: EnginePointers = { main: view.main, fallback: view.fallback, assignments: view.assignments ?? {} };
  const lines: BannerLine[] = [];
  for (const id of referencedProviderIds(pointers)) {
    const provider = view.providers.find((p) => p.id === id);
    if (!provider) continue;
    const last = latestRecord(provider);
    if (!last || last.ok) continue;
    const labels = referrersOf(id, pointers);
    const who = labels.length ? labels.join("、") : `端点 ${id}`;
    // 记录里的句子自带「主端点 xxx（host）…。写稿已中断。」；横幅自己点名、自己说后果，
    // 去掉开头的角色词和结尾的「已中断」句，免得读成「主端点：主端点 …已中断。下次由备用顶上」
    const reason = stripRoleAndOutcome(last.error ?? "调用失败，原因未记录");
    const actions = affectedActions(id, pointers);
    lines.push({ providerId: id, text: `${who}：${reason}（${relativeTime(last.at, now)}）${outcomeClause(view, id, actions)}` });
  }
  return lines;
}

// ── 设置页表单（端点表 ↔ 提交体）─────────────────────────────────────────────

/** settings:get 回的一条端点：只有掩码与「配没配」，永不回 key 原文 */
export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string | null;
  models: string[];
  apiKeySet: boolean;
  apiKeyMasked?: string | null;
}

/** 表单里的一行。`key` 只活在浏览器里（React key）；`id` 是落盘的那个，建后不改 */
export interface ProviderRow {
  key: string;
  id: string;
  name: string;
  baseUrl: string;
  /** 逗号分隔的原文——用户正在敲的样子，不提前规整 */
  models: string;
  protocol: string;
  apiKey: string;
  apiKeySet: boolean;
  /** 服务端已存的模型清单：「测试」只能测已保存的那些 */
  savedModels: string[];
}

export function toProviderRows(list: ProviderView[] | undefined): ProviderRow[] {
  return (list ?? []).map((p) => ({
    key: `saved-${p.id}`,
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    models: p.models.join(", "),
    protocol: p.protocol ?? "",
    apiKey: "",
    apiKeySet: p.apiKeySet,
    savedModels: p.models,
  }));
}

export function splitModels(text: string): string[] {
  return text.split(/[,，\s]+/).filter(Boolean);
}

/** 端点表 → `settings:set` 的 providers 整数组（空 apiKey = 保留已存的 key） */
export function providerPayload(rows: ProviderRow[]): Array<Record<string, unknown>> {
  return rows.map((p) => ({
    id: p.id,
    name: p.name.trim(),
    baseUrl: p.baseUrl.trim(),
    models: splitModels(p.models),
    ...(p.protocol ? { protocol: p.protocol } : {}),
    ...(p.apiKey.trim() ? { apiKey: p.apiKey.trim() } : {}),
  }));
}

/** 端点表里这条的显示名（横幅与拒删文案共用；没有就退回 id） */
export function providerLabel(rows: Array<{ id: string; name: string }>, id: string): string {
  const hit = rows.find((r) => r.id === id);
  return hit?.name?.trim() || id;
}

// ── 兜底留痕（稿卡 / 调研任务卡的「备用顶上」徽章）──────────────────────────

/** `Content.usedFallback` / `ResearchJob.usedFallback` 的形状（后端 P2a-2 落的字段） */
export interface UsedFallback {
  role: string;
  from: string;
  to: string;
  error: string;
}

/** 徽章的 hover 全文：主线为什么失败、这次谁顶的。兜底发生过就必须说得出原因 */
export function fallbackTitle(uf: UsedFallback): string {
  const label = ROLE_LABEL[uf.role as RoleKey] ?? "主端点";
  return `${label}主线 ${uf.from} 失败：${uf.error}\n这次由备用 ${uf.to} 顶完。`;
}
