/**
 * 整篇稿件修订：按用户反馈改写当前稿，原地保存为新版本。
 *
 * 和「一稿多发」不同，这里不创建新 content；同一个 contentId 的版本历史
 * 会新增一版，因此对话里说“把这篇改口语一点”能真正反映到编辑器/看板。
 */
import { loadEngineConfig, resolveEngineRoute, type EngineConfig } from "../../engine/config.js";
import { runLoop, type LoopOptions, type LoopResult, type LoopTool } from "../../engine/loop.js";
import { getContent, updateContent, type Content } from "../../storage/local-store.js";
import { loadProfile } from "../profile/creator-profile.js";

export interface ReviseDraftResult {
  content: Content;
  tokensUsed: number;
}

interface RevisionPayload {
  title: string;
  body: string;
}

type RunLoopImpl = (config: EngineConfig, options: LoopOptions) => Promise<LoopResult>;

export async function reviseDraft(
  contentId: string,
  instruction: string,
  dataDir?: string,
  deps?: { runLoopImpl?: RunLoopImpl },
): Promise<ReviseDraftResult> {
  const feedback = instruction.trim();
  if (!feedback) throw new Error("缺少修改要求");

  const current = await getContent(contentId, dataDir);
  if (!current) throw new Error(`稿件不存在：${contentId}`);

  const config = await loadEngineConfig(dataDir);
  const writer = resolveEngineRoute(config, "writer", config.strongModel);
  const runLoopImpl = deps?.runLoopImpl ?? runLoop;

  let submitted: RevisionPayload | null = null;
  const submitTool: LoopTool = {
    name: "submit_revision",
    description: "提交修改完成后的完整标题与完整正文。必须调用一次，不能只在聊天中描述修改建议。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "修改后的完整标题；无需改标题时原样保留" },
        body: { type: "string", description: "修改后的完整正文，不要省略未修改段落" },
      },
      required: ["title", "body"],
    },
    execute: (args) => {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!title || !body) {
        return JSON.stringify({ ok: false, error: "title 和 body 都必须是完整非空文本，请重新调用 submit_revision" });
      }
      submitted = { title, body };
      return JSON.stringify({ ok: true, note: "修订稿已接收" });
    },
  };

  let rules: string[] = [];
  try {
    const profile = await loadProfile(dataDir);
    rules = (profile?.writingRules ?? []).filter((rule) => !rule.disabled).map((rule) => rule.rule);
  } catch {
    // 档案不可用不应阻断一次明确的稿件修改。
  }

  const systemPrompt = [
    "你是资深中文内容编辑。按用户的明确反馈修订整篇稿件。",
    "保留原稿中没有被反馈否定的事实、论点和有效结构；不要编造新事实或数据。",
    "需要改标题时一起改；不需要时保留原标题。正文必须完整返回，禁止用省略号或“其余不变”。",
    "完成后必须调用 submit_revision 提交完整标题和完整正文，不要只给建议。",
    rules.length ? `创作者长期写作规则：\n${rules.map((rule) => `- ${rule}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const result = await runLoopImpl(writer.config, {
    model: writer.model,
    systemPrompt,
    userMessage: `修改要求：${feedback}\n\n原标题：${current.title}\n\n原正文：\n${current.body}`,
    tools: [submitTool],
    maxTurns: 2,
    maxTotalTokens: 30_000,
    logMeta: { agent: "writer" },
  });

  const revision = submitted as RevisionPayload | null;
  if (!revision) throw new Error("模型没有提交可保存的修订稿，请重试");
  if (revision.title === current.title && revision.body === current.body) {
    throw new Error("模型返回内容与原稿完全相同，没有产生修改");
  }

  const note = `AI 修改：${feedback.replace(/\s+/g, " ").slice(0, 80)}`;
  const updated = await updateContent(
    contentId,
    { title: revision.title, body: revision.body, _versionNote: note },
    dataDir,
  );
  if (!updated) throw new Error(`保存修订稿失败：${contentId}`);

  return { content: updated, tokensUsed: result.totalTokens };
}
