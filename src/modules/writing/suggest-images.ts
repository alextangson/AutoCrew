/**
 * AI 选插图位置：读正文 → 在合适段落之间插入 [IMAGE: 画面描述] 标记 → 存新版本。
 * 只插标记、不改正文；插好后 article_images:get 会重新解析出这些位置。
 */
import { loadEngineConfig, resolveEngineRoute, type EngineConfig } from "../../engine/config.js";
import { runLoop, type LoopOptions, type LoopResult, type LoopTool } from "../../engine/loop.js";
import { getContent, updateContent, type Content } from "../../storage/local-store.js";
import { countImageMarkers } from "./image-markers.js";

type RunLoopImpl = (config: EngineConfig, options: LoopOptions) => Promise<LoopResult>;

export async function suggestImagePositions(
  contentId: string,
  dataDir?: string,
  deps?: { runLoopImpl?: RunLoopImpl },
): Promise<{ content: Content; added: number }> {
  const current = await getContent(contentId, dataDir);
  if (!current) throw new Error(`稿件不存在：${contentId}`);
  const before = countImageMarkers(current.body);

  const config = await loadEngineConfig(dataDir);
  const route = resolveEngineRoute(config, "writer", config.strongModel);
  const runLoopImpl = deps?.runLoopImpl ?? runLoop;

  let submitted: string | null = null;
  const submitTool: LoopTool = {
    name: "submit_body",
    description: "提交插好 [IMAGE: …] 标记的完整正文。",
    parameters: {
      type: "object",
      properties: { body: { type: "string", description: "插入标记后的完整正文，一字不落" } },
      required: ["body"],
    },
    execute: (args) => {
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!body) return JSON.stringify({ ok: false, error: "body 不能为空" });
      submitted = body;
      return JSON.stringify({ ok: true });
    },
  };

  const systemPrompt = [
    "你是中文新媒体配图编辑。在正文合适的段落之间插入 [IMAGE: 具体画面描述] 标记，让文章图文并茂。",
    "规则：①插 2-4 处，放在能承接上下文、值得一张图强化的地方(关键转折、数据展示、场景描写之后)；②画面描述具体可生成、不含任何文字与水印；③保留原文一字不改，只插入标记，不删不改正文；④已有的 [IMAGE:] 标记原样保留。",
    "完成后必须调用 submit_body 提交插好标记的完整正文，不要只给建议。",
  ].join("\n\n");

  await runLoopImpl(route.config, {
    model: route.model,
    systemPrompt,
    userMessage: `原正文：\n${current.body}`,
    tools: [submitTool],
    maxTurns: 2,
    maxTotalTokens: 30_000,
    logMeta: { agent: "writer" },
  });

  const body = submitted as string | null;
  if (!body) throw new Error("模型没有返回插好标记的正文，请重试");
  const added = countImageMarkers(body) - before;
  if (added <= 0) throw new Error("模型没有新增插图位置，请重试或手动加位");

  const updated = await updateContent(contentId, { body, _versionNote: `AI 选插图位置：新增 ${added} 处` }, dataDir);
  if (!updated) throw new Error(`保存失败：${contentId}`);
  return { content: updated, added };
}
