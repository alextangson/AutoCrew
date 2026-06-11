/**
 * Day-1 onboarding 状态（PRD §7.3 / §7.1 热启动）。
 * onboarded 判据 = profile 存在且 industry 非空。永不阻断：跳过路径
 * 直接以默认值初始化（知识口播 / 抖音），之后随时在对话或设置里补。
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
  const platforms = platformsRaw.length > 0 ? platformsRaw : ["douyin"];
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    await initProfile(dataDir);
    const profile = await updateProfile({ industry, platforms }, dataDir);
    return { ok: true, data: { onboarded: true, industry: profile.industry, platforms: profile.platforms } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
