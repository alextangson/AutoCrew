/**
 * Chat 路由 — Agent 态对话主入口（PRD §7.3：对话是驱动层）。
 *
 * 每轮：loadEngineConfig → runLoop(fastModel, 工具集) → {reply, cards}。
 * 工具包装既有 execute*；执行成功向 sink 推一张结构化卡（呈现层直达
 * renderer），给模型只回紧凑 JSON（标题/ID/计数——正文不进对话上下文）。
 * 引擎未配置 → {ok:false, needsSetup:true}，renderer 引导去设置页。
 */
import { loadEngineConfig } from "../engine/config.js";
import { runLoop, type LoopTool, type LoopEvent } from "../engine/loop.js";
import { executeGenerate } from "../tools/generate.js";
import { executeRewrite } from "../tools/rewrite.js";
import { executeFlywheel } from "../tools/flywheel.js";
import { executeStyle } from "../tools/style.js";
import { executeContentSave } from "../tools/content-save.js";
import { executePublish } from "../tools/publish.js";
import { addWritingRule, loadProfile, type CreatorProfile, type WritingRule } from "../modules/profile/creator-profile.js";
import { getTopicCandidates, type RadarItem } from "../modules/radar/topic-radar.js";
import { fetchPageText, type PageText } from "../utils/fetch-page.js";

export interface ChatCard {
  type: "draft" | "report" | "drafts_list" | "style" | "publish" | "published" | "topic";
  data: Record<string, unknown>;
}

export interface ChatProgressEvent {
  phase: "start" | "end";
  tool: string;
  role: "scout" | "writer" | "review" | "analyst" | null;
  label: string;
}

/** 工具 → 角色/人话状态（UI 状态流署名；与 cards.js 的 CREW_META 角色键一致） */
const CREW_TOOL_STATUS: Record<string, { role: ChatProgressEvent["role"]; label: string }> = {
  find_topics: { role: "scout", label: "侦察员正在扫热榜" },
  read_url: { role: "scout", label: "侦察员正在读参考资料" },
  generate_script: { role: "writer", label: "编剧正在写稿" },
  adapt_platform: { role: "writer", label: "编剧正在适配平台版本" },
  absorb_style: { role: "writer", label: "编剧正在研究你的风格" },
  add_style_rule: { role: "writer", label: "编剧记下一条偏好" },
  list_drafts: { role: "writer", label: "编剧在翻稿件" },
  get_draft: { role: "writer", label: "编剧在查稿件" },
  publish_clipboard: { role: "review", label: "审核员正在排版检查" },
  confirm_published: { role: "review", label: "审核员盖章归档" },
  flywheel_report: { role: "analyst", label: "分析师正在拉数据" },
};

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

type ExecuteFn = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** 测试注入口 — 缺省全部用真实 execute*（镜像 buildIpcHandlers 的 deps 模式） */
export interface ChatToolDeps {
  generate?: ExecuteFn;
  rewrite?: ExecuteFn;
  flywheel?: ExecuteFn;
  style?: ExecuteFn;
  content?: ExecuteFn;
  publish?: ExecuteFn;
  addRule?: (rule: Omit<WritingRule, "createdAt">, dataDir?: string) => Promise<CreatorProfile>;
  fetchPage?: (url: string) => Promise<PageText>;
  topics?: (industry: string) => Promise<RadarItem[]>;
}

const SYSTEM_PROMPT = `你是 AutoCrew，用户的数字编剧员工，帮中文短视频创作者从选题到发布跑通全流程。

规则：
1. 永远用工具完成实际工作（生成、查数据、记风格、发布），不要口头承诺。
2. 工具结果会以卡片形式直接呈现给用户——你的文字回复只做一句简短引导或下一步建议，不要复述卡片内容。
3. 用户给出风格反馈（如"太 AI 味""口语一点"）时，调用 add_style_rule 记录为永久偏好，并告诉用户已记住。
4. 用户给链接（对标文章、资料）时，先调用 read_url 读取内容，再基于内容写作或吸收风格——不要凭空假装读过。
5. 缺少必要信息（选题、平台）时先问清，一次只问一个问题。
6. 始终用中文，语气像靠谱的同事：简短、直接、不客套。
7. 用户问「写什么」「找选题」「最近热点」时调用 find_topics，然后从候选里挑 3 个最适合该创作者定位的，用一两句话说明各自为什么值得写。`;

const PLATFORM_ENUM = ["douyin", "xiaohongshu", "wechat_mp", "wechat_video", "bilibili"];

export function buildChatTools(sink: ChatCard[], dataDir?: string, deps?: ChatToolDeps): LoopTool[] {
  const d = {
    generate: deps?.generate ?? (executeGenerate as ExecuteFn),
    rewrite: deps?.rewrite ?? (executeRewrite as ExecuteFn),
    flywheel: deps?.flywheel ?? (executeFlywheel as ExecuteFn),
    style: deps?.style ?? (executeStyle as ExecuteFn),
    content: deps?.content ?? (executeContentSave as ExecuteFn),
    publish: deps?.publish ?? (executePublish as ExecuteFn),
    addRule: deps?.addRule ?? addWritingRule,
    fetchPage: deps?.fetchPage ?? ((url: string) => fetchPageText(url)),
    topics: deps?.topics ?? (async (industry: string) => getTopicCandidates(industry, dataDir)),
  };
  const dirParams = dataDir ? { _dataDir: dataDir } : {};

  /** 模型 args 来自 tool_call，剥掉内部保留键（_ 前缀），防 _dataDir 注入 */
  const sanitize = (args: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith("_")));

  const fail = (error: unknown) => JSON.stringify({ ok: false, error: String(error ?? "未知错误") });

  return [
    {
      name: "find_topics",
      description: "选题雷达：按创作者的定位/赛道从公开热榜拉取并排序候选选题。用户问「写什么」「找选题」「最近热点」时调用。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        let industry = "科技";
        try {
          const profile = await loadProfile(dataDir);
          if (profile?.industry) industry = profile.industry;
        } catch {
          /* 无档案用默认赛道 */
        }
        let candidates: RadarItem[];
        try {
          candidates = await d.topics(industry);
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
        if (candidates.length === 0) {
          return fail("热榜暂时拉不到数据（网络或源不可用），请稍后再试或直接给我选题");
        }
        sink.push({ type: "topic", data: { industry, candidates } });
        return JSON.stringify({
          ok: true,
          industry,
          candidates: candidates.map((c) => ({ title: c.title, source: c.source })),
        });
      },
    },
    {
      name: "generate_script",
      description: "生成口播脚本并自动存为稿件。需要明确的选题和目标平台。",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "脚本选题" },
          platform: { type: "string", enum: PLATFORM_ENUM, description: "目标平台" },
          research: { type: "string", description: "参考素材（可选）" },
        },
        required: ["topic", "platform"],
      },
      execute: async (args) => {
        const res = await d.generate({ ...sanitize(args), ...dirParams, action: "script" });
        if (!res.ok) return fail(res.error);
        const data = res.data as Record<string, unknown>;
        sink.push({ type: "draft", data });
        return JSON.stringify({
          ok: true,
          contentId: data.contentId,
          title: data.title,
          violations: Array.isArray(data.violations) ? data.violations.length : 0,
        });
      },
    },
    {
      name: "adapt_platform",
      description: "把已有稿件改写适配到另一个平台（一稿多发）。",
      parameters: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "源稿件 id" },
          target_platform: { type: "string", enum: PLATFORM_ENUM, description: "目标平台" },
        },
        required: ["content_id", "target_platform"],
      },
      execute: async (args) => {
        const res = await d.rewrite({ ...sanitize(args), ...dirParams, action: "adapt_platform", save_as_draft: true });
        if (!res.ok) return fail(res.error ?? (res as Record<string, unknown>).notes);
        // rewrite 返回扁平结构（无 data 包络），新稿 id 在 content.id —— 归一成 generate 同形的 draft 卡
        const flat = res as Record<string, unknown>;
        const saved = flat.content as Record<string, unknown> | undefined;
        const data = {
          contentId: saved?.id,
          title: flat.title,
          body: flat.body,
          hashtags: flat.hashtags ?? [],
          violations: [],
          platform: flat.platform,
        };
        sink.push({ type: "draft", data });
        return JSON.stringify({ ok: true, contentId: saved?.id, title: flat.title, platform: flat.platform });
      },
    },
    {
      name: "flywheel_report",
      description: "查看回流报告：作品数、平均播放/完播率、洞察。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const res = await d.flywheel({ ...dirParams, action: "report" });
        if (!res.ok) return fail(res.error);
        const data = res.data as Record<string, unknown>;
        sink.push({ type: "report", data });
        const insights = Array.isArray(data.baselineInsights) ? data.baselineInsights.slice(0, 3) : [];
        return JSON.stringify({ ok: true, works: data.works, avgMetrics: data.avgMetrics, insights });
      },
    },
    {
      name: "list_drafts",
      description: "列出现有稿件（标题、状态、平台）。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const res = await d.content({ ...dirParams, action: "list" });
        if (!res.ok) return fail(res.error);
        const contents = (res.contents ?? []) as Array<Record<string, unknown>>;
        sink.push({ type: "drafts_list", data: { contents } });
        const compact = contents.slice(0, 10).map((c) => ({
          id: c.id, title: c.title, status: c.status, platform: c.platform,
        }));
        return JSON.stringify({ ok: true, total: contents.length, drafts: compact });
      },
    },
    {
      name: "get_draft",
      description: "按 id 查看单篇稿件详情。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "稿件 id" } },
        required: ["id"],
      },
      execute: async (args) => {
        const res = await d.content({ ...sanitize(args), ...dirParams, action: "get" });
        if (!res.ok) return fail(res.error);
        const content = res.content as Record<string, unknown>;
        sink.push({ type: "draft", data: content });
        return JSON.stringify({ ok: true, id: content.id, title: content.title, status: content.status });
      },
    },
    {
      name: "read_url",
      description: "读取一个网页链接的正文（对标文章/资料），内容可用于写作 research 或风格吸收。",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "http/https 链接" } },
        required: ["url"],
      },
      execute: async (args) => {
        const url = String(sanitize(args).url ?? "").trim();
        if (!url) return fail("缺少 url");
        try {
          const page = await d.fetchPage(url);
          const text = page.text.slice(0, 4_000); // 进对话上下文的预算上限
          // NOTE: 多次 read_url 会累积吃 runLoop 的 maxTotalTokens(20000) 预算，
          // 超限时 loop 以 stopReason=max_tokens 静默截停——预算策略 v1.5 再调。
          return JSON.stringify({
            ok: true,
            title: page.title,
            truncated: page.truncated || page.text.length > 4_000,
            text,
            ...(page.garbled ? { garbled: true } : {}),
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "absorb_style",
      description: "从用户粘贴的 1-5 条爆款/历史文案中吸收风格特征。",
      parameters: {
        type: "object",
        properties: {
          samples: { type: "array", items: { type: "string" }, description: "文案样本，1-5 条" },
        },
        required: ["samples"],
      },
      execute: async (args) => {
        const res = await d.style({ ...sanitize(args), ...dirParams, action: "absorb_samples" });
        if (!res.ok) return fail(res.error);
        // 防御性回退：executeStyle 的 ok 路径总有 data，?? res 仅兜底异常形状
        const data = (res.data ?? res) as Record<string, unknown>;
        sink.push({ type: "style", data });
        return JSON.stringify({ ok: true, summary: data.summary ?? data.message ?? "已更新风格规则" });
      },
    },
    {
      name: "add_style_rule",
      description: "把用户的风格偏好记录为永久写作规则（如：口语化、别用排比、开头直接抛结论）。",
      parameters: {
        type: "object",
        properties: { rule: { type: "string", description: "一句话规则" } },
        required: ["rule"],
      },
      execute: async (args) => {
        const text = String(args.rule ?? "").trim();
        if (!text) return fail("规则内容不能为空");
        try {
          await d.addRule({ rule: text, source: "user_explicit", confidence: 1 }, dataDir);
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
        sink.push({ type: "style", data: { rule: text, message: "已记住该偏好" } });
        return JSON.stringify({ ok: true, rule: text });
      },
    },
    {
      name: "publish_clipboard",
      description: "把稿件排版成发布文案（用户复制后到平台粘贴发布）。",
      parameters: {
        type: "object",
        properties: { content_id: { type: "string", description: "稿件 id" } },
        required: ["content_id"],
      },
      execute: async (args) => {
        const res = await d.publish({ ...sanitize(args), ...dirParams, action: "clipboard" });
        if (!res.ok) return fail(res.error);
        const data = res.data as Record<string, unknown>;
        sink.push({ type: "publish", data: { ...data, contentId: args.content_id } });
        return JSON.stringify({ ok: true, contentId: args.content_id });
      },
    },
    {
      name: "confirm_published",
      description: "用户确认已在平台发布后，把稿件标记为已发布。",
      parameters: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "稿件 id" },
          publish_url: { type: "string", description: "发布链接（可选）" },
        },
        required: ["content_id"],
      },
      execute: async (args) => {
        const res = await d.publish({ ...sanitize(args), ...dirParams, action: "confirm_published" });
        if (!res.ok) return fail(res.error);
        sink.push({ type: "published", data: { contentId: args.content_id } });
        return JSON.stringify({ ok: true, contentId: args.content_id });
      },
    },
  ];
}

export async function runChatTurn(params: {
  message: string;
  history?: ChatHistoryMessage[];
  dataDir?: string;
  deps?: ChatToolDeps;
  fetchImpl?: typeof fetch;
  onEvent?: (e: ChatProgressEvent) => void;
}): Promise<Record<string, unknown>> {
  let config;
  try {
    config = await loadEngineConfig(params.dataDir);
  } catch (err) {
    return { ok: false, needsSetup: true, error: err instanceof Error ? err.message : String(err) };
  }

  const cards: ChatCard[] = [];
  const tools = buildChatTools(cards, params.dataDir, params.deps);

  try {
    const result = await runLoop(config, {
      model: config.fastModel,
      systemPrompt: SYSTEM_PROMPT,
      userMessage: params.message,
      history: params.history ?? [],
      tools,
      maxTurns: 6,
      ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
      onEvent: params.onEvent
        ? (e: LoopEvent) => {
            const meta = CREW_TOOL_STATUS[e.tool] ?? { role: null, label: "正在处理" };
            params.onEvent!({ phase: e.type === "tool_start" ? "start" : "end", tool: e.tool, role: meta.role, label: meta.label });
          }
        : undefined,
    });
    return {
      ok: true,
      data: { reply: result.finalMessage, cards, tokensUsed: result.totalTokens },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
