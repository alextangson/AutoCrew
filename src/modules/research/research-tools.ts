/**
 * 视角子运行的**出网工具带**（深调研 spec §4）：search / read_page / list_patterns。
 *
 * 单独一个文件的理由：这三把工具是「外部内容进 prompt」的唯一入口，
 * 消毒、截断、定界块、配额耗尽的话术都在这里收口——视角文件只管任务书与收束校验。
 *
 * 两条纪律：
 * 1. **不抛**：出网失败（含配额耗尽）一律变成工具返回值。配额耗尽是**预期状态**，
 *    人话原样回传让模型收束；其余故障如实说明，让模型换个思路或用现有材料收尾。
 * 2. **弃标记**：视角被 deadline 判死后立即停手——四路共享同一份 broker 配额，
 *    僵尸视角继续检索就是在偷还活着那几路的额度。
 */
import type { LoopTool } from "../../engine/loop.js";
import { matchesTopicThemes } from "../patterns/pattern-select.js";
import type { PatternCard } from "../patterns/pattern-store.js";
import { BrokerQuotaError, type PerspectiveBroker } from "./research-broker.js";
import {
  clampChars,
  externalBlock,
  sanitizeExternal,
  sanitizeUrlish,
  str,
} from "./research-prompt-kit.js";

/** 单页正文进 prompt 的上限：比 triage 的 4000 小——一路最多读 6 页，还要留给推理 */
const MAX_PAGE_CHARS = 2500;
const MAX_SNIPPET_CHARS = 200;
const MAX_TITLE_CHARS = 120;
const MAX_URL_CHARS = 160;
/** 进 prompt 的图片候选行数上限：素材是尽力而为，不值得挤占正文 */
const MAX_ASSET_LINES = 8;
/** 对标视角一次最多看几张自家拆解卡（同写稿选卡上限） */
const MAX_PATTERN_CARDS = 3;

/** 本路是否已被 deadline 弃掉 */
export interface RunState {
  abandoned: boolean;
}

const ABANDONED_MSG = "Error: 本视角已超时结束，停止检索，不要再调用任何工具。";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 出网失败的统一出口：配额耗尽是预期状态（人话原样回传），其余故障如实说明 */
function toolFailure(err: unknown, what: string): string {
  if (err instanceof BrokerQuotaError) {
    return `${err.message}。请用已经拿到的材料收束，并把没查到的部分写进 gaps。`;
  }
  return `Error: ${what}失败：${errText(err)}。可以换个思路继续，或用现有材料收束。`;
}

export function buildSearchTool(broker: PerspectiveBroker, state: RunState): LoopTool {
  return {
    name: "search",
    description: "联网搜索，返回若干候选来源（s 开头的来源 id）。要引用原文必须再 read_page 打开。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索词，一次一个具体问题" } },
      required: ["query"],
    },
    async execute(args) {
      if (state.abandoned) return ABANDONED_MSG;
      const query = str(args.query);
      if (!query) return "Error: query 不能为空";
      try {
        const res = await broker.search(query);
        if (res.results.length === 0) return `搜索「${clampChars(query, 60)}」没有结果，换个说法再试。`;
        return externalBlock([
          `搜索「${clampChars(query, 60)}」命中 ${res.results.length} 条：`,
          ...res.results.map((r) =>
            [
              `- ${r.sourceId} ${sanitizeExternal(r.title ?? "", MAX_TITLE_CHARS) || "(无标题)"}`,
              `  ${sanitizeUrlish(r.url, MAX_URL_CHARS)}`,
              `  ${sanitizeExternal(r.snippet ?? "", MAX_SNIPPET_CHARS) || "(无摘要)"}`,
            ].join("\n"),
          ),
        ]);
      } catch (err) {
        return toolFailure(err, "搜索");
      }
    },
  };
}

export function buildReadPageTool(broker: PerspectiveBroker, state: RunState): LoopTool {
  return {
    name: "read_page",
    description: "打开一个网页并返回正文（p 开头的来源 id）与该页的图片候选 id。",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "要打开的完整链接" } },
      required: ["url"],
    },
    async execute(args) {
      if (state.abandoned) return ABANDONED_MSG;
      const url = str(args.url);
      if (!url) return "Error: url 不能为空";
      try {
        const page = await broker.readPage(url);
        const assets = page.assetCandidates.slice(0, MAX_ASSET_LINES);
        return [
          `来源 id：${page.sourceId}（引用本页原文时用它）`,
          `最终地址：${sanitizeUrlish(page.finalUrl, MAX_URL_CHARS)}`,
          externalBlock([
            `标题：${sanitizeExternal(page.title ?? "", MAX_TITLE_CHARS) || "(无)"}`,
            `正文：${sanitizeExternal(page.text, MAX_PAGE_CHARS) || "(抓取为空)"}`,
            assets.length
              ? `图片候选（代码采集，只能按 id 选）：\n${assets
                  .map((a) => `- ${a.assetId} ${sanitizeUrlish(a.url, MAX_URL_CHARS)}`)
                  .join("\n")}`
              : "图片候选：(本页无)",
          ]),
        ].join("\n");
      } catch (err) {
        return toolFailure(err, "读页");
      }
    },
  };
}

/** 拆解卡是我们自己的库，但内容源自外部抓取——同样进定界块，字段上限由 pattern-store 兜底 */
function renderPatternCard(card: PatternCard): string {
  return [
    `- 《${sanitizeExternal(card.title, MAX_TITLE_CHARS)}》主题：${(card.themes ?? []).join("、")}`,
    `  钩子：${sanitizeExternal(card.hook, MAX_SNIPPET_CHARS)}`,
    `  结构：${(card.structure ?? []).map((s) => sanitizeExternal(s, 60)).join(" → ")}`,
    `  有效原因：${(card.whyItWorks ?? []).map((w) => sanitizeExternal(w, 80)).join("；")}`,
  ].join("\n");
}

/** 只读：对标视角专用。相关性口径与写稿选卡同一个函数，不另起一套 */
export function buildListPatternsTool(opts: {
  lister: () => Promise<PatternCard[]>;
  topicText: string;
}): LoopTool {
  return {
    name: "list_patterns",
    description: "读我们自己攒的同主题爆款拆解卡（只读）。先看它们，再决定要不要补搜。",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const cards = (await opts.lister())
          .filter((c) => matchesTopicThemes(c.themes ?? [], opts.topicText))
          .slice(0, MAX_PATTERN_CARDS);
        if (cards.length === 0) return "我们的拆解卡库里没有与这个选题同主题的卡，直接去搜公开内容。";
        return externalBlock([`同主题拆解卡 ${cards.length} 张：`, ...cards.map(renderPatternCard)]);
      } catch (err) {
        return `Error: 读拆解卡失败：${errText(err)}。跳过这一步，直接检索公开内容。`;
      }
    },
  };
}
