/**
 * 平台适配·LLM 版:把稿子按目标平台的表达习惯重写(不是机械套结构)。
 * 引擎/模型不可用或出错 → 落回 platform-rewrite 的机械兜底,一键适配永不空手。
 */
import { loadEngineConfig, resolveEngineRoute, type EngineConfig } from "../../engine/config.js";
import { runLoop, type LoopOptions, type LoopResult, type LoopTool } from "../../engine/loop.js";
import { adaptPlatformDraft, type SupportedPlatform, type AdaptPlatformResult } from "./platform-rewrite.js";

type RunLoopImpl = (config: EngineConfig, options: LoopOptions) => Promise<LoopResult>;

/** 各平台原生表达习惯(注入 system,让输出是平台腔而非长文照搬)。 */
const PLATFORM_GUIDE: Record<SupportedPlatform, string> = {
  xiaohongshu:
    "小红书:口语、短段、多 emoji;标题带钩子/数字/情绪;正文分点每段 1-3 行;结尾 3-8 个话题标签。偏个人体验与情绪共鸣。",
  douyin: "抖音口播/图文文案:前 3 秒即钩子,短句强节奏、口语,结尾一句互动引导;别写成长文。",
  wechat_video: "视频号口播:短、观点鲜明、有钩子与互动引导,适合读出来。",
  bilibili: "B站:可用梗与网络用语,标题可带【】标注类型,正文有信息增量、结构清楚。",
  wechat_mp: "公众号:结构化长文,小标题分节,先给结论再展开,保留论证深度。",
};

/** 把 (title, body) 按目标平台腔调重写;失败落回机械兜底。 */
export async function adaptPlatformLLM(
  title: string,
  body: string,
  tags: string[],
  platform: SupportedPlatform,
  dataDir?: string,
  deps?: { runLoopImpl?: RunLoopImpl },
): Promise<AdaptPlatformResult> {
  const guide = PLATFORM_GUIDE[platform];
  const fallback = (): AdaptPlatformResult => adaptPlatformDraft({ title, body, tags, targetPlatform: platform });
  if (!guide) return fallback();

  try {
    const config = await loadEngineConfig(dataDir);
    const writer = resolveEngineRoute(config, "writer", config.strongModel);
    const runLoopImpl = deps?.runLoopImpl ?? runLoop;

    let outTitle = "";
    let outBody = "";
    const submit: LoopTool = {
      name: "submit_adapted",
      description: "提交适配到目标平台后的完整标题与正文。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "目标平台的标题" },
          body: { type: "string", description: "目标平台原生格式的完整正文" },
        },
        required: ["title", "body"],
      },
      execute: (args) => {
        const t = typeof args.title === "string" ? args.title.trim() : "";
        const b = typeof args.body === "string" ? args.body.trim() : "";
        if (!t || !b) return JSON.stringify({ ok: false, error: "title 和 body 必须完整非空" });
        outTitle = t;
        outBody = b;
        return JSON.stringify({ ok: true });
      },
    };

    const systemPrompt = [
      "你是资深多平台内容编辑,把一篇稿子改写成目标平台的原生表达。",
      `目标平台风格:${guide}`,
      "保留核心观点与关键事实,不编造;按平台习惯重组结构与语气,不是逐句照搬原文。写完调 submit_adapted 提交。",
    ].join("\n");

    await runLoopImpl(writer.config, {
      model: writer.model,
      systemPrompt,
      userMessage: `原标题：${title}\n\n原正文：\n${body.slice(0, 6000)}`,
      tools: [submit],
      maxTurns: 2,
      maxTotalTokens: 20_000,
      logMeta: { agent: "writer" },
    });

    if (outTitle && outBody) return { ok: true, platform, title: outTitle, body: outBody, notes: ["AI 按平台腔调改写"] };
  } catch {
    // 引擎/模型故障 → 机械兜底,别让一键适配空手
  }
  return fallback();
}
