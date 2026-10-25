/**
 * 缺线路时的第三方中转推荐（spec 2026-10-25-tokencamel-touchpoint）——**全产品唯一**放推荐文案与触点判定的地方。
 * 后端、引擎、提示词、写稿包、发布包、MCP 工具、templates/、skills/ 都不引用本文件（grep 测试守，spec §2.3）。
 *
 * 两个触点的全部条件只在 `shouldOffer` 里算：
 *   A `onboarding`：引擎「未配置」（端点表空，或主指针不成立）；
 *   B `fallback`：被引用的某条线 24 小时内出了「换条线能救」的失败，且没配备用、没有一条线已经是它。
 * 判断只读结构化字段（kind / status / at），不解析给人看的那句话。
 */
import type { EngineHealthView, HealthProvider } from "./engine-lib";

export type OfferTouchpoint = "onboarding" | "fallback";

export interface OfferPresetView {
  name: string;
  baseUrl: string;
  host: string;
  links: { keys: string; pricing: string; privacy: string };
  suggest: { strong: string[]; fast: string[] };
}

/** `settings:get` 里的 offer 块 */
export interface OfferState {
  ready: Record<OfferTouchpoint, boolean>;
  enabled: boolean;
  dismissed: Partial<Record<OfferTouchpoint, string>>;
  preset: OfferPresetView | null;
}

// TODO(D5): founder to finalize wording
export const OFFER_COPY = {
  name: "骆驼词元 TokenCamel",
  what: "一把 Key 接多家模型，按量付费。",
  dataFlow: "用它时，请求会经过 TokenCamel 的服务器（香港）再到各家模型厂商。",
  leadOnboarding: "还没有能用的模型线路。也可以用：",
  leadFallback: "这条线连不上时，可以加一条备用线路。也可以用：",
  pricing: "价格与购买",
  privacy: "隐私政策",
  attachMain: "接上",
  attachFallback: "接上当备用",
  dismiss: "不用了",
  settingsLink: "或用 TokenCamel",
  switchLabel: "第三方服务推荐",
  getKey: "去拿 Key",
  listModels: "读取可用模型",
  save: "保存并试一下",
  retryProbe: "再试一次",
  fallbackNotice: "保存后，主线连不上或限流时，这次请求（含稿件内容）会自动改由 TokenCamel 处理，并在红点里留痕。",
} as const;

/** 时效窗口（spec D2）：超过这么久的失败不再代表「此刻缺线路」 */
export const FALLBACK_WINDOW_MS = 24 * 60 * 60_000;

/** 与 router 的 isRetryable 同一口径：备用只在这些失败上接手，推荐它才不是误导 */
const RETRYABLE_KINDS = new Set(["connect", "interrupted", "timeout", "rate_limit"]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);

export function isRescuableFailure(f: { kind?: string; status?: number }): boolean {
  if (f.kind && RETRYABLE_KINDS.has(f.kind)) return true;
  return f.kind === "upstream" && f.status !== undefined && RETRYABLE_STATUS.has(f.status);
}

/** 探针与真实调用取时间靠后的那条（并列取真实调用，与 latestRecord 同口径），保留 kind/status */
function newestRecord(p: Pick<HealthProvider, "probe" | "live">) {
  const list = [p.live, p.probe].filter((r): r is NonNullable<typeof r> => Boolean(r) && Number.isFinite(Date.parse(r!.at)));
  return list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}

function referencedIds(view: EngineHealthView): string[] {
  const ids = view.main ? [view.main.provider] : [];
  for (const a of Object.values(view.assignments ?? {})) if (a) ids.push(a.provider);
  return [...new Set(ids)];
}

function fallbackEligible(view: EngineHealthView, preset: OfferPresetView, now: number): boolean {
  if (view.fallback) return false; // E19：已有备用
  const byId = new Map(view.providers.map((p) => [p.id, p] as const));
  const refs = referencedIds(view).map((id) => byId.get(id)).filter((p): p is HealthProvider => Boolean(p));
  if (refs.some((p) => p.host === preset.host)) return false; // E18：已经在用它
  return refs.some((p) => {
    const last = newestRecord(p);
    if (!last || last.ok) return false;
    const age = now - Date.parse(last.at);
    return age >= 0 && age <= FALLBACK_WINDOW_MS && isRescuableFailure(last);
  });
}

export interface OfferInput {
  offer: OfferState | null | undefined;
  /** 触点 A：settings:get 的 configured */
  configured?: boolean;
  /** 触点 B：engine:health 视图 */
  health?: EngineHealthView | null;
}

export function shouldOffer(touchpoint: OfferTouchpoint, state: OfferInput, now: number): boolean {
  const offer = state.offer;
  if (!offer?.preset || !offer.ready?.[touchpoint]) return false; // E1 / E4
  if (!offer.enabled) return false; // E2
  if (offer.dismissed?.[touchpoint]) return false; // E3
  if (touchpoint === "onboarding") return state.configured === false;
  return Boolean(state.health) && fallbackEligible(state.health!, offer.preset, now);
}

/** 预选：suggest 里第一个出现在实时列表里的；都不在就不预选（E12） */
export function preselect(suggest: string[], models: string[]): string {
  return suggest.find((m) => models.includes(m)) ?? "";
}
