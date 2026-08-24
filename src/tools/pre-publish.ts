/**
 * autocrew_pre_publish tool — Pre-publish checklist gate.
 *
 * Runs 6 checks before allowing content to be published:
 * 1. Content review passed
 * 2. Cover review passed (all video platforms)
 * 3. Hashtags exist where the platform uses them
 * 4. Title within platform length range
 * 5. Platform is set
 * 6. Body length within platform range (min, and max where the platform caps copy)
 */
import { Type } from "@sinclair/typebox";
import {
  getContent,
  getCoverReview,
  transitionStatus,
  stageBlockReason,
  normalizeLegacyStatus,
  CONTENT_STATUS_LABEL,
} from "../storage/local-store.js";
import { executeReview } from "./review.js";
import { getPlatformRules } from "../modules/writing/title-hashtag.js";

// --- Types ---

export interface CheckItem {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  fix?: string;
}

export type PrePublishResult = {
  ok: boolean;
  contentId: string;
  platform: string;
  checks: CheckItem[];
  allPassed: boolean;
  passCount: number;
  failCount: number;
  summary: string;
}

// --- Platform body length minimums ---

const PLATFORM_MIN_BODY: Record<string, number> = {
  xiaohongshu: 200,
  xhs: 200,
  douyin: 100,
  wechat_mp: 800,
  wechat_video: 100,
  bilibili: 200,
};

/** 发布文案上限（创始人裁定：短文案平台 ≤1000）。douyin 不设——body 是口播脚本，发布文案在 videoKit 里另有 ≤300 约束 */
const PLATFORM_MAX_BODY: Record<string, number> = {
  xiaohongshu: 1000,
  xhs: 1000,
  wechat_video: 800,
  bilibili: 2000,
  wechat_mp: 3000,
};

// --- Platforms that require cover review ---

const COVER_REQUIRED_PLATFORMS = new Set(["xiaohongshu", "xhs", "douyin", "wechat_video", "bilibili"]);

// --- Schema ---

export const prePublishSchema = Type.Object({
  action: Type.Unsafe<"check">({
    type: "string",
    enum: ["check"],
    description: "Action. 'check' runs the full pre-publish checklist.",
  }),
  content_id: Type.String({ description: "AutoCrew content id to check." }),
});

/** 已经在发布轨上（含已发/归档）：自动流转到此为止，重跑预检不许把已发布的稿倒拨回待发布 */
const ON_PUBLISH_TRACK = new Set(["publish_ready", "publishing", "published", "archived"]);

/**
 * 真正推进到「待发布」。返回 null = 进去了；返回一句话 = 拦下的原因。
 * 写盘失败照旧向上 throw 到工具错误边界——吞掉等于报了「可以发布」但状态没落盘。
 */
async function runAutoTransition(contentId: string, dataDir?: string): Promise<string | null> {
  const moved = await transitionStatus(contentId, "publish_ready", {}, dataDir);
  if (moved.ok) return null;
  if (moved.blocked) return moved.error ?? "阶段门拒绝";
  // 形状不对（比如稿子还在「草稿就绪」）：状态机的英文原文对创始人没意义，换人话
  const content = await getContent(contentId, dataDir);
  const label = content ? CONTENT_STATUS_LABEL[normalizeLegacyStatus(content.status)] : "当前状态";
  return `稿件还在「${label}」，先把前面的阶段走完才谈发布`;
}

// --- Execute ---

export async function executePrePublish(params: Record<string, unknown>): Promise<PrePublishResult | { ok: false; error: string }> {
  const contentId = params.content_id as string;
  const dataDir = (params._dataDir as string) || undefined;

  if (!contentId) return { ok: false, error: "content_id is required" };

  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `Content ${contentId} not found` };

  const platform = content.platform || "";
  const checks: CheckItem[] = [];

  // --- Check 1: Content review ---
  try {
    const reviewResult = await executeReview({
      action: "full_review",
      content_id: contentId,
      platform,
      _dataDir: dataDir,
    }) as any;

    if (reviewResult.passed) {
      const score = reviewResult.qualityScore?.total ?? "?";
      checks.push({ name: "内容审核", status: "pass", detail: `通过 (质量 ${score}/100)` });
    } else {
      // 报出具体拦路项——只说「敏感词 ✗ 1 个」用户不知道是哪个词、改哪里,发布就成死胡同。
      const hits = (reviewResult.sensitiveWords?.hits ?? []) as Array<{ word: string; suggestion?: string }>;
      const aiChanges = (reviewResult.aiCheck?.changes ?? []) as string[];
      const parts: string[] = [];
      if (hits.length > 0) {
        parts.push(`敏感词:${hits.map((h) => `「${h.word}」${h.suggestion ? "" : "(无自动替换,需手动改)"}`).join("、")}`);
      }
      if (aiChanges.length > 0) parts.push(`AI 痕迹:${aiChanges.join("、")}`);
      const manual = hits.some((h) => !h.suggestion);
      checks.push({
        name: "内容审核",
        status: "fail",
        detail: parts.length > 0 ? parts.join("；") : reviewResult.summary || "未通过",
        fix: manual
          ? "无自动替换的敏感词请在编辑器里手动换词;其余可运行 autocrew_review action='auto_fix'"
          : "运行 autocrew_review action='auto_fix' 自动修复",
      });
    }
  } catch {
    checks.push({ name: "内容审核", status: "fail", detail: "审核执行出错", fix: "手动运行 autocrew_review" });
  }

  // --- Check 2: Cover review (all video platforms) ---
  if (COVER_REQUIRED_PLATFORMS.has(platform)) {
    const coverReview = await getCoverReview(contentId, dataDir);
    if (coverReview && coverReview.status === "approved" && coverReview.approvedLabel) {
      checks.push({ name: "封面审核", status: "pass", detail: `已选定 ${coverReview.approvedLabel.toUpperCase()} 方案` });
    } else if (coverReview && coverReview.status === "publish_ready" && coverReview.approvedLabel) {
      checks.push({ name: "封面审核", status: "pass", detail: `已选定 ${coverReview.approvedLabel.toUpperCase()} 方案` });
    } else {
      checks.push({
        name: "封面审核",
        status: "fail",
        detail: coverReview ? `状态: ${coverReview.status}` : "未完成",
        fix: "运行 autocrew_cover_review action='create_candidates' 创建候选",
      });
    }
  } else {
    checks.push({ name: "封面审核", status: "skip", detail: `${platform || "未知"} 平台无需封面审核` });
  }

  // --- Check 3: Hashtags ---
  const hashtags = content.hashtags || [];
  if (platform === "wechat_mp") {
    checks.push({ name: "Hashtags", status: "skip", detail: "公众号文章无需话题标签" });
  } else if (hashtags.length >= 1) {
    checks.push({ name: "Hashtags", status: "pass", detail: `${hashtags.length} 个标签` });
  } else {
    checks.push({
      name: "Hashtags",
      status: "fail",
      detail: "无标签",
      fix: "通过 autocrew_rewrite 生成标题和标签，或手动 update hashtags",
    });
  }

  // --- Check 4: Title length ---
  const title = content.title || "";
  const rules = getPlatformRules(platform);
  if (!title) {
    checks.push({ name: "标题规范", status: "fail", detail: "无标题", fix: "设置标题" });
  } else if (rules) {
    const [minLen, maxLen] = rules.titleLengthRange;
    const maxAbsolute = rules.maxTitleLength;
    if (title.length > maxAbsolute) {
      checks.push({
        name: "标题规范",
        status: "warn",
        detail: `「${title}」(${title.length}字，超出 ${maxAbsolute} 上限)`,
        fix: "通过 autocrew_rewrite 生成更短的标题变体",
      });
    } else if (title.length < minLen) {
      checks.push({
        name: "标题规范",
        status: "warn",
        detail: `「${title}」(${title.length}字，低于建议 ${minLen} 下限)`,
      });
    } else {
      checks.push({
        name: "标题规范",
        status: "pass",
        detail: `「${title}」(${title.length}字，符合 ${minLen}-${maxLen} 范围)`,
      });
    }
  } else {
    // No rules for this platform, just check title exists
    checks.push({ name: "标题规范", status: "pass", detail: `「${title}」(${title.length}字)` });
  }

  // --- Check 5: Platform set ---
  const supportedPlatforms = ["xiaohongshu", "xhs", "douyin", "wechat_mp", "wechat_video", "bilibili"];
  if (platform && supportedPlatforms.includes(platform)) {
    checks.push({ name: "平台设置", status: "pass", detail: platform });
  } else if (platform) {
    checks.push({ name: "平台设置", status: "warn", detail: `${platform} (非标准平台)` });
  } else {
    checks.push({ name: "平台设置", status: "fail", detail: "未指定平台", fix: "通过 autocrew_content update 设置 platform" });
  }

  // --- Check 6: Body length ---
  const bodyLen = (content.body || "").length;
  const minBody = PLATFORM_MIN_BODY[platform] || 100;
  const maxBody = PLATFORM_MAX_BODY[platform];
  if (bodyLen < minBody) {
    checks.push({
      name: "正文字数",
      status: "fail",
      detail: `${bodyLen} 字 (不足 ${minBody})`,
      fix: "扩充正文，增加案例或数据",
    });
  } else if (maxBody !== undefined && bodyLen > maxBody) {
    checks.push({
      name: "正文字数",
      status: "fail",
      detail: `${bodyLen} 字 (超出 ${maxBody} 上限)`,
      fix: "编辑器里选段用「缩写」压缩，或 autocrew_rewrite 精简正文",
    });
  } else {
    checks.push({
      name: "正文字数",
      status: "pass",
      detail: `${bodyLen} 字 (≥${minBody}${maxBody !== undefined ? `，≤${maxBody}` : ""})`,
    });
  }

  // --- Check 7: 阶段门（阶段制 spec §1.2/§4 #1） ---
  // 六项全过之后才谈流转。**预检不许绕过阶段门**：视频稿卡在剪辑阶段时，
  // 从前这里的 transitionStatus 失败被整个忽略，结果照报「全部通过，可以发布」——
  // 状态没动，人却以为可以发了。现在门拦下就明说卡在哪、为什么。
  //
  // `_readOnly`（内部参数，模型输入到不了这里）：对话面的 pre_publish_check 是纯查询，
  // 不许替用户跨过「待发布」这条人审关卡（设计 §总原则：人审关卡保留人手点击）——
  // 但门的判定照跑照报，只是不写盘。
  const current = normalizeLegacyStatus(content.status);
  if (checks.every((c) => c.status !== "fail") && !ON_PUBLISH_TRACK.has(current)) {
    const blocked = params._readOnly === true
      ? await stageBlockReason(content, "publish_ready", dataDir)
      : await runAutoTransition(contentId, dataDir);
    if (blocked) {
      checks.push({
        name: "阶段门",
        status: "fail",
        detail: `卡在阶段门：${blocked}`,
        fix: "回稿件顶栏用「推进」走完当前阶段，再回来跑发布前检查",
      });
    }
  }

  // --- Aggregate ---
  const passCount = checks.filter((c) => c.status === "pass" || c.status === "skip").length;
  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const allPassed = failCount === 0;

  // Build summary
  const statusIcon: Record<string, string> = { pass: "✅", fail: "❌", warn: "⚠️", skip: "⏭️" };
  const lines: string[] = [`📋 发布前检查 — ${contentId} (${platform || "未知平台"})`, ""];
  for (const c of checks) {
    lines.push(`${statusIcon[c.status]} ${c.name}：${c.detail}`);
    if (c.fix) lines.push(`   → ${c.fix}`);
  }
  lines.push("");
  if (allPassed) {
    lines.push("🟢 全部通过，可以发布！");
  } else {
    const issues = failCount + warnCount;
    lines.push(`🔴 ${issues} 项需要关注${failCount > 0 ? `（${failCount} 项未通过）` : ""}，请先修复再发布。`);
  }
  const summary = lines.join("\n");

  return {
    ok: true,
    contentId,
    platform,
    checks,
    allPassed,
    passCount,
    failCount,
    summary,
  };
}
