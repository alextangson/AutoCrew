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
 *
 * 视频平台有本平台发布包（videoKit）时，3/4/6 读的是发布包——实际发出去的标题、简介与简介里的标签，
 * 不再混读口播稿的标题、标签和正文（P6 §3.6）。另有 action=video_kit：宿主交发布包，只校验与保存。
 */
import { Type } from "@sinclair/typebox";
import {
  getContent,
  getCoverReview,
  transitionStatus,
  stageBlockReason,
  normalizeLegacyStatus,
  updateContentIfDraftMatches,
  CONTENT_STATUS_LABEL,
  LOCAL_HOST,
  type Content,
  type VideoKit,
  getDataDir,
} from "../storage/local-store.js";
import { gateClaimWrite, type WriteGate } from "../storage/claims.js";
import { executeReview } from "./review.js";
import { editorialDraftHash } from "./editorial.js";
import { getPlatformRules } from "../modules/writing/title-hashtag.js";
import { COVER_TEXT_MAX, publishTitleChars, videoTitleLimit } from "../modules/publish/video-kit.js";
import { isModelCall, isVideoPlatform, VIDEO_PLATFORMS } from "../storage/stage-guard.js";
import { KIT_BEHIND_REGISTER, kitBehindRegister, kitRegisterHash } from "../modules/publish/kit-stale.js";
import { ontologyApplies, registeredPackage } from "../modules/production/publish-gate.js";
import { captionBounds, captionTags, KIT_CAPTION_MIN, mergeTags, PLATFORM_MAX_BODY, PLATFORM_MIN_BODY } from "../modules/publish/publish-limits.js";
import { SELF_WRITTEN, validateTitleChoice, type TitleChoice } from "../modules/writing/title-methods.js";
import { kitTitleAdvisories, titleMethodsAction } from "../modules/writing/title-method-stats.js";
import { maybeJson } from "../modules/publish/review-gate/plan.js";

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
  claim_token?: string; // 推进了状态且认领归调用宿主时交回（P6 §3.8）
}

export type PrePublishFailure = {
  ok: false;
  error: string;
  code?: string;
  next_action?: Record<string, unknown>;
};

// 平台上限与计数口径抽到 modules/publish/publish-limits.ts（check 与预检共用一份数字）

// --- Platforms that require cover review ---

const COVER_REQUIRED_PLATFORMS = new Set(["xiaohongshu", "xhs", "douyin", "wechat_video", "bilibili"]);

// --- Schema ---

const ACTIONS = ["check", "video_kit", "title_methods"] as const;

/** 各视频平台的上限直接从常量拼进工具说明，数字只有一份，不会说明写 20、代码判 22 */
function kitLimitsText(): string {
  const platforms = [...VIDEO_PLATFORMS];
  const titles = platforms.map((p) => `${p} ${videoTitleLimit(p)}`).join(" / ");
  const captions = platforms.map((p) => `${p} ${PLATFORM_MAX_BODY[p] ?? "不设"}`).join(" / ");
  return `post_title 上限：${titles}（中文 1 字、英文数字半字、空格不计）；caption ≥${KIT_CAPTION_MIN} 字，上限：${captions}；cover_text ≤${COVER_TEXT_MAX} 字`;
}

export const prePublishSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({
    type: "string",
    enum: [...ACTIONS],
    description:
      "check = 跑发布前检查（全过自动推进到待发布）。video_kit = 宿主交视频发布包（发布标题/简介/封面大字），" +
      "产品只校验并保存，不调模型；稿件之后再改，发布包作废，check 报 kit_stale。" +
      "title_methods = 读发布标题方法库（写 post_title 前先读）与按方法汇总的试用期统计。",
  }),
  content_id: Type.Optional(Type.String({ description: "AutoCrew content id；check、video_kit 必填，title_methods 不需要。" })),
  platform: Type.Optional(Type.String({ description: "video_kit 必填，须等于稿件平台。" })),
  kit: Type.Optional(Type.Object({
    post_title: Type.String({ description: "平台发布标题，独立于口播稿标题，按平台习惯重拟、自带钩子。" }),
    caption: Type.String({ description: "平台发布简介，可直接粘贴；是让刷到的人停下的文案，不是口播稿摘要。" }),
    cover_text: Type.String({ description: "封面大字。" }),
    hashtags: Type.Optional(Type.Array(Type.String(), {
      description: "话题标签（不带空格）。caption 里还没有的会并到 caption 末尾，字数按合并后的简介算。",
    })),
    title_candidates: Type.Optional(Type.Array(Type.Unknown(), {
      description: "3 个四平台通用标题候选 [{title, method, reason}]，分属方法库 3 个不同类（方法库见 action=title_methods）。",
    })),
    title_method: Type.Optional(Type.String({ description: `本平台 post_title 用的方法 id；创始人自己写的填「${SELF_WRITTEN}」。` })),
  }, { description: `video_kit 必填。${kitLimitsText()}。标题先按方法库出 3 个通用候选给创始人挑，再按平台落成 post_title。` })),
  claim_token: Type.Optional(Type.String({ description: "video_kit 与会推进到待发布的 check 是写：这篇有活认领时必须带令牌（pack 或 autocrew_desk claim 回的），同宿主的另一个会话也一样。" })),
});

/** 已经在发布轨上（含已发/归档）：自动流转到此为止，重跑预检不许把已发布的稿倒拨回待发布 */
const ON_PUBLISH_TRACK = new Set(["publish_ready", "publishing", "published", "archived"]);

/** 写门（P6 §3.8）：交包、预检推进状态都是写。不带 `_host` 的内部调用（工作台、发布门）按 local-user 越门记账 */
function gatePublishWrite(params: Record<string, unknown>, contentId: string, dataDir?: string): Promise<WriteGate> {
  const host = typeof params._host === "string" && params._host.trim() ? params._host.trim() : LOCAL_HOST;
  const token = typeof params.claim_token === "string" ? params.claim_token.trim() : "";
  return gateClaimWrite(contentId, { host, token: token || undefined }, dataDir);
}

/**
 * 真正推进到「待发布」。返回 null = 进去了；返回一句话 = 拦下的原因。
 * 写盘失败照旧向上 throw 到工具错误边界——吞掉等于报了「可以发布」但状态没落盘。
 */
async function runAutoTransition(contentId: string, dataDir?: string, modelCall = false): Promise<string | null> {
  // 本体 §2.1：认稿之后的推进只归创始人；模型跑的预检只给结论，不推状态（Codex 审 P1 审计模型可达入口）
  const moved = await transitionStatus(contentId, "publish_ready", modelCall ? { decidedBy: "agent" } : {}, dataDir);
  if (moved.ok) return null;
  if (moved.blocked) return moved.error ?? "阶段门拒绝";
  // 形状不对（比如稿子还在「草稿就绪」）：状态机的英文原文对创始人没意义，换人话
  const content = await getContent(contentId, dataDir);
  const label = content ? CONTENT_STATUS_LABEL[normalizeLegacyStatus(content.status)] : "当前状态";
  return `稿件还在「${label}」，先把前面的阶段走完才谈发布`;
}

// --- 实际发布文本（P6 §3.6：预检读发出去的那份，不混读口播稿） ---

interface PublishSurface {
  /** true = 视频平台且有本平台发布包，标题/简介/标签都从发布包取 */
  fromKit: boolean;
  title: string;
  text: string;
  hashtags: string[];
}

/** 与剪贴板 / ego-lite 同口径：有发布包发的是发布包（没填发布标题才退回稿件标题），标签只算简介里的 */
function publishSurface(content: Content, platform: string): PublishSurface {
  const kit = content.videoKit;
  if (isVideoPlatform(platform) && kit?.platform === platform && kit.caption?.trim()) {
    return { fromKit: true, title: kit.postTitle?.trim() || content.title || "", text: kit.caption, hashtags: captionTags(kit.caption) };
  }
  return { fromKit: false, title: content.title || "", text: content.body || "", hashtags: content.hashtags || [] };
}

function videoKitNextAction(content: Content): Record<string, unknown> {
  const platform = content.platform || "";
  return {
    tool: "autocrew_pre_publish",
    params: { action: "video_kit", content_id: content.id, platform },
    required_input: "kit",
    message: `读当前稿，先用 action=title_methods 读标题方法库，出 3 个通用候选给创始人挑，再按平台重拟 kit{post_title, caption, cover_text, hashtags?, title_candidates, title_method}。${kitLimitsText()}。`,
  };
}

/** 发布包带指纹且与当前稿对不上 = 按旧稿做的；旧发布包没有指纹，不判过期 */
function staleKit(content: Content, platform: string): PrePublishFailure | null {
  const kit = content.videoKit;
  if (!isVideoPlatform(platform) || kit?.platform !== platform) return null;
  if (kitBehindRegister(content, kit)) return { ok: false, code: "kit_stale", error: KIT_BEHIND_REGISTER, next_action: videoKitNextAction(content) };
  if (!kit.draftHash) return null;
  if (kit.draftHash === editorialDraftHash(content)) return null;
  return {
    ok: false,
    code: "kit_stale",
    error: "视频发布包是按旧稿做的（稿件后来改过），标题和简介可能对不上新稿：按当前稿重做发布包，再跑发布前检查",
    next_action: videoKitNextAction(content),
  };
}

function hashtagCheck(surface: PublishSurface, platform: string): CheckItem {
  const name = "Hashtags";
  if (platform === "wechat_mp") return { name, status: "skip", detail: "公众号文章无需话题标签" };
  const count = surface.hashtags.length;
  if (count >= 1) return { name, status: "pass", detail: `${count} 个标签${surface.fromKit ? "（发布简介内）" : ""}` };
  return surface.fromKit
    ? { name, status: "fail", detail: "发布简介里没有话题标签", fix: "用 autocrew_pre_publish video_kit 重交发布包，hashtags 会并进简介末尾" }
    : { name, status: "fail", detail: "无标签", fix: "通过 autocrew_rewrite 生成标题和标签，或手动 update hashtags" };
}

function titleCheck(surface: PublishSurface, platform: string): CheckItem {
  const title = surface.title;
  if (!title) return { name: "标题规范", status: "fail", detail: "无标题", fix: "设置标题" };
  if (!surface.fromKit) return draftTitleCheck(title, platform);
  // 发布包标题按平台硬上限算（与交包时同一口径），超了平台会截断——截断等于改意
  const chars = publishTitleChars(title);
  const limit = videoTitleLimit(platform);
  return chars > limit
    ? { name: "标题规范", status: "fail", detail: `发布标题「${title}」(${chars}字，超出 ${limit} 上限)`, fix: "用 autocrew_pre_publish video_kit 重交更短的 post_title" }
    : { name: "标题规范", status: "pass", detail: `发布标题「${title}」(${chars}字，≤${limit})` };
}

function draftTitleCheck(title: string, platform: string): CheckItem {
  const rules = getPlatformRules(platform);
  // No rules for this platform, just check title exists
  if (!rules) return { name: "标题规范", status: "pass", detail: `「${title}」(${title.length}字)` };
  const [minLen, maxLen] = rules.titleLengthRange;
  const maxAbsolute = rules.maxTitleLength;
  if (title.length > maxAbsolute) {
    return {
      name: "标题规范",
      status: "warn",
      detail: `「${title}」(${title.length}字，超出 ${maxAbsolute} 上限)`,
      fix: "通过 autocrew_rewrite 生成更短的标题变体",
    };
  }
  if (title.length < minLen) {
    return { name: "标题规范", status: "warn", detail: `「${title}」(${title.length}字，低于建议 ${minLen} 下限)` };
  }
  return { name: "标题规范", status: "pass", detail: `「${title}」(${title.length}字，符合 ${minLen}-${maxLen} 范围)` };
}

function lengthCheck(surface: PublishSurface, platform: string): CheckItem {
  const name = surface.fromKit ? "发布简介字数" : "正文字数";
  const [minLen, maxLen] = surface.fromKit
    ? captionBounds(platform)
    : [PLATFORM_MIN_BODY[platform] || 100, PLATFORM_MAX_BODY[platform]];
  const len = surface.text.length;
  if (len < minLen) {
    const fix = surface.fromKit ? "补全发布简介的内容价值与必要信息后重交发布包" : "扩充正文，增加案例或数据";
    return { name, status: "fail", detail: `${len} 字 (不足 ${minLen})`, fix };
  }
  if (maxLen !== undefined && len > maxLen) {
    return { name, status: "fail", detail: `${len} 字 (超出 ${maxLen} 上限)`, fix: overLimitFix(surface, platform) };
  }
  return { name, status: "pass", detail: `${len} 字 (≥${minLen}${maxLen !== undefined ? `，≤${maxLen}` : ""})` };
}

function overLimitFix(surface: PublishSurface, platform: string): string {
  if (surface.fromKit) return "精简发布简介后重交发布包，保留口播全文";
  if (!isVideoPlatform(platform)) return "编辑器里选段用「缩写」压缩，或 autocrew_rewrite 精简正文";
  // 视频稿的正文是口播全文，超限不该压缩它——该做的是交发布包，预检改按发布简介校验
  return `先交视频发布包：autocrew_pre_publish action='video_kit' {content_id, platform:'${platform}', ` +
    "kit:{post_title, caption, cover_text, hashtags?, title_candidates, title_method}}，预检改按发布简介校验；不要压缩口播全文";
}

// --- video_kit：宿主交发布包（P6 §3.6，host-first，不调模型） ---

type KitFailure = { field: string; detail: string };
type KitFields = Pick<VideoKit, "postTitle" | "caption" | "coverText">;

/** 标签去 #、去空白；含空格或 # 的发出去会断成两截，直接打回 */
function readTags(raw: unknown, failures: KitFailure[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) {
    failures.push({ field: "hashtags", detail: "hashtags 要是字符串数组，如 [\"AI工具\", \"职场\"]" });
    return [];
  }
  const tags = (raw as string[]).map((t) => t.trim().replace(/^#+/, "")).filter(Boolean);
  const bad = tags.filter((t) => /[\s#]/.test(t));
  if (bad.length > 0) failures.push({ field: "hashtags", detail: `标签「${bad.join("」「")}」里有空格或 #，发出去会断开：去掉后重交` });
  return bad.length > 0 ? [] : [...new Set(tags)];
}

function validateKit(raw: unknown, platform: string): { failures: KitFailure[]; fields: KitFields; title: TitleChoice } {
  const parsed = maybeJson(raw);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const text = (key: string) => (typeof obj[key] === "string" ? (obj[key] as string).trim() : "");
  const failures: KitFailure[] = [];
  const postTitle = text("post_title");
  const titleChars = publishTitleChars(postTitle);
  const titleLimit = videoTitleLimit(platform);
  if (!postTitle) failures.push({ field: "post_title", detail: "缺发布标题：按平台习惯重拟一句带钩子的标题，别照搬口播稿标题" });
  else if (titleChars > titleLimit) failures.push({ field: "post_title", detail: `${titleChars} 字，超出 ${platform} 上限 ${titleLimit}（中文 1 字、英文数字半字）：压缩后重交，别靠省略号硬截` });
  const tags = readTags(obj.hashtags, failures);
  const caption = text("caption") ? mergeTags(text("caption"), tags) : "";
  const [minLen, maxLen] = captionBounds(platform);
  if (!caption) failures.push({ field: "caption", detail: "缺发布简介：写让刷到的人停下的文案，不是口播稿摘要" });
  else if (caption.length < minLen) failures.push({ field: "caption", detail: `${caption.length} 字，不足 ${minLen}：补上这期讲什么、看完能带走什么` });
  else if (maxLen !== undefined && caption.length > maxLen) failures.push({ field: "caption", detail: `${caption.length} 字（含并入的标签），超出 ${platform} 上限 ${maxLen}：精简后重交` });
  const coverText = text("cover_text");
  if (!coverText) failures.push({ field: "cover_text", detail: "缺封面大字：一眼能读完的一句话" });
  else if (coverText.length > COVER_TEXT_MAX) failures.push({ field: "cover_text", detail: `${coverText.length} 字，超出 ${COVER_TEXT_MAX}：封面大字要一眼读完，压缩后重交` });
  const title = validateTitleChoice(obj.title_candidates, obj.title_method);
  return { failures: [...failures, ...title.failures], fields: { postTitle, caption, coverText }, title: title.choice };
}

/** 平台与稿件的前置核对：发布包按平台定字数，存错平台等于拿别的平台的规矩放行 */
function kitPlatformError(content: Content, requested: unknown): Record<string, unknown> | null {
  const platform = content.platform || "";
  if (!isVideoPlatform(platform)) {
    return { ok: false, code: "not_video_platform", error: `视频发布包只服务视频平台（${[...VIDEO_PLATFORMS].join(" / ")}），这篇是 ${platform || "未知平台"}` };
  }
  if (requested === platform) return null;
  const got = typeof requested === "string" && requested ? requested : "空";
  return { ok: false, code: "platform_mismatch", error: `platform 必须等于稿件平台 ${platform}（收到 ${got}）`, expected_platform: platform };
}

async function saveHostVideoKit(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const contentId = typeof params.content_id === "string" ? params.content_id.trim() : "";
  const dataDir = (params._dataDir as string) || undefined;
  if (!contentId) return { ok: false, code: "missing_content_id", error: "content_id 必填" };
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, code: "not_found", error: `稿件不存在：${contentId}` };
  const platformError = kitPlatformError(content, params.platform);
  if (platformError) return platformError;
  // P6-e narration-not-state（2/3）：模型听 Codex 一句「已登记」就出了发布包。发布包只跟着成片走：
  // 成片戳（register 或内置线审片）没盖，就没有发布包可出——状态由产品说了算，不由转述说了算。
  if (!content.videoDone) {
    return {
      ok: false, code: "video_not_done", content_status: content.status,
      error: "成片还没登记（videoDone 未盖）：等 Codex 调 autocrew_video register（或内置线审片通过）之后再出发布包；别人的口头「已登记」不算",
      next_action: { tool: "autocrew_content", params: { action: "get", id: contentId }, message: "只看 content 状态与 video.final 判断成片是否登记；未登记就继续等，不出发布包。" },
    };
  }
  const platform = content.platform as string;
  const { failures, fields, title } = validateKit(params.kit, platform);
  if (failures.length > 0) {
    return { ok: false, code: "kit_invalid", error: `发布包有 ${failures.length} 处要改：按 failures 逐条改完整包重交`, failures };
  }
  const gate = await gatePublishWrite(params, contentId, dataDir);
  if ("denied" in gate) return gate.denied;
  const kit: VideoKit = {
    platform, ...fields, titleMethod: title.method, titleCandidates: title.candidates, storyboard: [], coverPrompt: "",
    generatedAt: new Date().toISOString(), source: "host", draftHash: editorialDraftHash(content), ...kitRegisterHash(content),
  };
  // 指纹与落盘同锁核对：读稿到写包之间稿件被改，就不能把旧稿的指纹钉到新稿上
  const saved = await updateContentIfDraftMatches(contentId, content, { videoKit: kit }, dataDir);
  if (!saved.ok) {
    return saved.reason === "stale"
      ? { ok: false, code: "draft_changed", error: "保存时稿件刚被改过：重读当前稿，按新稿重做发布包", ...gate.grant }
      : { ok: false, code: "not_found", error: `稿件不存在：${contentId}` };
  }
  return {
    ok: true,
    status: "kit_saved",
    content_id: contentId,
    video_kit: { platform, post_title: kit.postTitle, caption: kit.caption, cover_text: kit.coverText, title_method: kit.titleMethod, draft_hash: kit.draftHash, source: kit.source },
    ...(await kitTitleAdvisories(kit.postTitle, content.body || "", dataDir)),
    next_action: { tool: "autocrew_pre_publish", params: { action: "check", content_id: contentId } },
    ...gate.grant,
  };
}

/** MCP 入口按 action 分派；GUI 与发布门只跑 check，直接调 executePrePublish */
export async function executePrePublishTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (params.action === "title_methods") return titleMethodsAction(params);
  return params.action === "video_kit" ? saveHostVideoKit(params) : executePrePublish(params);
}

// --- Execute ---

export async function executePrePublish(params: Record<string, unknown>): Promise<PrePublishResult | PrePublishFailure> {
  const contentId = params.content_id as string;
  const dataDir = (params._dataDir as string) || undefined;

  if (!contentId) return { ok: false, error: "content_id is required" };

  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `Content ${contentId} not found` };

  const platform = content.platform || "";
  const stale = staleKit(content, platform);
  if (stale) return stale;
  const surface = publishSurface(content, platform);
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
      checks.push({ name: "内容审核", status: "pass", detail: "基础文字检查通过；不代表事实、规划、表达已过审，作者批准仍由稿件阶段单独检查" });
    } else {
      // 报出具体拦路项——只说「敏感词 ✗ 1 个」用户不知道是哪个词、改哪里,发布就成死胡同。
      const hits = (reviewResult.sensitiveWords?.hits ?? []) as Array<{ word: string; suggestion?: string }>;
      const aiChanges = (reviewResult.aiCheck?.changes ?? []) as string[];
      const parts: string[] = [];
      if (hits.length > 0) {
        parts.push(`敏感词:${hits.map((h) => `「${h.word}」${h.suggestion ? "" : "(无自动替换,需手动改)"}`).join("、")}`);
      }
      if (aiChanges.length > 0) parts.push(`格式提示:${aiChanges.join("、")}`);
      const manual = hits.length > 0;
      checks.push({
        name: "内容审核",
        status: "fail",
        detail: parts.length > 0 ? parts.join("；") : reviewResult.summary || "未通过",
        fix: manual
          ? "请按具体语境在编辑器核对并修改敏感词；auto_fix 只整理空白，不会自动改写原意"
          : "核对检查详情；格式空白可使用 autocrew_review action='auto_fix'",
      });
    }
  } catch {
    checks.push({ name: "内容审核", status: "fail", detail: "审核执行出错", fix: "手动运行 autocrew_review" });
  }

  // --- Check 2: Cover review (all video platforms) ---
  // 启用本体的稿出包（_ontologyGated，只由 ToolRunner 内部带）：封面由登记记录 + 发布前把关（槽位 / 登记那一对）核，旧封面审核不再适用
  // 参数本身不可信（模型也能带下划线参数）：只有这条真按本体走才生效
  const ontologyGated = params._ontologyGated === true && COVER_REQUIRED_PLATFORMS.has(platform) && (await ontologyApplies(content, getDataDir(dataDir)));
  if (ontologyGated) {
    checks.push({ name: "封面审核", status: "skip", detail: "本体稿：封面由登记记录与发布前把关核对" });
  } else if (COVER_REQUIRED_PLATFORMS.has(platform)) {
    const coverReview = await getCoverReview(contentId, dataDir);
    if (coverReview && (coverReview.status === "approved" || coverReview.status === "publish_ready") && coverReview.approvedLabel) {
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

  // --- Check 3: Hashtags / Check 4: Title length（有发布包读发布包） ---
  checks.push(hashtagCheck(surface, platform));
  checks.push(titleCheck(surface, platform));

  // --- Check 5: Platform set ---
  const supportedPlatforms = ["xiaohongshu", "xhs", "douyin", "wechat_mp", "wechat_video", "bilibili"];
  if (platform && supportedPlatforms.includes(platform)) {
    checks.push({ name: "平台设置", status: "pass", detail: platform });
  } else if (platform) {
    checks.push({ name: "平台设置", status: "warn", detail: `${platform} (非标准平台)` });
  } else {
    checks.push({ name: "平台设置", status: "fail", detail: "未指定平台", fix: "通过 autocrew_content update 设置 platform" });
  }

  // --- Check 6: Body length（有发布包读发布简介） ---
  checks.push(lengthCheck(surface, platform));

  // --- Check 6b: 发布出口（本体 §5）：按本体走的视频稿只发当前有效登记记录里的成片与封面 ---
  const gated = isVideoPlatform(platform) ? await registeredPackage(content, getDataDir(dataDir)) : null;
  if (gated) checks.push(gated.ok
    ? { name: "登记（发布出口）", status: "pass", detail: `发当前登记的成片与封面（${gated.files.registration.id}）` }
    : { name: "登记（发布出口）", status: "fail", detail: gated.error, fix: "在工作台重新通过成片 / 封面，登记会自动完成" });

  // --- Check 7: 阶段门（阶段制 spec §1.2/§4 #1） ---
  // 六项全过之后才谈流转。**预检不许绕过阶段门**：视频稿卡在剪辑阶段时，
  // 从前这里的 transitionStatus 失败被整个忽略，结果照报「全部通过，可以发布」——
  // 状态没动，人却以为可以发了。现在门拦下就明说卡在哪、为什么。
  //
  // `_readOnly`（内部参数，模型输入到不了这里）：对话面的 pre_publish_check 是纯查询，
  // 不许替用户跨过「待发布」这条人审关卡（设计 §总原则：人审关卡保留人手点击）——
  // 但门的判定照跑照报，只是不写盘。
  // 真要推进才过令牌门（P6 §3.8）：推进是写，只读的预检谁都能跑
  const current = normalizeLegacyStatus(content.status);
  let grant: { claim_token?: string } = {};
  if (checks.every((c) => c.status !== "fail") && !ON_PUBLISH_TRACK.has(current)) {
    const gate = params._readOnly === true ? null : await gatePublishWrite(params, contentId, dataDir);
    if (gate && "denied" in gate) return gate.denied;
    grant = gate?.grant ?? {};
    const blocked = gate ? await runAutoTransition(contentId, dataDir, isModelCall(params)) : await stageBlockReason(content, "publish_ready", dataDir);
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

  return { ok: true, contentId, platform, checks, allPassed, passCount, failCount, summary, ...grant };
}
