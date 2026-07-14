/**
 * 焦点范围的"问或改"原语（对话式修改的核心）。
 *
 * 和 reviseDraft 不同：这里 **不落库**——只产出一个结果（反问 或 改写提案），
 * 由对话把它交给编辑器渲染红绿 diff；真正保存走 draft:adopt_revision（收下时）。
 * scope=selection 只回改写后的这一段（span）；scope=draft 回完整 title+body。
 */
import { loadEngineConfig, resolveEngineRoute, type EngineConfig } from "../../engine/config.js";
import { runLoop, type LoopOptions, type LoopResult, type LoopTool } from "../../engine/loop.js";
import { getContent } from "../../storage/local-store.js";
import { loadProfile } from "../profile/creator-profile.js";

export type ReviseFocus =
  | { scope: "draft" }
  | { scope: "selection"; selection: string };

export type ReviseFocusResult =
  | { kind: "question"; question: string }
  | { kind: "revision"; title?: string; body?: string; span?: string };

type RunLoopImpl = (config: EngineConfig, options: LoopOptions) => Promise<LoopResult>;

export async function reviseFocus(
  contentId: string,
  instruction: string,
  focus: ReviseFocus,
  dataDir?: string,
  deps?: { runLoopImpl?: RunLoopImpl },
): Promise<ReviseFocusResult> {
  const feedback = instruction.trim();
  if (!feedback) throw new Error("缺少修改要求");

  const current = await getContent(contentId, dataDir);
  if (!current) throw new Error(`稿件不存在：${contentId}`);

  const config = await loadEngineConfig(dataDir);
  const writer = resolveEngineRoute(config, "writer", config.strongModel);
  const runLoopImpl = deps?.runLoopImpl ?? runLoop;

  let result: ReviseFocusResult | null = null;

  const questionTool: LoopTool = {
    name: "submit_question",
    description: "当用户的修改要求不够明确、无法直接下笔时，用一句话反问澄清；不要在不确定时硬改。",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "向用户澄清的一句话问题" } },
      required: ["question"],
    },
    execute: (args) => {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) return JSON.stringify({ ok: false, error: "question 不能为空" });
      result = { kind: "question", question };
      return JSON.stringify({ ok: true });
    },
  };

  const revisionTool: LoopTool =
    focus.scope === "selection"
      ? {
          name: "submit_revision",
          description: "按用户要求改写选中的这一段，提交改写后的完整段落（只这一段，不含上下文，不要省略）。",
          parameters: {
            type: "object",
            properties: { span: { type: "string", description: "改写后的完整段落文本" } },
            required: ["span"],
          },
          execute: (args) => {
            const span = typeof args.span === "string" ? args.span.trim() : "";
            if (!span) return JSON.stringify({ ok: false, error: "span 不能为空" });
            result = { kind: "revision", span };
            return JSON.stringify({ ok: true });
          },
        }
      : {
          name: "submit_revision",
          description: "按用户要求修订整篇，提交完整标题与完整正文，不要省略未改段落。",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "修改后的完整标题；无需改就原样保留" },
              body: { type: "string", description: "修改后的完整正文" },
            },
            required: ["title", "body"],
          },
          execute: (args) => {
            const title = typeof args.title === "string" ? args.title.trim() : "";
            const body = typeof args.body === "string" ? args.body.trim() : "";
            if (!title || !body) return JSON.stringify({ ok: false, error: "title 和 body 必须完整非空" });
            result = { kind: "revision", title, body };
            return JSON.stringify({ ok: true });
          },
        };

  let rules: string[] = [];
  try {
    const profile = await loadProfile(dataDir);
    rules = (profile?.writingRules ?? []).filter((rule) => !rule.disabled).map((rule) => rule.rule);
  } catch {
    // 档案不可用不应阻断一次明确的修改。
  }

  const scopeLine =
    focus.scope === "selection"
      ? "范围：只改用户选中的这一段，其余不动——但必须结合下面给的全文来改：让这一段和前后文连贯、并服务于整篇的核心问题，不要就句论句、也不要与全文重复或脱节。改完调 submit_revision 提交改写后的完整段落。"
      : "范围：修订整篇。改完调 submit_revision 提交完整标题和完整正文。";
  const systemPrompt = [
    "你是资深中文内容编辑，按用户反馈修改稿件。",
    "要求不明确、无法确定怎么改时，先调 submit_question 反问澄清一句，不要硬猜着改；要求清楚就直接改。",
    scopeLine,
    "保留没被反馈否定的事实与有效结构，不编造新事实或数据。",
    "二选一：submit_question 或 submit_revision，必须调用其中一个。",
    rules.length ? `创作者长期写作规则：\n${rules.map((rule) => `- ${rule}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userMessage =
    focus.scope === "selection"
      ? `修改要求：${feedback}\n\n【全文·仅供理解上下文，不要改动全文本身，只改下面「选中的段落」】\n标题：${current.title}\n正文：\n${current.body}\n\n【选中的段落·只改这一段，返回改写后的完整段落】\n${focus.selection}`
      : `修改要求：${feedback}\n\n原标题：${current.title}\n\n原正文：\n${current.body}`;

  await runLoopImpl(writer.config, {
    model: writer.model,
    systemPrompt,
    userMessage,
    tools: [questionTool, revisionTool],
    maxTurns: 2,
    maxTotalTokens: 30_000,
    logMeta: { agent: "writer" },
  });

  if (!result) throw new Error("模型既没有反问也没有提交修订，请重试");
  return result;
}
