/**
 * Day-1 onboarding 状态（PRD §7.3 / §7.1 热启动）。
 * onboarded 判据 = profile 存在且 industry 非空。永不阻断：跳过路径
 * 直接以默认值初始化（默认公众号席位），之后随时在对话或设置里补。
 */
import { loadProfile, initProfile, updateProfile } from "../modules/profile/creator-profile.js";

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
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function completeOnboardingInit(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const industry =
    typeof payload.industry === "string" && payload.industry.trim() ? payload.industry.trim() : "知识口播";
  const platformsRaw = Array.isArray(payload.platforms)
    ? (payload.platforms as unknown[]).filter((p): p is string => typeof p === "string" && p.trim() !== "")
    : [];
  const platforms = platformsRaw.length > 0 ? platformsRaw : ["wechat_mp"]; // v4 P0 = 公众号
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    await initProfile(dataDir);
    const profile = await updateProfile({ industry, platforms }, dataDir);
    return { ok: true, data: { onboarded: true, industry: profile.industry, platforms: profile.platforms } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
