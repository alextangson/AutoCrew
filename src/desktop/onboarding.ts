/**
 * Day-1 onboarding 状态（PRD §7.3 / §7.1 热启动）+ 引导「你是谁」（onboarding-connect §7.2-4）。
 * onboarded 判据 = profile 存在且 industry 非空。永不阻断：跳过 → 记下 personaSkippedAt，
 * 看板留「补全画像」提醒（O18），写稿照常。
 */
import { loadProfile, initProfile, updateProfile, type CreatorProfile } from "../modules/profile/creator-profile.js";
import { legacyTwitterPrompt } from "../modules/profile/platform-lines.js";

const MAX_REFERENCE_WORKS = 2;

/** 画像四问都答了吗：做什么的 / 发哪些平台 / 给谁看 / 想要的口吻 */
export function personaComplete(profile: CreatorProfile | null): boolean {
  return Boolean(profile && profile.industry && profile.platforms.length && profile.audiencePersona?.core?.name && profile.expressionPersona);
}

export async function getOnboardingStatus(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const profile = await loadProfile((payload._dataDir as string) || undefined);
    return {
      ok: true,
      data: {
        onboarded: Boolean(profile && profile.industry),
        styleCalibrated: profile?.styleCalibrated ?? false,
        industry: profile?.industry || null,
        // 雷达粗筛关键词(校准中心可编辑,空数组=从定位派生)——首屏要回显用户填过的词
        focusKeywords: profile?.focusKeywords ?? [],
        // 用户席位（IA v4.2:平台全集是能力目录,platforms 是用户勾选的席位）
        platforms: profile?.platforms ?? [],
        // O18：看板「补全画像」提醒的依据
        personaComplete: personaComplete(profile),
        personaSkipped: Boolean(profile?.personaSkippedAt),
        // spec §9.3：只勾了旧 twitter、没勾 X / YouTube → 看板提示明确选一次（关掉只记在这台浏览器）
        legacyTwitterPrompt: legacyTwitterPrompt(profile),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function referenceWorks(raw: unknown): string[] | { error: string } {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\s+/) : null;
  if (!list) return { error: "旧作链接要是一组网址" };
  const urls = list.map(text).filter((u): u is string => Boolean(u));
  if (urls.length > MAX_REFERENCE_WORKS) return { error: `旧作链接最多 ${MAX_REFERENCE_WORKS} 条` };
  const bad = urls.find((u) => !/^https?:\/\/\S+$/i.test(u));
  return bad ? { error: `这不是网址：${bad}` } : urls;
}

/** 把引导里的回答整理成档案字段；给谁看只在还没有受众画像时落成提案态（不覆盖校准过的） */
function personaUpdates(payload: Record<string, unknown>, existing: CreatorProfile): Partial<CreatorProfile> | { error: string } {
  const works = referenceWorks(payload.referenceWorks);
  if (!Array.isArray(works)) return works;
  const platforms = Array.isArray(payload.platforms)
    ? (payload.platforms as unknown[]).map(text).filter((p): p is string => Boolean(p)) : [];
  const audience = text(payload.audience);
  const voice = text(payload.voice);
  return {
    industry: text(payload.industry) ?? (existing.industry || "知识口播"),
    platforms: platforms.length ? platforms : existing.platforms.length ? existing.platforms : ["wechat_mp"], // v4 P0 = 公众号
    ...(audience && !existing.audiencePersona ? { audiencePersona: { core: { name: audience } } } : {}),
    ...(voice ? { expressionPersona: voice } : {}),
    ...(works.length ? { referenceWorks: works } : {}),
  };
}

export async function completeOnboardingInit(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const existing = await initProfile(dataDir);
    if (payload.skipped === true) {
      // O18：跳过不填假默认值，只记下跳过；看板提醒补全
      const profile = personaComplete(existing) ? existing : await updateProfile({ personaSkippedAt: new Date().toISOString() }, dataDir);
      return { ok: true, data: { onboarded: Boolean(profile.industry), skipped: true, personaComplete: personaComplete(profile) } };
    }
    const updates = personaUpdates(payload, existing);
    if ("error" in updates) return { ok: false, error: updates.error };
    let profile = await updateProfile(updates, dataDir);
    if (personaComplete(profile) && profile.personaSkippedAt) profile = await updateProfile({ personaSkippedAt: undefined }, dataDir);
    return { ok: true, data: { onboarded: true, industry: profile.industry, platforms: profile.platforms, personaComplete: personaComplete(profile),
      ...(text(payload.audience) && profile.audiencePersona?.core?.name !== text(payload.audience) ? { note: "已有受众画像，没有覆盖；要改去 校准 里改" } : {}) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
