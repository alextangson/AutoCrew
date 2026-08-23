/**
 * 封面设计师(V5.6 转正):LLM 分析内容主题/情绪 → 3 个差异化的结构化设计方案。
 * 取代 prompt-builder 的正则关键词拼接(创始人反馈"思考死板"的来源之一);
 * 引擎不可用时由调用方(cover-review)降级回 prompt-builder 规则版。
 * 复用 persona 的 runLoop + submit 工具模式。
 *
 * 核心原则:内容先于风格。候选必须从文章的证据、冲突、人物和隐喻出发，
 * 媒介/构图/色彩都要真正分叉，禁止固定 A/B/C 风格三件套。
 */
import { loadEngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { loadProfile, personaSummary } from "../profile/creator-profile.js";
import { ORIENTATION_TEXT } from "../../adapters/image/relay-cover.js";
import { coverStylePrompt, type CoverStyleProfile } from "./style-profile.js";

/** 候选主比例(V5.6.1 横屏封面:B站/抖音PC 收 16:9/4:3;V5.6.4 公众号 2.35:1 超宽横幅) */
export type PrimaryAspect = "3:4" | "2.35:1" | "16:9" | "4:3";

export interface CoverDesign {
  label: "A" | "B" | "C";
  style: string;
  /** 这张图唯一的视觉点子，不是泛化风格名 */
  creativeConcept: string;
  /** 具体视觉媒介，如 documentary photo / paper collage / typographic installation */
  visualMedium: string;
  /** 主色与材质气质 */
  palette: string;
  /** 完整英文生图 prompt(含 3:4、标题文字、全部禁止项) */
  imagePrompt: string;
  /** 封面中文大字(视觉宽度 2-12) */
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
  /** 候选主比例;缺省 3:4 竖屏 */
  targetAspect?: PrimaryAspect;
  /** 创作者确认过的封面身份、材质和图层规则 */
  styleProfile?: CoverStyleProfile | null;
}

/** 模型未收齐三案时，把已通过校验的方案带给调用方，避免成功方案被整组丢弃。 */
export class PartialCoverPlanError extends Error {
  constructor(
    message: string,
    public readonly designs: CoverDesign[],
    public readonly tokensUsed: number,
  ) {
    super(message);
    this.name = "PartialCoverPlanError";
  }
}

function hardRules(aspect: PrimaryAspect): string {
  return (
    "硬性规则(每个方案的 imagePrompt 都必须包含,一条不许漏):\n" +
    `- 开头写明 "${ORIENTATION_TEXT[aspect]}"\n` +
    '- 画面必须包含中文大字标题:把 titleText 原文写进 prompt,如 the Chinese text "XX" as a prominent visual element\n' +
    "- 标题是第一视觉层级:占画面约 1/4-1/3 的面积、与其所在背景形成极高对比。读者刷公众号列表时封面只有拇指大——" +
    "先过「三秒缩略图测试」(缩到 200px 宽仍能一眼读出标题和主体)再谈艺术;刻进木头、印在角落这类融入式处理默认不及格\n" +
    "- 单一焦点:一个主视觉物件 + 最多 3 个支撑元素。铺满式陈列在小图上=什么都看不见;要敢留白\n" +
    "- 画面里出现的数字/金额/专名必须与正文逐字一致,写 imagePrompt 时把数字原样照抄并复查一遍——封面数字写错=事故\n" +
    "- 禁止水印/logo/URL;不得照搬真实品牌 UI;不得出现与主题无关的装饰性英文"
  );
}

/**
 * 视觉宽度:汉字计 1、拉丁字母/数字/标点/空格计 0.5——封面大字的约束本质是视觉占位,
 * 不是字符数。逐字罚会把中英混排(如「all in AI出海」)误判超长,是封面死循环的根因。
 */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[一-鿿㐀-䶿]/.test(ch) ? 1 : 0.5;
  return w;
}

/** titleText 口径:必须含中文 + 视觉宽度 2-12(汉字 1、字母数字 0.5);允许中英混排与数字做焦点 */
function titleProblem(titleText: unknown): string | null {
  if (typeof titleText !== "string") return "titleText 必须是字符串";
  const visible = titleText.replace(/\s/g, "");
  if (!/[一-鿿]/.test(visible)) return "titleText 必须含中文";
  const w = visualWidth(visible);
  // 上限 12:爆款钩子常带数字与短句(「$908亿的位置还空着」≈11.5),9 会把好钩子逼成文艺短语
  if (w < 2 || w > 12) {
    return `titleText「${titleText}」视觉宽度须在 2-12(汉字算 1、字母数字算 0.5,当前 ${w});太长就精简或换纯中文短词`;
  }
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
  if (/^(cinematic|minimalist(?:-editorial)?|bold-impact)$/i.test(String(d.style).trim())) {
    return "style 不能只写 cinematic/minimalist/bold-impact 这类模板名,请写与本文相关的具体艺术指导";
  }
  if (typeof d.creativeConcept !== "string" || d.creativeConcept.trim().length < 6) return "缺具体 creativeConcept";
  if (typeof d.visualMedium !== "string" || !d.visualMedium.trim()) return "缺 visualMedium";
  if (typeof d.palette !== "string" || !d.palette.trim()) return "缺 palette";
  return null;
}

function normalizeDesign(d: Record<string, unknown>, label: "A" | "B" | "C"): CoverDesign {
  return {
    label,
    style: String(d.style),
    creativeConcept: String(d.creativeConcept),
    visualMedium: String(d.visualMedium),
    palette: String(d.palette),
    imagePrompt: String(d.imagePrompt),
    titleText: String(d.titleText).trim(),
    layoutHint: String(d.layoutHint),
    designReason: String(d.designReason),
  };
}

function mediumBucket(value: string): string {
  const v = value.toLowerCase();
  if (/collage|cut.?paper|zine|scrapbook/.test(v)) return "collage";
  if (/type|letter|poster|print|stamp|signage/.test(v)) return "typography";
  if (/illustrat|drawing|ink|woodcut|comic/.test(v)) return "illustration";
  if (/diagram|data|infographic|map|blueprint/.test(v)) return "information";
  if (/photo|documentary|portrait|still.?life|macro/.test(v)) return "photography";
  if (/clay|fabric|paper sculpture|installation|miniature/.test(v)) return "physical-art";
  return v.replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

function affirmativePrompt(prompt: string): string {
  // 生图 prompt 通常会在结尾列 "No server rooms / avoid holograms"；
  // 这些是否定约束，不能反过来被当成方案真的使用了陈词滥调。
  return prompt
    .split(/[.!?。！？]+/)
    .filter((sentence) => !/^\s*(no|not|avoid|without|do not|never)\b/i.test(sentence))
    .join(" ")
    .toLowerCase();
}

function diversityProblem(designs: CoverDesign[]): string | null {
  const concepts = new Set(designs.map((d) => d.creativeConcept.toLowerCase().replace(/\s+/g, "")));
  if (concepts.size !== 3) return "三个方案的 creativeConcept 重复,必须是三个不同的视觉点子";
  const media = new Set(designs.map((d) => mediumBucket(d.visualMedium)));
  if (media.size < 2) return "三个方案媒介过于相似,至少使用两类明显不同的视觉媒介";
  const prompts = designs.map((d) => affirmativePrompt(d.imagePrompt));
  if (prompts.every((p) => /screen|laptop|server rack|hologram|neural network|circuit/.test(p))) {
    return "三个方案都依赖屏幕/服务器/全息/神经网络等 AI 陈词滥调,至少重做一张为无设备的具体隐喻";
  }
  if (prompts.every((p) => p.includes("dark gradient overlay"))) {
    return "三个方案都使用暗色渐变压字,至少重做一张为亮调、实物承字或留白排版";
  }
  return null;
}

/**
 * 平铺单方案提交,分三次调用(2026-07-12 实测裁决):嵌套 array-of-objects 参数会诱导
 * 模型把数组字符串化,imagePrompt 内含英文引号时双重转义必然间歇性翻车(一次运行 4 连败,
 * 烧光自纠回合后静默降级规则版)。平铺字段 = 单层转义,与 submit_cover_revision 同构——
 * 该工具从未翻过车。字符串化容错救不了 parse 不动的字符串,结构性消灭嵌套才是解。
 */
function buildPlanTool(captured: { designs: Map<string, CoverDesign> }): LoopTool {
  return {
    name: "submit_cover_design",
    description: "提交一个封面设计方案(A/B/C 中的一个)。分三次调用,每次只交一个方案;同 label 重复提交以最后一次为准。",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", enum: ["A", "B", "C"] },
        style: {
          type: "string",
          description:
            "与本文相关的具体艺术指导名,如 海关扣留单/纸上证物/荒诞静物;禁止只写 cinematic/minimalist/bold-impact",
        },
        creativeConcept: { type: "string", description: "一句话说清这张图独有的视觉点子/隐喻" },
        visualMedium: {
          type: "string",
          description: "具体媒介,如 documentary photography / cut-paper collage / typographic installation",
        },
        palette: { type: "string", description: "主色、明暗与材质,须与另外两张拉开" },
        titleText: {
          type: "string",
          description: "封面中文大字,视觉宽度 2-12(汉字 1、字母数字 0.5),必须是制造悬念/冲突/利益缺口的钩子",
        },
        imagePrompt: { type: "string", description: "完整英文生图 prompt,含比例、标题文字与全部禁止项" },
        layoutHint: { type: "string", description: "版式一句话(标题位置/主体位置/叠层)" },
        designReason: { type: "string", description: "为什么能停住滑动,1-2 句中文" },
      },
      required: [
        "label",
        "style",
        "creativeConcept",
        "visualMedium",
        "palette",
        "titleText",
        "imagePrompt",
        "layoutHint",
        "designReason",
      ],
    },
    execute(args) {
      const label = args.label;
      if (label !== "A" && label !== "B" && label !== "C") {
        return "Error: label 必须是 A/B/C,请修正后重新调用 submit_cover_design";
      }
      const problem = designProblem(args);
      if (problem) return `Error: 方案 ${label} ${problem},请修正后重新调用 submit_cover_design`;
      captured.designs.set(label, normalizeDesign(args, label));
      if (captured.designs.size === 3) {
        const problem = diversityProblem((["A", "B", "C"] as const).map((key) => captured.designs.get(key)!));
        if (problem) {
          captured.designs.delete(label);
          return `Error: ${problem}。请重新提交方案 ${label},让它真正与另外两张分叉`;
        }
        return "已收齐 3 个设计方案(A/B/C),且通过反模板差异校验";
      }
      const missing = (["A", "B", "C"] as const).filter((l) => !captured.designs.has(l));
      return `已收到方案 ${label},还差 ${missing.join("/")}——继续调用 submit_cover_design 提交剩余方案`;
    },
  };
}

function buildSystemPrompt(aspect: PrimaryAspect): string {
  const composition =
    aspect === "3:4"
      ? "比例提醒(竖版):保证移动端缩略图仍能一眼读懂;标题和主体可上下、对角、环绕或实物融合,不要默认标题上/主体下。"
      : aspect === "2.35:1"
        ? "比例提醒(2.35:1 公众号头图):利用横向叙事、连续物件、左右因果或单个超尺度主体;三张不能都做左图右字。"
        : "比例提醒(横版):留出平台 UI 安全边距;可用居中对称、边缘裁切、俯拍平铺或左右叙事,三张不能同构。";
  return (
    "你是有杂志、广告与纪录片经验的创意总监,为中文自媒体设计既能停住滑动、又不落入 AI 模板感的封面。" +
    "你产出「设计方案」而不是直接生图:给图像模型的英文 imagePrompt + 封面中文大字 titleText" +
    "(视觉宽度 2-12,必须是钩子——制造悬念、冲突或利益缺口,让人不点开难受;「$908亿的位置还空着」能停住滑动," +
    "「同一把铲子」这种文艺短语不能。主题里有关键数字就把数字放大成焦点) + " +
    "具体艺术指导 style + 创意点子 creativeConcept + 媒介 visualMedium + 色彩材质 palette + " +
    "版式说明 layoutHint + 设计理由 designReason(1-2 句中文,说清为什么这个点子只属于这篇内容)。\n\n" +
    hardRules(aspect) +
    "\n\n创作方法:\n" +
    "1. 先从正文提炼:一个具体证据/物件、一个核心矛盾、一个反常识判断、一个受众会代入的瞬间。\n" +
    "2. 再从以下创意引擎里按内容选择三个,不要固定映射给 A/B/C:纪实瞬间、证物/档案、荒诞静物、视觉隐喻、纸张拼贴、实体字装置、数据物理化、微缩场景、文化符号改造、人物环境肖像。\n" +
    "3. 三张必须在主视觉、媒介、构图、明暗、标题修辞上真正分叉;至少一张无屏幕/无设备;至少两张亮调高对比(信息流里暗沉低对比=隐身),暗调最多一张且标题必须极亮。\n" +
    "4. AI 题材默认禁用这些陈词滥调:发光键盘、服务器机房、蓝紫神经网络、全息代码、机器人脑、左右冷暖对半。只有正文的具体事实非用不可时才允许一张使用。\n" +
    "5. style 要像本方案的名字(例如「被海关扣下的合同」「喂料槽里的数据」「租金收据」),不能交 cinematic/minimalist/bold-impact。\n" +
    composition +
    "\nimagePrompt 用英文写全:具体场景/物件、媒介质感、镜头或制作方式、构图、光线、色彩、中文标题如何自然进入画面、以及禁止项。不要只堆风格形容词。\n" +
    "有创作者形象照时,人物方案要写 feature the person from the reference photo, maintaining their likeness;" +
    "没有形象照就不要虚构具体真人长相。\n" +
    "每个方案用 submit_cover_design 单独提交(共三次调用,A/B/C 各一次,字段平铺直传,不要把方案打包成数组或 JSON 字符串)。工具会检查模板化与差异度,被打回就换创意逻辑,不要只改形容词。"
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
  const captured = { designs: new Map<string, CoverDesign>() };
  const loopFn = deps?.runLoopImpl ?? runLoop;
  const aspect = input.targetAspect ?? "3:4";

  const result = await loopFn(config, {
    model: config.strongModel,
    systemPrompt: buildSystemPrompt(aspect),
    userMessage:
      `内容标题:${input.title}\n` +
      `平台:${input.platform ?? "未指定"}\n` +
      `封面比例:${aspect}${aspect === "3:4" ? "(竖屏)" : aspect === "2.35:1" ? "(超宽横幅)" : "(横屏)"}\n` +
      `正文(节选):${input.body.slice(0, 600)}\n` +
      (input.customTitle ? `用户指定封面大字:${input.customTitle}(必须使用)\n` : "") +
      (input.hasReferencePhotos ? "已提供创作者形象照(人物方案使用参考人物)\n" : "无形象照\n") +
      coverStylePrompt(input.styleProfile) +
      audience +
      "请先在心里完成内容洞察,再给出 3 个互不相似、无法替换到别篇文章上的封面设计方案。",
    tools: [buildPlanTool(captured)],
    // 三次提交 + 每方案留一次自纠余量
    maxTurns: 8,
    logMeta: { agent: "cover-designer" },
  });

  if (captured.designs.size !== 3) {
    const got = [...captured.designs.keys()].sort().join("/") || "无";
    const partial = (["A", "B", "C"] as const)
      .map((label) => captured.designs.get(label))
      .filter((design): design is CoverDesign => Boolean(design));
    throw new PartialCoverPlanError(
      `封面设计失败:方案未收齐(已收 ${got})——模型未完成 submit_cover_design 提交`,
      partial,
      result.totalTokens,
    );
  }
  const designs = (["A", "B", "C"] as const).map((l) => captured.designs.get(l)!);
  return { designs, tokensUsed: result.totalTokens };
}

function buildRevisionTool(captured: { design: CoverDesign | null }, label: "A" | "B" | "C"): LoopTool {
  return {
    name: "submit_cover_revision",
    description: "提交按用户反馈修订后的单个封面设计方案(完整方案,不是 diff)。",
    parameters: {
      type: "object",
      properties: {
        style: { type: "string" },
        creativeConcept: { type: "string" },
        visualMedium: { type: "string" },
        palette: { type: "string" },
        titleText: { type: "string", description: "封面中文大字,2-9 个字" },
        imagePrompt: { type: "string", description: "修订后的完整英文生图 prompt" },
        layoutHint: { type: "string" },
        designReason: { type: "string", description: "这次改了什么、为什么,1-2 句中文" },
      },
      required: [
        "style",
        "creativeConcept",
        "visualMedium",
        "palette",
        "titleText",
        "imagePrompt",
        "layoutHint",
        "designReason",
      ],
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
  input: {
    previous: CoverDesign;
    feedback: string;
    title: string;
    hasReferencePhotos: boolean;
    targetAspect?: PrimaryAspect;
    styleProfile?: CoverStyleProfile | null;
  },
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<CoverDesign> {
  const config = await loadEngineConfig(dataDir);
  const captured = { design: null as CoverDesign | null };
  const loopFn = deps?.runLoopImpl ?? runLoop;

  await loopFn(config, {
    model: config.strongModel,
    systemPrompt:
      buildSystemPrompt(input.targetAspect ?? "3:4") +
      "\n\n当前任务是修订:保留原方案的主题与可用元素,严格按用户反馈修改;" +
      "输出完整新方案并调用 submit_cover_revision 提交(不是 submit_cover_plan)。",
    userMessage:
      `内容标题:${input.title}\n` +
      `原方案(${input.previous.label}·${input.previous.style}):\n` +
      `- 创意点子:${input.previous.creativeConcept}\n` +
      `- 媒介:${input.previous.visualMedium}\n` +
      `- 色彩材质:${input.previous.palette}\n` +
      `- 大字:${input.previous.titleText}\n` +
      `- 版式:${input.previous.layoutHint}\n` +
      `- imagePrompt:${input.previous.imagePrompt}\n` +
      (input.hasReferencePhotos ? "已提供创作者形象照\n" : "无形象照\n") +
      coverStylePrompt(input.styleProfile) +
      `\n用户反馈(必须照办):${input.feedback}\n`,
    tools: [buildRevisionTool(captured, input.previous.label)],
    maxTurns: 5,
    logMeta: { agent: "cover-designer" },
  });

  if (!captured.design) {
    throw new Error("封面修订失败:模型未调用 submit_cover_revision 提交方案");
  }
  return captured.design;
}
