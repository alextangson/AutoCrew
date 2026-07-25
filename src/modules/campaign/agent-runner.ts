import { loadEngineConfig, type EngineConfig } from "../../engine/config.js";
import { runLoop, type LoopTool } from "../../engine/loop.js";
import { piAgentRuntime } from "../../agents/pi-runtime.js";
import type { AgentRuntime } from "../../agents/runtime.js";
import { getCampaign, readCampaignArtifact } from "../../storage/campaign-store.js";
import { fetchPageText } from "../../utils/fetch-page.js";
import { loadSearchConfig, searchWeb, type SearchConfig, type WebSearchResult } from "../research/search-provider.js";
import type { Campaign, CampaignArtifactKind, CampaignTask } from "./domain.js";

export interface CampaignTaskOutput {
  title: string;
  markdown: string;
  kind: CampaignArtifactKind;
  tokensUsed: number;
  runtime: AgentRuntime["kind"];
  agentSessionId?: string;
}

interface RunnerDeps {
  runtime?: AgentRuntime;
  /** Compatibility seam for existing loop-specific tests and rollback. */
  runLoopImpl?: typeof runLoop;
  configLoader?: (dataDir?: string) => Promise<EngineConfig>;
  fetchPageImpl?: typeof fetchPageText;
  searchConfigLoader?: (dataDir?: string) => Promise<SearchConfig | null>;
  searchImpl?: typeof searchWeb;
  readArtifactImpl?: typeof readCampaignArtifact;
}

function resolveRuntime(deps: RunnerDeps): AgentRuntime {
  if (deps.runtime) return deps.runtime;
  if (deps.runLoopImpl) {
    return {
      kind: "loop",
      async run(config, options) {
        return {
          ...(await deps.runLoopImpl!(config, options)),
          runtime: "loop",
        };
      },
    };
  }
  return piAgentRuntime;
}

export function sanitizeCampaignArtifact(markdown: string): string {
  return markdown
    .replace(/<(thinking|analysis)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(?:thinking|analysis)>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function campaignContext(campaign: Campaign): string {
  return [
    `项目:${campaign.name}`,
    `模式:${campaign.mode}`,
    `目标站点:${campaign.brief.targetUrl ?? "未提供"}`,
    `业务描述:${campaign.brief.businessDescription ?? "未提供"}`,
    `推广目标:${campaign.brief.goals.join("；")}`,
    `目标受众:${campaign.brief.audience ?? "未明确"}`,
    `渠道:${campaign.brief.channels.join("、")}`,
    `约束:${campaign.brief.constraints.join("；") || "无额外约束"}`,
  ].join("\n");
}

function artifactKind(task: CampaignTask): CampaignArtifactKind {
  if (task.id.includes("business-audit") || task.id.includes("market-research")) return "research";
  if (task.id.includes("message-kit") || task.channel === "content") return "content";
  if (task.id.includes("measurement")) return "report";
  return "strategy";
}

async function dependencyEvidence(
  campaign: Campaign,
  task: CampaignTask,
  dataDir: string | undefined,
  readArtifact: typeof readCampaignArtifact,
): Promise<string> {
  const blocks: string[] = [];
  for (const dependency of task.dependsOn) {
    const sourceTask = campaign.tasks.find((item) => item.id === dependency);
    const artifacts = campaign.artifacts.filter((item) => item.taskId === dependency);
    for (const artifact of artifacts) {
      const markdown = await readArtifact(campaign.id, artifact.id, dataDir);
      if (markdown) blocks.push(`## 上游产物：${sourceTask?.title ?? dependency}\n${markdown.slice(0, 12_000)}`);
    }
  }
  return blocks.join("\n\n");
}

async function businessAuditEvidence(campaign: Campaign, deps: RunnerDeps): Promise<string> {
  if (!campaign.brief.targetUrl) return "未提供站点，只能根据业务描述审计；不确定项必须列为待补证据。";
  try {
    const page = await (deps.fetchPageImpl ?? fetchPageText)(campaign.brief.targetUrl, { maxChars: 14_000 });
    return `站点标题:${page.title ?? "未知"}\n站点正文摘录:\n${page.text}`;
  } catch (err) {
    return `站点抓取失败:${err instanceof Error ? err.message : String(err)}\n不得猜测页面内容，只能基于业务描述并列出待补证据。`;
  }
}

async function marketResearchEvidence(campaign: Campaign, dataDir: string | undefined, deps: RunnerDeps): Promise<string> {
  const config = await (deps.searchConfigLoader ?? loadSearchConfig)(dataDir);
  if (!config) throw new Error("市场研究需要搜索能力：请先在设置中配置博查或 Tavily");
  const queries = [...new Set([
    `${campaign.name} alternatives competitors`,
    `${campaign.brief.audience ?? campaign.name} pain points`,
    `${campaign.brief.businessDescription ?? campaign.name} market trends`,
  ])];
  const search = deps.searchImpl ?? searchWeb;
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    for (const item of await search(query, { count: 5, dataDir, config })) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
    }
  }
  if (results.length === 0) throw new Error("市场搜索没有返回证据，任务未生成，避免凭空研究");
  return [
    `搜索词:${queries.join(" | ")}`,
    ...results.slice(0, 15).map((item, index) =>
      `${index + 1}. ${item.title}\nURL:${item.url}\n摘要:${item.snippet || "无摘要"}`,
    ),
  ].join("\n\n");
}

function rolePrompt(task: CampaignTask): string {
  return (
    `你是 AutoCrew 的 ${task.assigneeRole}。你正在执行「${task.title}」。` +
    "只基于输入中的项目资料、网页/搜索证据和上游产物工作，不得编造客户、数据、竞品能力或市场规模。" +
    "证据不足时明确写『待验证』以及需要用户补充什么。输出必须能直接交给下一位 Agent 使用。" +
    "任何外部发布、发消息、改网站、导出客户数据或付费动作都不得执行；本任务只生成本地 markdown 产物。" +
    "完成后调用 submit_campaign_artifact，不要只在普通回复里给结果。"
  );
}

export async function executeCampaignAgentTask(
  campaignId: string,
  task: CampaignTask,
  runId: string,
  dataDir?: string,
  deps: RunnerDeps = {},
): Promise<CampaignTaskOutput> {
  const campaign = await getCampaign(campaignId, dataDir);
  if (!campaign) throw new Error(`Campaign 不存在:${campaignId}`);
  if (task.requiredApproval) throw new Error(`任务需要人工审批:${task.requiredApproval}`);

  const evidence = task.id.includes("business-audit")
    ? await businessAuditEvidence(campaign, deps)
    : task.id.includes("market-research")
      ? await marketResearchEvidence(campaign, dataDir, deps)
      : await dependencyEvidence(campaign, task, dataDir, deps.readArtifactImpl ?? readCampaignArtifact);
  if (!evidence.trim()) throw new Error("上游产物缺失，拒绝无依据执行");

  const config = await (deps.configLoader ?? loadEngineConfig)(dataDir);
  const captured = { markdown: "", title: "" };
  const submitTool: LoopTool = {
    name: "submit_campaign_artifact",
    description: "提交本任务的完整本地 markdown 产物。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "产物标题" },
        markdown: { type: "string", description: "完整 markdown，必须包含结论、证据、待验证项和下一步" },
      },
      required: ["title", "markdown"],
    },
    execute(args) {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const markdown = typeof args.markdown === "string" ? sanitizeCampaignArtifact(args.markdown) : "";
      if (!title || markdown.length < 300) return "Error: 标题必填，markdown 至少 300 字符，请补全证据、结论和下一步";
      captured.title = title;
      captured.markdown = markdown;
      return "已收到 Campaign 产物";
    },
  };

  const result = await resolveRuntime(deps).run(config, {
    model: config.strongModel,
    systemPrompt: rolePrompt(task),
    userMessage: `${campaignContext(campaign)}\n\n任务说明:${task.description}\n\n可用证据:\n${evidence.slice(0, 30_000)}`,
    tools: [submitTool],
    maxTurns: 4,
    maxTotalTokens: 30_000,
    logMeta: { runId, agent: task.assigneeRole },
  });
  // 部分兼容中转会让模型直接返回完整正文而不发 tool_call。只在正文达到
  // 同一长度门槛时降级接收；短回复仍失败，避免把一句“完成了”当产物。
  const fallback = sanitizeCampaignArtifact(result.finalMessage);
  const markdown = captured.markdown || (fallback.length >= 300 ? fallback : "");
  if (!markdown) throw new Error("Agent 未提交 campaign artifact，且普通回复不足 300 字符");
  return {
    title: captured.title || task.title,
    markdown,
    kind: artifactKind(task),
    tokensUsed: result.totalTokens,
    runtime: result.runtime,
    ...(result.sessionId ? { agentSessionId: result.sessionId } : {}),
  };
}
