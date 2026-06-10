/**
 * Progressive Profiling — infer creator profile from user behavior.
 *
 * Level 0: Zero config, use defaults
 * Level 1: Auto-infer industry/platform from first 1-2 requests
 * Level 2: After 3-5 uses, suggest style calibration
 * Level 3: Continuous learning via diff tracker
 */
import { loadProfile, updateProfile, type CreatorProfile } from "./creator-profile.js";

export type ProfileLevel = 0 | 1 | 2 | 3;

export interface InferredProfile {
  industry?: string;
  platform?: string;
  audience?: string;
}

/**
 * Determine the current profiling level based on profile completeness.
 */
export function getProfileLevel(profile: CreatorProfile | null): ProfileLevel {
  if (!profile || !profile.industry) return 0;
  if (!profile.styleCalibrated && profile.platforms.length > 0) return 1;
  if (profile.styleCalibrated && profile.writingRules.length === 0) return 2;
  return 3;
}

/**
 * Infer profile fields from a user's content request.
 * Called automatically when user triggers write/research tools.
 */
export function inferFromRequest(params: {
  keyword?: string;
  platform?: string;
  title?: string;
  body?: string;
}): InferredProfile {
  const inferred: InferredProfile = {};

  // Infer platform
  if (params.platform) {
    inferred.platform = params.platform;
  }

  // Infer industry from keyword/title
  const text = [params.keyword, params.title, params.body].filter(Boolean).join(" ");
  const industryPatterns: Record<string, RegExp> = {
    "美妆护肤": /美妆|护肤|化妆|口红|粉底|面膜|精华|防晒|卸妆/,
    "科技数码": /科技|数码|手机|电脑|AI|编程|开发|软件|硬件|芯片/,
    "职场成长": /职场|工作|面试|简历|升职|加薪|跳槽|管理|领导力/,
    "育儿教育": /育儿|宝宝|孩子|教育|幼儿|小学|辅导|亲子/,
    "美食烹饪": /美食|做饭|烹饪|食谱|菜谱|烘焙|甜品|餐厅/,
    "健身运动": /健身|运动|减肥|瑜伽|跑步|增肌|减脂|体重/,
    "旅行探店": /旅行|旅游|探店|打卡|酒店|民宿|攻略|景点/,
    "穿搭时尚": /穿搭|时尚|搭配|衣服|鞋子|包包|潮流|OOTD/i,
    "家居生活": /家居|装修|收纳|家电|软装|好物|生活方式/,
    "金融理财": /理财|投资|基金|股票|保险|存钱|财务自由|副业/,
    "心理情感": /心理|情感|恋爱|婚姻|焦虑|自律|成长|治愈/,
    "知识科普": /科普|知识|学习|读书|历史|文化|冷知识/,
  };

  for (const [industry, pattern] of Object.entries(industryPatterns)) {
    if (pattern.test(text)) {
      inferred.industry = industry;
      break;
    }
  }

  return inferred;
}

/**
 * Auto-update profile with inferred data. Only fills empty fields, never overwrites.
 * Returns what was updated (for the AI to mention casually).
 */
export async function autoEnrichProfile(
  inferred: InferredProfile,
  dataDir?: string,
): Promise<{ updated: string[]; level: ProfileLevel }> {
  const profile = await loadProfile(dataDir);
  if (!profile) {
    return { updated: [], level: 0 };
  }

  const updates: Partial<CreatorProfile> = {};
  const updated: string[] = [];

  if (inferred.industry && !profile.industry) {
    updates.industry = inferred.industry;
    updated.push("industry");
  }

  if (inferred.platform && profile.platforms.length === 0) {
    updates.platforms = [inferred.platform];
    updated.push("platforms");
  }

  if (updated.length > 0) {
    await updateProfile(updates, dataDir);
  }

  const refreshed = await loadProfile(dataDir);
  return { updated, level: getProfileLevel(refreshed) };
}

/**
 * Generate a contextual nudge message based on profile level and usage count.
 * Returns null if no nudge is needed.
 */
export function getNudge(profile: CreatorProfile | null, contentCount: number): string | null {
  const level = getProfileLevel(profile);

  if (level === 0 && contentCount >= 1) {
    return "你主要做哪个领域的内容？告诉我的话，下次写得更贴合你。";
  }

  if (level === 1 && contentCount >= 3 && !profile?.styleCalibrated) {
    return "你已经写了几篇内容了，要不要花 2 分钟做个风格校准？这样我写出来的东西更像你的风格。说「风格校准」就行。";
  }

  return null;
}
