import { isModelCall, isVideoPlatform } from "../storage/stage-guard.js";
import { historyGuard } from "./history-guard.js";
import { isOntologyActive, isOntologyEnabled } from "../storage/production-store.js";
import { recordPublishClaim } from "../modules/production/record.js";
import { founderDecision } from "../modules/production/decisions.js";
import { projectMarkdownExport } from "../storage/project-record.js";
import { writeTextAtomic } from "../storage/json-atomic.js";
import { contentFile, resolveContentProject } from "../storage/content-project.js";
import path from "node:path";
import fs from "node:fs/promises";
import { updatingRefusal } from "../modules/update/preflight.js";
import { Type } from "@sinclair/typebox";
import { getContent, updateContent, transitionStatus, getDataDir, getCoverReview } from "../storage/local-store.js";
import { publishWechatMpDraft } from "../modules/publish/wechat-mp.js";
import { loadWechatMpConfig } from "../modules/publish/wechat-config.js";
import { formatForClipboard, type ClipboardPlatform } from "../modules/publish/clipboard-publisher.js";
import { VIDEO_PLATFORMS } from "../modules/publish/video-kit.js";
import { preparedArticleImages } from "../modules/publish/article-images.js";
import { scanText } from "../modules/filter/sensitive-words.js";
import { generateAndSaveDigest } from "../modules/publish/digest.js";
import { bindByPublishUrl } from "../modules/flywheel/platform-items.js";
import { deriveAndRecordAdoption } from "../modules/learnings/adoption-derive.js";
import { prepareCheckedPublish, prepareEgoLitePublish } from "../modules/publish/ego-lite.js";
import { executePublishCheck, type CheckDeps } from "../modules/publish/review-gate/check.js";
import { proposePreference } from "../modules/publish/review-gate/preferences.js";

export const publishSchema = Type.Object({
  action: Type.Unsafe<"wechat_mp_draft" | "clipboard" | "ego_lite_prepare" | "confirm_published" | "digest" | "check" | "propose_preference">({
    type: "string",
    enum: ["wechat_mp_draft", "clipboard", "ego_lite_prepare", "confirm_published", "digest", "check", "propose_preference"],
    description: "Publish action. 'check' reviews a video publish plan per platform before the one-time founder confirmation (deterministic cover/cut/text rules + TypeSafe semantic warnings); paste its summary_table verbatim and never submit a blocked platform. 'propose_preference' proposes a new cover-ratio or publish rule the founder confirms in the workbench. 'ego_lite_prepare' resolves a browser upload package for 视频号/小红书/抖音/Bilibili without clicking Publish; 'wechat_mp_draft' for WeChat MP; 'clipboard' for copy-paste; 'confirm_published' marks a live result; 'digest' generates/saves a ≤20-char WeChat 摘要.",
  }),
  article_path: Type.Optional(Type.String({ description: "Absolute or relative path to the markdown article file." })),
  content_id: Type.Optional(Type.String({ description: "AutoCrew content id. If provided, draft.md will be used." })),
  theme: Type.Optional(Type.String({ description: "WeChat formatting theme. Default: newspaper." })),
  dry_run: Type.Optional(Type.Boolean({ description: "Generate assets and show the publish command without pushing." })),
  skip_images: Type.Optional(Type.Boolean({ description: "Skip image generation if images already exist." })),
  author: Type.Optional(Type.String({ description: "Displayed author name for the WeChat publish script." })),
  image_size: Type.Optional(Type.String({ description: "Image ratio for generated images. Default: 16:9." })),
  image_generator_script: Type.Optional(Type.String({ description: "Override path to the image generation script." })),
  image_api_key: Type.Optional(Type.String({ description: "Override image generation API key." })),
  image_base_url: Type.Optional(Type.String({ description: "OpenAI-compatible relay base URL for image generation (must pair with the api key)." })),
  image_model: Type.Optional(Type.String({ description: "Image model id, e.g. gpt-image-2 for relays. Default: script's built-in (doubao-seedream)." })),
  wechat_publish_script: Type.Optional(Type.String({ description: "Override path to the WeChat publish.py script." })),
  hashtags: Type.Optional(Type.Array(Type.String(), { description: "Hashtags for the content. Overrides content hashtags if provided." })),
  publish_url: Type.Optional(Type.String({ description: "The URL where content was published (for confirm_published action)." })),
  force: Type.Optional(Type.Boolean({ description: "Bypass the pre-publish checklist gate. Use only when the user explicitly insists." })),
  digest: Type.Optional(Type.String({ description: "For 'digest' action: manual 摘要 to save (empty clears it). Omit to AI-generate." })),
  schedule: Type.Optional(Type.String({ description: "Optional platform-local scheduled time carried into the ego lite browser hand-off." })),
  check_ids: Type.Optional(Type.Array(Type.String(), { description: "For 'ego_lite_prepare': the check_id of each platform to package, from the latest 'check'. Stale or blocked platforms get no package." })),
  plan: Type.Optional(Type.Unknown({ description: "For 'check': the publish plan JSON object, or a project-relative path such as 06-publish/publish-plan.json. Each platform entry: platform, content_id, account_display_name, title, caption, tags, covers:[{usage, ratio, path}], cover_text, scheduled_at, timezone, campaigns; final_video.path at top level." })),
  founder_quotes: Type.Optional(Type.Array(Type.String(), { description: "For 'check': every thing the founder said about this publish in this conversation, verbatim." })),
  instruction_id: Type.Optional(Type.String({ description: "For 'check': the ins-… id from the last line of the workbench 「让 Codex 发布」 text, if the founder pasted one. Omit when there is none." })),
  overrides: Type.Optional(Type.Unknown({ description: "For 'check': [{platform, rule, founder_quote}] — only when the founder explicitly asked to break a blocked rule (rule = the blocked item's rule name, founder_quote verbatim); shown verbatim in summary_table." })),
  kind: Type.Optional(Type.String({ description: "For 'propose_preference': cover_ratio (platform + ratio list) or rule (free-text publish rule)." })),
  platform: Type.Optional(Type.String({ description: "For 'propose_preference': platform the preference applies to (required for cover_ratio)." })),
  value: Type.Optional(Type.Unknown({ description: "For 'propose_preference': ratio list like [\"3:4\",\"4:3\"] for cover_ratio, or the rule text for rule." })),
  founder_quote: Type.Optional(Type.String({ description: "For 'propose_preference': the founder's exact words behind this preference." })),
});

/** 平台链接白名单:只认 http(s)。javascript:/file: 之类既不是发布地址,也不该被界面渲染成可点链接 */
function isHttpUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 顺手登记「平台作品 id ↔ 稿件」绑定(spec §5.1 ①):贴了链接就当场认亲,
 * 回流数据以后按作品 id 精确认领,不再赌标题没被改过。
 * best-effort:解析不出(如视频号分享链)、短链解不开、写盘失败都只留 warn——
 * 发布这件事已经在外部世界发生了,系统状态必须先服从事实。
 */
async function bindPublishedUrl(
  contentId: string,
  platform: string | null,
  url: string,
  dataDir: string,
): Promise<string | null> {
  try {
    return await bindByPublishUrl(contentId, platform, url, dataDir);
  } catch (err) {
    console.warn(`[publish] 平台作品绑定登记失败(不影响已发布状态)：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 发布时刻推导采纳判定（隐式裁决）。best-effort：判定失败绝不能让「确认已发布」失败——
 * 发布这件事已经在外部世界发生了，系统状态必须先服从事实。
 */
async function deriveAdoption(contentId: string, dataDir: string) {
  try {
    return await deriveAndRecordAdoption(contentId, dataDir);
  } catch (err) {
    console.warn(`[publish] 采纳判定失败(不影响已发布状态)：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** check_ids：数组 / JSON 字符串 / 逗号分隔都认（模型参数不保证类型） */
function checkIdsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((x) => x.trim()).filter(Boolean);
  if (typeof v !== "string" || !v.trim()) return [];
  try { const p = JSON.parse(v) as unknown; if (Array.isArray(p)) return p.map(String).filter(Boolean); } catch { /* 按逗号拆 */ }
  return v.split(/[,，\s]+/).map((x) => x.replace(/^["'[]+|["'\]]+$/g, "")).filter(Boolean);
}

export async function executePublish(
  params: Record<string, unknown>,
  deps?: { publishImpl?: typeof publishWechatMpDraft; check?: CheckDeps },
) {
  const action = params.action as string;
  // getDataDir 统一解析(session-8 收编私有副本的第七处漏网):认 AUTOCREW_DATA_DIR 重定向,
  // 否则隔离工作区/smoke 里 clipboard 会去真实 ~/.autocrew 找稿件
  const dataDir = getDataDir((params._dataDir as string) || undefined);
  const history = await historyGuard(params.content_id, dataDir);
  if (history) return history;

  // --- check: 发布前把关（只写检查留档，不改业务状态）；propose_preference: 只记提议，创始人在网页确认 ---
  if (action === "check") return executePublishCheck({ ...params, _dataDir: dataDir }, deps?.check);
  if (action === "propose_preference") {
    const r = await proposePreference(params, typeof params._host === "string" ? params._host : "local-user", dataDir);
    return r.ok
      ? { ok: true, proposal: r.proposal, duplicate: r.duplicate, note: "已记为待确认提议：创始人在工作台顶部点「确认」才生效；在那之前 check 仍按现行规则判" }
      : r;
  }

  // --- clipboard: format content for manual copy-paste publishing ---
  if (action === "clipboard") {
    const contentId = params.content_id as string | undefined;
    if (!contentId) {
      return { ok: false, error: "content_id is required for clipboard action" };
    }
    const content = await getContent(contentId, dataDir);
    if (!content) {
      return { ok: false, error: `Content not found: ${contentId}` };
    }
    const platform = (content.platform || "xiaohongshu") as ClipboardPlatform;
    const hashtags = (params.hashtags as string[] | undefined) || content.hashtags || [];
    // V5.4b:视频平台有发布件 → 发的是发布件(平台标题+发布文案,已含标签),不是口播稿截断
    if (content.videoKit?.caption && VIDEO_PLATFORMS.has(platform)) {
      const kit = content.videoKit;
      const output = formatForClipboard(platform, kit.postTitle || content.title, kit.caption, []);
      return { ok: true, data: { ...output, fromVideoKit: true } };
    }
    const output = formatForClipboard(platform, content.title, content.body, hashtags);
    return { ok: true, data: output };
  }

  // 一键更新进行中（self-update §3）：发布类动作不开新的，免得重启时掐断
  const updating = updatingRefusal();
  if (updating) return { ok: false, code: "updating", error: updating };

  // --- ego_lite_prepare：从不点发布。资料库启用本体之后（发布技能改口补丁在同一时刻套上）按平台出包、每个平台必须带当前有效的
  // check_id（发布前把关 spec §11）；启用之前旧调用方不变：单包出，带了 check_ids 也照新契约出 ---
  if (action === "ego_lite_prepare") {
    const contentId = params.content_id as string | undefined;
    if (!contentId) {
      return { ok: false, error: "content_id is required for ego_lite_prepare action" };
    }
    const ids = checkIdsOf(params.check_ids ?? params.check_id);
    if (!ids.length && !(await isOntologyEnabled(dataDir))) {
      try { return { ok: true, data: await prepareEgoLitePublish(contentId, dataDir, params.schedule as string | undefined) }; }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    }
    if (!ids.length) return { ok: false, code: "check_required", error: "出发布包要带每个平台的 check_id：先跑 autocrew_publish check，把返回的各平台 check_id 带上（被拦或过期的平台不出包）" };
    try {
      const data = await prepareCheckedPublish(contentId, ids, dataDir, params.schedule as string | undefined);
      if (!data.packages.length) return { ok: false, code: "no_valid_check", error: data.refused.map((r) => r.error).join("；"), refused: data.refused };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- digest: 生成(默认) 或 手动保存(带 digest 参数) 一条 ≤20 字公众号摘要 ---
  if (action === "digest") {
    const contentId = params.content_id as string | undefined;
    if (!contentId) return { ok: false, error: "content_id is required for digest action" };
    const manual = typeof params.digest === "string" ? params.digest.trim().slice(0, 40) : undefined;
    try {
      if (manual !== undefined) {
        const updated = await updateContent(contentId, { digest: manual }, dataDir);
        if (!updated) return { ok: false, error: `Content not found: ${contentId}` };
        return { ok: true, data: { digest: manual } };
      }
      const { digest } = await generateAndSaveDigest(contentId, dataDir);
      return { ok: true, data: { digest } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- confirm_published: mark content as published after manual paste ---
  // 回执与发布前检查的绑定在发布槽里做（modules/production/publish-check-link.ts）：「我发了」盖把关结论，AI 说法记待核
  if (action === "confirm_published") {
    const contentId = params.content_id as string | undefined;
    if (!contentId) {
      return { ok: false, error: "content_id is required for confirm_published action" };
    }
    const content = await getContent(contentId, dataDir);
    if (!content) {
      return { ok: false, error: `Content not found: ${contentId}` };
    }
    // 平台链接:省略/空串 = 保留旧值,只有显式给了新值才覆盖——重复确认(手滑双击/助手重跑)
    // 不带链接时,不许把上次贴的链接抹成 null。非 http(s) 直接拒收,不落盘。
    const rawUrl = typeof params.publish_url === "string" ? params.publish_url.trim() : "";
    if (rawUrl && !isHttpUrl(rawUrl)) {
      return { ok: false, error: `平台链接只接受 http/https 开头的地址：${rawUrl.slice(0, 80)}` };
    }
    // 状态收口（阶段制 spec §1.2）：这里不再直改 status，走唯一通道 transitionStatus。
    // force 是因为「approved / 待发布 / 发布中 都能点确认」这条既有产品规则跨了状态图形状；
    // 阶段门 force 也越不过，但它对「→ 已发布」本就没有规则，行为一字未变。
    // 发布时刻只盖一次:重复确认(手滑双击/助手重跑)不许把首次发布时间冲成现在,
    // 否则「稿成→发布」的用时会被越算越短——这条纪律现在由 transitionStatus 统一守。
    // 本体 §6：按本体走的视频稿，模型说「发了」= 待核回执，创始人点 = 「我发了」决定；状态由推导投影
    if (isVideoPlatform(content.platform) && await isOntologyActive(dataDir, contentId)) {
      const r = isModelCall(params)
        ? await recordPublishClaim(content, getDataDir(dataDir), { platform: content.platform, url: rawUrl || undefined, host: String(params._host ?? "model"), request_id: `confirm-${Date.now()}` })
        : await founderDecision(contentId, "i_published", { platform: content.platform, url: rawUrl }, getDataDir(dataDir));
      if (!r.ok) return r;
      if (rawUrl && !isModelCall(params)) await updateContent(contentId, { publishUrl: rawUrl }, dataDir);
      return { ...r, action: "confirm_published", content_id: contentId };
    }
    // 本体 §2.1 / §6：模型说「发了」不算数，推不动状态（创始人点「我发了」或发布器 / 数据回流核实）
    const marked = await transitionStatus(contentId, "published", { force: true, ...(isModelCall(params) ? { decidedBy: "agent" as const } : {}) }, dataDir);
    if (!marked.ok) {
      return { ok: false, error: marked.error ?? `Failed to update content: ${contentId}` };
    }
    const updated = await updateContent(contentId, {
      publishUrl: rawUrl || content.publishUrl || null,
    }, dataDir);
    if (!updated) {
      return { ok: false, error: `Failed to update content: ${contentId}` };
    }
    const boundItemId = updated.publishUrl
      ? await bindPublishedUrl(contentId, updated.platform ?? null, updated.publishUrl, dataDir)
      : null;
    const adoption = await deriveAdoption(contentId, dataDir);
    return {
      ok: true,
      data: {
        id: contentId,
        status: "published",
        publishedAt: updated.publishedAt,
        publishUrl: updated.publishUrl ?? null,
        boundItemId,
        ...(adoption ? { adoption } : {}),
      },
    };
  }

  // --- wechat_mp_draft: A 级发布（P0 阶段 2）——store 为事实源 + 审核员发布门 ---
  if (action !== "wechat_mp_draft") {
    return { ok: false, error: `Unknown action: ${action}` };
  }

  const publishImpl = deps?.publishImpl ?? publishWechatMpDraft;
  const contentId = params.content_id as string | undefined;
  let articlePath: string;
  let gateText: string;
  let preparedImages: string[] | undefined;
  let digest: string | undefined;

  if (contentId) {
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, error: `Content not found: ${contentId}` };
    // 发布时从 store 新鲜落盘 draft.md——工作台编辑只更新 store，旧 draft.md 不得被推送
    const project = resolveContentProject(content.id, dataDir);
    articlePath = contentFile(content.id, dataDir, project ? "publish-export.md" : "draft.md");
    const exportedBody = project ? projectMarkdownExport(content.body, project.project_root) : content.body;
    await writeTextAtomic(articlePath, `# ${content.title}\n\n${exportedBody}\n`);
    gateText = `${content.title}\n\n${content.body}`;
    digest = content.digest;
    const bodyImages = await preparedArticleImages(contentId, dataDir);
    if (!bodyImages.ok) return bodyImages;
    preparedImages = bodyImages.paths;
  } else if (params.article_path) {
    articlePath = path.resolve(params.article_path as string);
    try {
      gateText = await fs.readFile(articlePath, "utf-8");
    } catch {
      return { ok: false, error: `Article not found: ${articlePath}` };
    }
  } else {
    return { ok: false, error: "article_path or content_id is required" };
  }

  // 审核员发布门（同步阻断）：违禁词未清零禁止推送；force 放行但违规照样透出——
  // 最终决定权在人，系统保持透明（禁止静默）
  const scan = await scanText(gateText, "wechat_mp", dataDir);
  const violations = scan.hits.map((h) => h.word);
  if (violations.length > 0 && !params.force) {
    return {
      ok: false,
      violations,
      error: `审核员阻断推送：命中违禁词「${violations.join("、")}」。修改后重试（或 force 强制推送，不建议）`,
    };
  }

  // 封面设计师接线:有选用封面(approvedImagePath,公众号即 2.35:1 精裁图)就推它,
  // 不再让脚本拿"文中第一图"当封面——设计师转正了,活儿要上岗
  let approvedCover: string | undefined;
  if (contentId) {
    const review = await getCoverReview(contentId, dataDir).catch(() => null);
    const p = review?.approvedImagePath;
    if (p) {
      try {
        await fs.access(p);
        approvedCover = p;
      } catch {
        /* 选用图文件丢失 → 维持脚本兜底 */
      }
    }
  }

  const cfg = await loadWechatMpConfig(dataDir);
  const result = await publishImpl({
    articlePath,
    coverPath: approvedCover,
    wechatAppId: cfg.wechatAppId,
    wechatAppSecret: cfg.wechatAppSecret,
    openComment: cfg.openComment,
    theme: (params.theme as string) || cfg.theme || "newspaper",
    dryRun: Boolean(params.dry_run),
    skipImages: Boolean(params.skip_images),
    author: (params.author as string) || cfg.author || "Lawrence",
    imageSize: (params.image_size as string) || "16:9",
    imageGeneratorScript: (params.image_generator_script as string) || cfg.imageGeneratorScript,
    imageApiKey: (params.image_api_key as string) || cfg.imageApiKey,
    imageBaseUrl: (params.image_base_url as string) || cfg.imageBaseUrl,
    imageModel: (params.image_model as string) || cfg.imageModel,
    wechatPublishScript: (params.wechat_publish_script as string) || cfg.wechatPublishScript,
    apiProxy: (params.api_proxy as string) || cfg.apiProxy,
    digest,
    preparedImages,
  });

  const receipt = result.ok
    ? { ...result, nextStep: "到公众号后台「草稿箱」检查排版后点击发表，发表后回到工作台点「确认已发布」" }
    : result;
  return violations.length > 0 ? { ...receipt, violations, warning: "force 推送：违禁词未清零" } : receipt;
}
