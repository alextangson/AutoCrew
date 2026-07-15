/**
 * 公众号摘要生成:一句 ≤20 字的钩子,发布时写进草稿 digest 字段。
 * 出现在分享卡片和文章列表标题下方——现在没设,微信只能截正文前 54 字兜底。
 */
import { loadEngineConfig, resolveEngineRoute, type EngineConfig } from "../../engine/config.js";
import { runLoop, type LoopOptions, type LoopResult, type LoopTool } from "../../engine/loop.js";
import { getContent, updateContent } from "../../storage/local-store.js";

type RunLoopImpl = (config: EngineConfig, options: LoopOptions) => Promise<LoopResult>;

export const DIGEST_MAX_LEN = 20;

/** 生成并保存一条 ≤20 字公众号摘要;返回保存后的摘要。 */
export async function generateAndSaveDigest(
  contentId: string,
  dataDir?: string,
  deps?: { runLoopImpl?: RunLoopImpl },
): Promise<{ digest: string }> {
  const content = await getContent(contentId, dataDir);
  if (!content) throw new Error(`稿件不存在：${contentId}`);

  const config = await loadEngineConfig(dataDir);
  const writer = resolveEngineRoute(config, "writer", config.strongModel);
  const runLoopImpl = deps?.runLoopImpl ?? runLoop;

  let digest = "";
  const submit: LoopTool = {
    name: "submit_digest",
    description: "提交一句 ≤20 字的公众号摘要钩子。",
    parameters: {
      type: "object",
      properties: { digest: { type: "string", description: "≤20 字的钩子摘要,一句话" } },
      required: ["digest"],
    },
    execute: (args) => {
      const value = typeof args.digest === "string" ? args.digest.trim() : "";
      if (!value) return JSON.stringify({ ok: false, error: "digest 不能为空" });
      digest = value.replace(/\s+/g, " ").slice(0, DIGEST_MAX_LEN);
      return JSON.stringify({ ok: true });
    },
  };

  const systemPrompt = [
    "你为公众号文章写「摘要」——出现在分享卡片和文章列表标题下方的一句钩子。",
    `硬约束:不超过 ${DIGEST_MAX_LEN} 个字,一句话,别堆标点、别含「摘要」二字。`,
    "要点:勾好奇 / 给反差 / 点利益,别复述标题、别剧透结论。写完调 submit_digest 提交。",
  ].join("\n");

  await runLoopImpl(writer.config, {
    model: writer.model,
    systemPrompt,
    userMessage: `标题：${content.title}\n\n正文（节选）：\n${content.body.slice(0, 1200)}`,
    tools: [submit],
    maxTurns: 2,
    maxTotalTokens: 8000,
    logMeta: { agent: "writer" },
  });

  if (!digest) throw new Error("模型没有产出摘要,请重试");
  const updated = await updateContent(contentId, { digest }, dataDir);
  if (!updated) throw new Error(`保存摘要失败：${contentId}`);
  return { digest };
}
