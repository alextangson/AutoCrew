/**
 * 封面设计师(V5.6 转正):LLM 分析内容主题/情绪 → 3 个差异化的结构化设计方案。
 * 取代 prompt-builder 的正则关键词拼接(创始人反馈"思考死板"的来源之一);
 * 引擎不可用时由调用方(cover-review)降级回 prompt-builder 规则版。
 * 复用 persona 的 runLoop + submit 工具模式。
 *
 * 硬性规则源自创始人的 Gemini 封面提示词:电影感照片写实、2-8 字中文大字、
 * 粗体高对比 + 暗色叠层保可读、禁水印/浅色纯底/卡通,竖版 3:4。
 */
import { loadEngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { loadProfile, personaSummary } from "../profile/creator-profile.js";

export interface CoverDesign {
  label: "A" | "B" | "C";
  style: string;
  /** 完整英文生图 prompt(含 3:4、标题文字、全部禁止项) */
  imagePrompt: string;
  /** 封面中文大字(2-8 字) */
  titleText: string;
  layoutHint: string;
  /** 为什么这个方案能停住滑动(GUI 卡片展示) */
  designReason: string;
}

export interface CoverPlanInput {
  title: string;
  body: string;
  platform?: string;
  hasReferencePhotos: boolean;
  customTitle?: string;
}

const HARD_RULES =
  "硬性规则(每个方案的 imagePrompt 都必须包含,一条不许漏):\n" +
  '- 开头写明 "Vertical 3:4 portrait orientation cover image"\n' +
  "- 电影感照片写实(cinematic photo-realism);禁止卡通/插画/3D 渲染风\n" +
  '- 画面必须包含中文大字标题:把 titleText 原文写进 prompt,如 the Chinese text "XX" as a prominent visual element\n' +
  "- 标题排版:加粗无衬线、超大字号、高对比;文字区域压深色渐变叠层(dark gradient overlay)保证可读\n" +
  "- 禁止水印/logo/URL;禁止白色或浅色纯色背景;文字必须清晰、正确、不变形";

/** titleText 口径:2-8 个可见字符且必须含汉字(允许数字做视觉焦点) */
function titleProblem(titleText: unknown): string | null {
  if (typeof titleText !== "string") return "titleText 必须是字符串";
  const visible = titleText.replace(/\s/g, "");
  if (visible.length < 2 || visible.length > 8) return `titleText「${titleText}」须为 2-8 个字(当前 ${visible.length})`;
  if (!/[一-鿿]/.test(visible)) return "titleText 必须含中文";
  return null;
}

function designProblem(d: Record<string, unknown>): string | null {
  if (typeof d.imagePrompt !== "string" || d.imagePrompt.trim().length < 80) {
    return "imagePrompt 必须是 ≥80 字符的完整英文生图 prompt";
  }
  const t = titleProblem(d.titleText);
  if (t) return t;
  if (typeof d.layoutHint !== "string" || !d.layoutHint.trim()) return "缺 layoutHint";
  if (typeof d.designReason !== "string" || !d.designReason.trim()) return "缺 designReason";
  if (typeof d.style !== "string" || !d.style.trim()) return "缺 style";
  return null;
}

function normalizeDesign(d: Record<string, unknown>, label: "A" | "B" | "C"): CoverDesign {
  return {
    label,
    style: String(d.style),
    imagePrompt: String(d.imagePrompt),
    titleText: String(d.titleText).trim(),
    layoutHint: String(d.layoutHint),
    designReason: String(d.designReason),
  };
}

function buildPlanTool(captured: { designs: CoverDesign[] | null }): LoopTool {
  return {
    name: "submit_cover_plan",
    description: "提交 3 个封面设计方案(A/B/C 各一)。",
    parameters: {
      type: "object",
      properties: {
        designs: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              label: { type: "string", enum: ["A", "B", "C"] },
              style: { type: "string", description: "风格名,如 cinematic / minimalist / bold-impact" },
              titleText: { type: "string", description: "封面中文大字,2-8 个字,短促有力" },
              imagePrompt: { type: "string", description: "完整英文生图 prompt,含 3:4、标题文字与全部禁止项" },
              layoutHint: { type: "string", description: "版式一句话(标题位置/主体位置/叠层)" },
              designReason: { type: "string", description: "为什么能停住滑动,1-2 句中文" },
            },
            required: ["label", "style", "titleText", "imagePrompt", "layoutHint", "designReason"],
          },
        },
      },
      required: ["designs"],
    },
    execute(args) {
      const designs = args.designs;
      if (!Array.isArray(designs) || designs.length !== 3) {
        return "Error: designs 必须是恰好 3 个方案的数组,请修正后重新调用 submit_cover_plan";
      }
      const labels: Array<"A" | "B" | "C"> = ["A", "B", "C"];
      const normalized: CoverDesign[] = [];
      for (let i = 0; i < 3; i++) {
        const d = designs[i] as Record<string, unknown>;
        const problem = designProblem(d);
        if (problem) return `Error: 方案 ${labels[i]} ${problem},请修正后重新调用 submit_cover_plan`;
        normalized.push(normalizeDesign(d, labels[i]));
      }
      captured.designs = normalized;
      return "已收到 3 个设计方案";
    },
  };
}

function buildSystemPrompt(): string {
  return (
    "你是资深封面视觉设计师,为中文自媒体(小红书/视频号/抖音/公众号)设计点击率导向的封面。" +
    "你产出「设计方案」而不是直接生图:给图像模型的英文 imagePrompt + 封面中文大字 titleText" +
    "(2-8 个字,短促有力、制造好奇或冲突,不是内容摘要;主题里有关键数字就把数字放大成焦点) + " +
    "版式说明 layoutHint + 设计理由 designReason(1-2 句中文,说清为什么能停住滑动)。\n\n" +
    HARD_RULES +
    "\n\n方法:先判断内容的主题类型(人物/观点/事件/干货)与情绪,再给 3 个差异化方案:\n" +
    "A 电影海报感(戏剧光影、明暗对比) / B 极简编辑风(大留白、文字主导) / C 高冲击(饱和撞色、动感构图)。\n" +
    "构图策略:人物主题——人物中下方、标题上方留呼吸空间;观点/概念——强视觉隐喻居中,标题居中偏上;" +
    "事件——最具张力的瞬间,标题上方压暗色遮罩。\n" +
    "imagePrompt 用英文写全:构图、主体、光线、色彩、中文标题文字内容与位置、以及上面全部禁止项。\n" +
    "有创作者形象照时,人物方案要写 feature the person from the reference photo, maintaining their likeness;" +
    "没有形象照就不要虚构具体真人长相。\n" +
    "完成后调用 submit_cover_plan 提交,不要把方案写在普通回复里。"
  );
}

async function audienceLine(dataDir?: string): Promise<string> {
  try {
    const profile = await loadProfile(dataDir);
    const s = personaSummary(profile?.audiencePersona);
    return s ? `受众画像(封面要让 TA 停下):${s}\n` : "";
  } catch {
    return "";
  }
}

export async function designCoverPlan(
  input: CoverPlanInput,
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<{ designs: CoverDesign[]; tokensUsed: number }> {
  const [config, audience] = await Promise.all([loadEngineConfig(dataDir), audienceLine(dataDir)]);
  const captured = { designs: null as CoverDesign[] | null };
  const loopFn = deps?.runLoopImpl ?? runLoop;

  const result = await loopFn(config, {
    model: config.strongModel,
    systemPrompt: buildSystemPrompt(),
    userMessage:
      `内容标题:${input.title}\n` +
      `平台:${input.platform ?? "未指定"}\n` +
      `正文(节选):${input.body.slice(0, 600)}\n` +
      (input.customTitle ? `用户指定封面大字:${input.customTitle}(必须使用)\n` : "") +
      (input.hasReferencePhotos ? "已提供创作者形象照(人物方案使用参考人物)\n" : "无形象照\n") +
      audience +
      "请给出 3 个封面设计方案。",
    tools: [buildPlanTool(captured)],
    maxTurns: 3,
  });

  if (!captured.designs) {
    throw new Error("封面设计失败:模型未调用 submit_cover_plan 提交方案");
  }
  return { designs: captured.designs, tokensUsed: result.totalTokens };
}

function buildRevisionTool(captured: { design: CoverDesign | null }, label: "A" | "B" | "C"): LoopTool {
  return {
    name: "submit_cover_revision",
    description: "提交按用户反馈修订后的单个封面设计方案(完整方案,不是 diff)。",
    parameters: {
      type: "object",
      properties: {
        style: { type: "string" },
        titleText: { type: "string", description: "封面中文大字,2-8 个字" },
        imagePrompt: { type: "string", description: "修订后的完整英文生图 prompt" },
        layoutHint: { type: "string" },
        designReason: { type: "string", description: "这次改了什么、为什么,1-2 句中文" },
      },
      required: ["style", "titleText", "imagePrompt", "layoutHint", "designReason"],
    },
    execute(args) {
      const problem = designProblem(args);
      if (problem) return `Error: ${problem},请修正后重新调用 submit_cover_revision`;
      captured.design = normalizeDesign(args, label);
      return "已收到修订方案";
    },
  };
}

export async function reviseCoverDesign(
  input: { previous: CoverDesign; feedback: string; title: string; hasReferencePhotos: boolean },
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<CoverDesign> {
  const config = await loadEngineConfig(dataDir);
  const captured = { design: null as CoverDesign | null };
  const loopFn = deps?.runLoopImpl ?? runLoop;

  await loopFn(config, {
    model: config.strongModel,
    systemPrompt:
      buildSystemPrompt() +
      "\n\n当前任务是修订:保留原方案的主题与可用元素,严格按用户反馈修改;" +
      "输出完整新方案并调用 submit_cover_revision 提交(不是 submit_cover_plan)。",
    userMessage:
      `内容标题:${input.title}\n` +
      `原方案(${input.previous.label}·${input.previous.style}):\n` +
      `- 大字:${input.previous.titleText}\n` +
      `- 版式:${input.previous.layoutHint}\n` +
      `- imagePrompt:${input.previous.imagePrompt}\n` +
      (input.hasReferencePhotos ? "已提供创作者形象照\n" : "无形象照\n") +
      `\n用户反馈(必须照办):${input.feedback}\n`,
    tools: [buildRevisionTool(captured, input.previous.label)],
    maxTurns: 3,
  });

  if (!captured.design) {
    throw new Error("封面修订失败:模型未调用 submit_cover_revision 提交方案");
  }
  return captured.design;
}
