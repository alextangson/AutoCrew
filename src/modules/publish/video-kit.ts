/**
 * 视频发布件（IA v5 V5.4b）——口播稿是"读的",发布件是"发的":
 * 平台原生发布文案 + 分镜表 + 竖版封面。approved 后按需生成(不塞进生成管线,
 * 只在真要发视频时多一次调用),存到 Content.videoKit,剪贴板/预填从这里取文案。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { getContent, updateContent, getDataDir } from "../../storage/local-store.js";
import type { VideoKit, StoryboardShot } from "../../storage/local-store.js";
import { loadProfile, personaSummary, rulesForPlatform } from "../profile/creator-profile.js";
import { loadWechatMpConfig } from "./wechat-config.js";
import { generateImageViaRelay } from "./image-gen.js";

export const VIDEO_PLATFORMS = new Set(["douyin", "wechat_video", "xiaohongshu", "bilibili"]);

/** 平台文案纪律(prompt 注入用,与 clipboard tips 同口径) */
const CAPTION_RULES: Record<string, string> = {
  douyin: "发布文案 ≤300 字:首句钩子(时间线只见首行),3-5 个话题标签内联在文末",
  wechat_video: "发布文案 100-300 字:一句钩子+一句价值点,2-4 个话题标签",
  xiaohongshu: "发布文案 300-800 字:口语化短段落,可用 emoji,5-15 个话题标签放文末",
  bilibili: "发布文案(简介)200-500 字:讲清这期讲什么+能带走什么,3-6 个标签",
};

/** 平台发布标题硬上限(中文字符)——超限工具打回自纠,不静默截断(标题是内容,截断=改意) */
const TITLE_LIMITS: Record<string, number> = {
  xiaohongshu: 20,
  douyin: 30,
  wechat_video: 22,
  bilibili: 40,
};

function buildSubmitKitTool(
  captured: { kit: Omit<VideoKit, "platform" | "generatedAt"> | null },
  platform: string,
): LoopTool {
  const titleLimit = TITLE_LIMITS[platform] ?? 30;
  return {
    name: "submit_video_kit",
    description: "提交视频发布件。所有字段必填。",
    parameters: {
      type: "object",
      properties: {
        postTitle: { type: "string", description: `平台发布标题,≤${titleLimit} 个中文字符,自带钩子` },
        caption: { type: "string", description: "平台发布文案,含话题标签,可直接粘贴" },
        storyboard: {
          type: "array",
          description: "分镜表 5-10 行,覆盖整条口播",
          items: {
            type: "object",
            properties: {
              shot: { type: "string", description: "景别/机位,如「近景怼脸」" },
              visual: { type: "string", description: "画面内容" },
              line: { type: "string", description: "对应口播句(节选 ≤30 字)" },
              overlay: { type: "string", description: "字幕/贴纸/转场提示(可空串)" },
            },
            required: ["shot", "visual", "line"],
          },
        },
        coverText: { type: "string", description: "封面大字,≤8 个中文字" },
        coverPrompt: { type: "string", description: "封面生图 prompt:竖版,画面具体,给大字留顶部空间" },
      },
      required: ["postTitle", "caption", "storyboard", "coverText", "coverPrompt"],
    },
    execute(args) {
      const postTitle = typeof args.postTitle === "string" ? args.postTitle.trim() : "";
      const caption = typeof args.caption === "string" ? args.caption.trim() : "";
      const coverText = typeof args.coverText === "string" ? args.coverText.trim() : "";
      const coverPrompt = typeof args.coverPrompt === "string" ? args.coverPrompt.trim() : "";
      const rawShots = Array.isArray(args.storyboard) ? args.storyboard : [];
      const storyboard: StoryboardShot[] = rawShots
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
        .map((s) => ({
          shot: String(s.shot ?? "").trim(),
          visual: String(s.visual ?? "").trim(),
          line: String(s.line ?? "").trim(),
          ...(typeof s.overlay === "string" && s.overlay.trim() ? { overlay: s.overlay.trim() } : {}),
        }))
        .filter((s) => s.shot && s.visual);
      if (!postTitle) return "Error: postTitle 缺失,请补全后重新调用 submit_video_kit";
      // 平台字数口径:中文 1 字,英文/数字按半字折算(平台后台普遍如此),空格不计
      const cjkCount = (postTitle.match(/[一-鿿]/g) ?? []).length;
      const otherCount = postTitle.replace(/[一-鿿]/g, "").replace(/\s/g, "").length;
      const titleChars = cjkCount + Math.ceil(otherCount / 2);
      if (titleChars > titleLimit) {
        return `Error: postTitle 超限(${titleChars} > ${titleLimit} 字),请压缩标题后重新调用——不要靠省略号硬截`;
      }
      if (!caption) return "Error: caption 缺失,请补全后重新调用 submit_video_kit";
      if (storyboard.length < 3) return "Error: storyboard 至少 3 行有效分镜,请补全后重新调用";
      if (!coverText || !coverPrompt) return "Error: coverText/coverPrompt 缺失,请补全后重新调用";
      captured.kit = { postTitle, caption, storyboard, coverText: coverText.slice(0, 12), coverPrompt };
      return "已收到发布件";
    },
  };
}

export interface VideoKitResult {
  kit: VideoKit;
  tokensUsed: number;
  /** 封面生成失败原因(封面可选,失败不阻断发布件) */
  coverError?: string;
}

/**
 * 为一篇口播稿生成视频发布件并存到 Content.videoKit。
 * generateCover=true 且生图中转已配置时,顺带生成竖版封面(失败不阻断,透出原因)。
 */
export async function prepareVideoKit(
  contentId: string,
  opts?: { generateCover?: boolean },
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop; imageImpl?: typeof generateImageViaRelay },
): Promise<VideoKitResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) throw new Error(`稿件不存在:${contentId}`);
  const platform = content.platform || "";
  if (!VIDEO_PLATFORMS.has(platform)) {
    throw new Error(`发布件只服务视频平台(抖音/视频号/小红书/B站),这篇是 ${platform || "未知平台"}`);
  }

  const [config, profile] = await Promise.all([loadEngineConfig(dataDir), loadProfile(dataDir)]);
  const rules = profile
    ? rulesForPlatform(profile, platform as never).filter((r) => !r.disabled).slice(0, 6).map((r) => `- ${r.rule}`).join("\n")
    : "";
  const audience = personaSummary(profile?.audiencePersona);

  const captured = { kit: null as Omit<VideoKit, "platform" | "generatedAt"> | null };
  const loopFn = deps?.runLoopImpl ?? runLoop;
  const writer = resolveEngineRoute(config, "writer", config.strongModel);
  const result = await loopFn(writer.config, {
    model: writer.model,
    systemPrompt:
      "你是短视频编导。给定一篇口播稿,产出发布件:平台发布文案(不是口播稿摘要,是让刷到的人停下的文案)、" +
      "分镜表(景别/画面/对应口播句/字幕提示,覆盖全稿)、竖版封面方案(大字 ≤8 字 + 生图 prompt)。" +
      `平台文案纪律:${CAPTION_RULES[platform] ?? "≤300 字,首句钩子"};发布标题 ≤${TITLE_LIMITS[platform] ?? 30} 字(独立于口播稿标题,按平台习惯重拟)。` +
      (audience ? `目标受众:${audience}。` : "") +
      (rules ? `\n创作者写作规则:\n${rules}` : "") +
      "\n完成后调用 submit_video_kit 提交。",
    userMessage: `口播稿标题:${content.title}\n\n口播稿正文:\n${content.body.slice(0, 5000)}\n\n话题标签候选:${(content.hashtags ?? []).join("、") || "(无)"}`,
    tools: [buildSubmitKitTool(captured, platform)],
    maxTurns: 3,
    logMeta: { agent: "publisher" },
  });
  if (!captured.kit) {
    throw new Error("发布件生成失败:模型未调用 submit_video_kit 提交");
  }

  const kit: VideoKit = { ...captured.kit, platform, generatedAt: new Date().toISOString() };

  // 封面(可选):竖版 3:4,走原生中转生图;未配置/失败只透出,不阻断发布件落库
  let coverError: string | undefined;
  if (opts?.generateCover) {
    try {
      const cfg = await loadWechatMpConfig(dataDir);
      if (!cfg.imageBaseUrl || !cfg.imageApiKey) {
        coverError = "生图中转未配置(publish.json wechatMp.imageBaseUrl/imageApiKey),封面跳过";
      } else {
        const imageImpl = deps?.imageImpl ?? generateImageViaRelay;
        const png = await imageImpl({
          baseUrl: cfg.imageBaseUrl,
          apiKey: cfg.imageApiKey,
          model: cfg.imageModel || "gpt-image-2",
          prompt: `${kit.coverPrompt}\n竖版封面,顶部留白放大字「${kit.coverText}」,画面简洁高对比。`,
          size: "3:4",
        });
        const imagesDir = path.join(getDataDir(dataDir), "contents", contentId, "images");
        await fs.mkdir(imagesDir, { recursive: true });
        await fs.writeFile(path.join(imagesDir, "video-cover.png"), png);
        kit.coverPath = "images/video-cover.png";
      }
    } catch (err) {
      coverError = err instanceof Error ? err.message : String(err);
    }
  }

  const updated = await updateContent(contentId, { videoKit: kit }, dataDir);
  if (!updated) throw new Error(`发布件落库失败:${contentId}`);
  return { kit, tokensUsed: result.totalTokens, ...(coverError ? { coverError } : {}) };
}
