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
    "你是中文新媒体配图编辑。在正文合适的段落之间插入 [IMAGE: 画面描述] 标记，让文章图文并茂。配图分两种，先按内容判断该用哪种：",
    "① 解释图 —— 当这段在讲流程、步骤、循环、前后对比、层级结构、系统关系、某个机制，或要画坐标轴/象限/图表时，一张带标签的图比氛围图更能帮读者看懂。先选一个清楚的结构(左到右的流程 / 环形的循环 / 中心分支的中枢 / 左右对照的前后 / 自下而上的层级 / 四象限)，再用「标签:」列出 3-5 个要印在图里的短中文词，每个 2-6 字、具体能指向对象(用「定选题」「写初稿」「复盘」，别用「输入阶段」这种抽象词)。",
    "关键规则：凡是坐标轴名、节点名、层名、象限标注这类【必须出现在图里的文字】，一律放进「标签:」，绝不能只写进画面散文里。因为没有「标签:」的标记会被系统判成无字氛围图、反而禁止图里出现任何文字——你想要的坐标轴和标注就被压掉了(这正是常见翻车点)。例：[IMAGE: 四象限图，横轴是能否被AI替代、纵轴是需求增速，右上角高亮甜蜜点区域。标签:AI替代度、需求增速、甜蜜点] 而不是把「横轴/纵轴/甜蜜点」只写在描述里却漏掉「标签:」。",
    "② 氛围图 —— 只有当这段是纯叙事、情绪或具象场景、图里【不需要任何文字】时才用。一句具体能生成的画面，不带标签。例：[IMAGE: 深夜便利店的收银台，暖黄灯光下一杯冒热气的咖啡]",
    "通用规则：插 2-4 处，放在关键转折、数据展示、机制讲解或场景描写之后；不用写配色和画风(系统会统一处理)，你只负责画面内容和(解释图的)标签文字；保留原文一字不改，只插入标记，不删不改正文；已有的 [IMAGE:] 标记原样保留。",
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
