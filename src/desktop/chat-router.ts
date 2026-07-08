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
import { executeResearch } from "../tools/research.js";
import { addWritingRule, loadProfile, type CreatorProfile, type WritingRule } from "../modules/profile/creator-profile.js";
import { getTopicCandidates, type RadarItem } from "../modules/radar/topic-radar.js";
import { fetchPageText, type PageText } from "../utils/fetch-page.js";
import { searchAssets, type LibraryAssetType, type LibraryAssetView } from "../storage/library-store.js";
import { saveTopic, type Topic } from "../storage/local-store.js";
import { loadRadarSources, saveRadarSources } from "../modules/radar/topic-radar.js";
import { startGenerateScript, type StartedGeneration } from "../modules/writing/generate-script.js";
import type { ScriptRequest } from "../modules/writing/script-prompt.js";
import { emitEngineEvent } from "./event-hub.js";

export interface ChatCard {
  type: "draft" | "report" | "drafts_list" | "style" | "publish" | "publish_confirm" | "published" | "topic" | "topic_saved" | "assets";
  data: Record<string, unknown>;
}

/** §C1 上下文感知：renderer 报告用户正看着哪篇稿（只进模型上下文，不进持久历史） */
export interface ChatViewContext {
  contentId: string;
  contentTitle?: string;
  platform?: string;
}

export interface ChatProgressEvent {
  phase: "start" | "end";
  /** 原始工具名（来自模型 tool_call，模型可控字符串）。渲染层不得直接展示——展示一律用 label。 */
  tool: string;
  role: "scout" | "writer" | "review" | "analyst" | null;
  label: string;
  /** 任务归属（chatTurnHandler 注入，同 turn 事件共享）——前端任务带按此聚合 */
  runId?: string;
}

/** 工具 → 角色/人话状态（UI 状态流署名；与 cards.js 的 CREW_META 角色键一致） */
const CREW_TOOL_STATUS: Record<string, { role: ChatProgressEvent["role"]; label: string }> = {
  find_topics: { role: "scout", label: "侦察员正在扫热榜" },
  find_overseas_topics: { role: "scout", label: "侦察员正在扫海外源" },
  save_topic: { role: "scout", label: "侦察员把想法记进灵感库" },
  manage_radar_sources: { role: "scout", label: "侦察员在整理情报源" },
  push_wechat_draft: { role: "review", label: "审核员备好确认卡" },
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
  search_assets: { role: "writer", label: "编剧在翻素材库" },
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
  research?: ExecuteFn;
  addRule?: (rule: Omit<WritingRule, "createdAt">, dataDir?: string) => Promise<CreatorProfile>;
  fetchPage?: (url: string) => Promise<PageText>;
  topics?: (industry: string) => Promise<RadarItem[]>;
  libSearch?: (query: string, type?: LibraryAssetType) => Promise<LibraryAssetView[]>;
  saveTopicImpl?: typeof saveTopic;
  startGenerate?: (req: ScriptRequest, dataDir?: string) => Promise<StartedGeneration>;
}

const SYSTEM_PROMPT = `你是 AutoCrew 编辑部的总编辑，带一支数字员工团队（情报、文案、审核、发布、分析），帮创作者把「想法→成稿→发布→回流」整条链跑成默认值。你的职责：接需求派活、报进展、把关不可逆动作、答数据与状态问题。

规则：
1. 永远用工具完成实际工作（生成、查数据、记风格、发布），不要口头承诺。
2. 工具结果会以卡片形式直接呈现给用户——你的文字回复只做一句简短引导或下一步建议，不要复述卡片内容。
3. 用户给出风格反馈（如"太 AI 味""口语一点"）时，调用 add_style_rule 记录为永久偏好，并告诉用户已记住。
4. 用户给链接（对标文章、资料）时，先调用 read_url 读取内容，再基于内容写作或吸收风格——不要凭空假装读过。
5. 缺少必要信息（选题、平台）时先问清，一次只问一个问题。
6. 始终用中文，语气像靠谱的同事：简短、直接、不客套。
7. 用户问「写什么」「找选题」「最近热点」时调用 find_topics，然后从候选里挑 3 个最适合该创作者定位的，用一两句话说明各自为什么值得写。
8. 用户想找海外/国外/英文圈选题（或问某英文话题最近动态）时调用 find_overseas_topics，需要一个关键词；同样从候选里挑几个最契合定位的推荐。
9. 用户说「记下来」「存进灵感库」，或对话中聊出一个值得写的想法、用户看中某条候选时，调用 save_topic 落进灵感库——reason 必填，一句话说清为什么值得写（命中定位/对标爆款/读者追问）。存完不要顺手开写，等用户发话。
10. 推送公众号草稿箱是写操作：调用 push_wechat_draft 只会弹出确认卡，由用户亲手点「推送」执行——你不要宣称已推送，只说「已备好，等你确认」。
11. 用户贴对标文章链接（「拆解一下」「看看人家怎么写的」）时：先 read_url 读原文，拆出钩子（前 3 句怎么抓人）、结构（骨架几段、各段干什么）、CTA（结尾怎么引导），用一两句话讲给用户；值得借鉴的角度用 save_topic 入库，description 写拆解要点，reason 写「对标拆解 · <账号/来源>」。
12. 用户想加信息源/订阅某媒体/看海外内容时，调用 manage_radar_sources。加 RSS 前先 read_url 验证链接确实是 feed（内容含 <rss 或 <feed）；用户只给了网站名时，先试常见路径（/feed、/rss）验证，验证不过就说清并建议在设置·情报源里手动处理。海外源（HN/GitHub 等）用 toggle 开关即可。`;

const PLATFORM_ENUM = ["douyin", "xiaohongshu", "wechat_mp", "wechat_video", "bilibili"];
const PLATFORM_LABELS: Record<string, string> = {
  wechat_mp: "公众号", douyin: "抖音", xiaohongshu: "小红书", wechat_video: "视频号",
  bilibili: "B站", twitter: "Twitter", instagram: "Instagram", reddit: "Reddit",
};

/** "web_search: https://github.com/x/y" → "github.com" (clean source label for cards) */
function sourceDomain(s: string): string {
  const m = s.match(/https?:\/\/([^/\s]+)/);
  return m ? m[1].replace(/^www\./, "") : "海外";
}

export function buildChatTools(sink: ChatCard[], dataDir?: string, deps?: ChatToolDeps): LoopTool[] {
  const d = {
    generate: deps?.generate ?? (executeGenerate as ExecuteFn),
    rewrite: deps?.rewrite ?? (executeRewrite as ExecuteFn),
    flywheel: deps?.flywheel ?? (executeFlywheel as ExecuteFn),
    style: deps?.style ?? (executeStyle as ExecuteFn),
    content: deps?.content ?? (executeContentSave as ExecuteFn),
    publish: deps?.publish ?? (executePublish as ExecuteFn),
    research: deps?.research ?? (executeResearch as ExecuteFn),
    addRule: deps?.addRule ?? addWritingRule,
    fetchPage: deps?.fetchPage ?? ((url: string) => fetchPageText(url)),
    topics: deps?.topics ?? (async (industry: string) => getTopicCandidates(industry, dataDir)),
    libSearch: deps?.libSearch ?? ((q: string, t?: LibraryAssetType) => searchAssets(q, t, dataDir)),
    saveTopicImpl: deps?.saveTopicImpl ?? saveTopic,
    startGenerate:
      deps?.startGenerate ??
      ((req, dd) =>
        startGenerateScript(req, dd, {
          onEvent: (e) => void emitEngineEvent(e, dd).catch(() => {}),
        })),
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
      name: "find_overseas_topics",
      description:
        "海外选题：按关键词从 autocrew 自带的公开海外源（HackerNews/ProductHunt/GitHub/arXiv/HuggingFace）抓取并按热度排序候选。用户想找海外/国外/英文圈选题，或问某英文话题最近有什么时调用。需要一个关键词。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键词，英文更佳，如 'AI agent'" },
          sources: {
            type: "array",
            items: { type: "string" },
            description: "可选源子集：hackernews|producthunt|github|arxiv|huggingface，默认全部",
          },
        },
        required: ["keyword"],
      },
      execute: async (args) => {
        const a = sanitize(args);
        const res = await d.research({ ...a, ...dirParams, action: "discover", mode: "overseas", save_topics: false });
        if (!res.ok) return fail(res.error);
        const candidates = (res.candidates ?? []) as Array<Record<string, unknown>>;
        if (candidates.length === 0) return fail("海外源暂时没抓到候选，换个关键词再试");
        const mapped = candidates.map((c) => ({
          title: c.title,
          source: sourceDomain(String(c.source ?? "")),
          viralScore: c.viralScore,
          // 证据链接透传:候选卡「存灵感库」按钮与派活 brief 都要它（IA v4.2 §A2/§4）
          link: typeof c.link === "string" ? c.link : typeof c.url === "string" ? c.url : undefined,
        }));
        sink.push({ type: "topic", data: { industry: "海外 · " + String(a.keyword ?? ""), candidates: mapped } });
        return JSON.stringify({
          ok: true,
          keyword: a.keyword,
          candidates: mapped.map((m) => ({ title: m.title, source: m.source, score: m.viralScore })),
        });
      },
    },
    {
      name: "save_topic",
      description:
        "把想法/选题存入灵感库（看板第一列）。用户说「记下这个想法」「存进灵感库」，或对话中冒出值得写的选题、用户看中某条候选时调用。只入库不开写。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "选题标题，一句话" },
          reason: { type: "string", description: "为什么值得写——命中定位/对标爆款/读者追问等，一句话" },
          description: { type: "string", description: "补充描述（可选）" },
          link: { type: "string", description: "证据链接（可选，来自候选或 read_url）" },
          source: { type: "string", description: "来源：chat | radar:<源名> | overseas:<源名>，默认 chat" },
        },
        required: ["title", "reason"],
      },
      execute: async (args) => {
        const a = sanitize(args);
        const title = String(a.title ?? "").trim();
        if (!title) return fail("title 不能为空");
        let topic: Topic;
        try {
          topic = await d.saveTopicImpl(
            {
              title,
              description: typeof a.description === "string" && a.description ? a.description : title,
              tags: [],
              source: typeof a.source === "string" && a.source ? a.source : "chat",
              reason: String(a.reason ?? ""),
              ...(typeof a.link === "string" && a.link ? { link: a.link } : {}),
            },
            dataDir,
          );
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
        sink.push({ type: "topic_saved", data: { id: topic.id, title: topic.title, reason: topic.reason ?? "", source: topic.source ?? "chat" } });
        return JSON.stringify({ ok: true, id: topic.id, title: topic.title });
      },
    },
    {
      name: "generate_script",
      description:
        "开写一篇稿件（后台任务）。调用立即返回占位稿——写作在后台进行（长文约 1-3 分钟）,完成后看板卡片自动转正、任务带显示进度。需要明确的选题和目标平台。",
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
        const a = sanitize(args);
        try {
          // 后台化（契约 P1 完全体）:任务生命周期与本次对话请求解耦——对话立即回,写作照跑
          const started = await d.startGenerate(
            { topic: String(a.topic ?? ""), platform: a.platform as never, research: typeof a.research === "string" ? a.research : undefined },
            dataDir,
          );
          return JSON.stringify({
            ok: true,
            pending: true,
            contentId: started.contentId,
            note: "写作已在后台开始（约 1-3 分钟）。占位卡已在看板「在写」列,写完自动转正并出现在任务带——告诉用户去看板看,不要编造成稿内容。",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void emitEngineEvent(
            { role: "writer", kind: "run_failed", label: `编剧写稿中断：${msg.slice(0, 60)}` },
            dataDir,
          ).catch(() => {});
          return fail(msg);
        }
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
      name: "manage_radar_sources",
      description:
        "查看/添加/开关情报源。用户想配置信息源、订阅某媒体、打开海外源时调用。add_rss 前必须先用 read_url 验证链接是 RSS/Atom feed。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add_rss", "toggle"], description: "list 查看 | add_rss 加 RSS 源 | toggle 开关某源" },
          name: { type: "string", description: "add_rss:源名称" },
          url: { type: "string", description: "add_rss:RSS 链接（先 read_url 验证过）" },
          source_id: { type: "string", description: "toggle:源 id（从 list 结果里取）" },
          enabled: { type: "boolean", description: "toggle:开或关" },
        },
        required: ["action"],
      },
      execute: async (args) => {
        const a = sanitize(args);
        try {
          const current = await loadRadarSources(dataDir);
          if (a.action === "list") {
            return JSON.stringify({
              ok: true,
              sources: current.map((s) => ({ id: s.id, kind: s.kind, name: s.name, enabled: s.enabled, url: s.config.url })),
            });
          }
          if (a.action === "add_rss") {
            const name = String(a.name ?? "").trim();
            const url = String(a.url ?? "").trim();
            if (!name || !url) return fail("add_rss 需要 name 和 url");
            const saved = await saveRadarSources(
              [...current, { id: "", kind: "rss", name, enabled: true, config: { url } }],
              dataDir,
            );
            sink.push({ type: "style", data: { rule: `情报源 +「${name}」`, message: "已加入,下次扫榜生效" } });
            return JSON.stringify({ ok: true, total: saved.length });
          }
          if (a.action === "toggle") {
            const id = String(a.source_id ?? "");
            const target = current.find((s) => s.id === id);
            if (!target) return fail(`没有 id 为 ${id} 的源——先 list 查看`);
            const saved = await saveRadarSources(
              current.map((s) => (s.id === id ? { ...s, enabled: a.enabled !== false } : s)),
              dataDir,
            );
            sink.push({ type: "style", data: { rule: `情报源「${target.name}」${a.enabled !== false ? "已启用" : "已停用"}`, message: "下次扫榜生效" } });
            return JSON.stringify({ ok: true, total: saved.length });
          }
          return fail(`未知 action:${String(a.action)}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "push_wechat_draft",
      description:
        "把公众号稿件推入公众号草稿箱（写操作）。本工具只向用户弹出确认卡，不直接执行——用户点「推送」才真正推。用户要求发公众号/推草稿箱时调用。",
      parameters: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "稿件 id" },
          title: { type: "string", description: "稿件标题（展示在确认卡上）" },
        },
        required: ["content_id"],
      },
      execute: async (args) => {
        const a = sanitize(args);
        // 确认门（IA v4.2 §C3 / v3 红线:每次提交显式确认）:工具不执行,只出内嵌确认卡;
        // 用户点击后由 renderer 直连 publish:wechat_draft 通道执行,不再经过模型。
        sink.push({
          type: "publish_confirm",
          data: { contentId: String(a.content_id ?? ""), title: String(a.title ?? ""), target: "公众号草稿箱" },
        });
        return JSON.stringify({ ok: true, pending_user_confirmation: true, note: "确认卡已弹出,等用户亲手点「推送」——不要宣称已推送" });
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
    {
      name: "search_assets",
      description: "在素材库中按关键词（名称/标签）检索媒体素材（视频/图片/音频）。用户问「我有什么素材」「找个 b-roll/封面」时调用。只读。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词；留空列出全部" },
          type: { type: "string", enum: ["video", "image", "audio", "other"], description: "可选类型过滤" },
        },
      },
      execute: async (args) => {
        const a = sanitize(args);
        const query = String(a.query ?? "");
        const typeFilter = a.type === "video" || a.type === "image" || a.type === "audio" || a.type === "other" ? (a.type as LibraryAssetType) : undefined;
        try {
          const results = await d.libSearch(query, typeFilter);
          if (results.length === 0) {
            return JSON.stringify({ ok: true, total: 0, note: "素材库为空或无匹配——可在侧边栏「素材库」导入" });
          }
          // path 仅进卡片/渲染层与本地会话 JSON，不进模型上下文（compact JSON 才进）
          sink.push({ type: "assets", data: { query, assets: results.slice(0, 20) } });
          return JSON.stringify({
            ok: true,
            total: results.length,
            assets: results.slice(0, 10).map((r) => ({ name: r.name, type: r.type, tags: r.tags, missing: r.missing })),
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
  ];
}

export async function runChatTurn(params: {
  message: string;
  history?: ChatHistoryMessage[];
  dataDir?: string;
  viewContext?: ChatViewContext;
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

  // 定位摘要进 system（§C1）:总编辑说话像「你的总编辑」。只注入定位,不注入全量风格——
  // 总编辑不写稿,写手席才吃声音内核（PRD-v4 §4.3 上下文隔离）。profile 低频变化,不破前缀缓存。
  let systemPrompt = SYSTEM_PROMPT;
  try {
    const profile = await loadProfile(params.dataDir);
    if (profile?.industry) {
      const persona = profile.audiencePersona;
      systemPrompt +=
        `\n\n创作者定位：${profile.industry}` +
        (persona?.name ? `；受众：${persona.name}${persona.painPoints?.length ? `（痛点：${persona.painPoints.slice(0, 3).join("、")}）` : ""}` : "");
    }
    // 席位注入（IA v4.2）:派活、一稿多发只围绕用户开通的平台,不撒网到没开的席位
    if (profile?.platforms?.length) {
      const seats = profile.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join("、");
      systemPrompt += `\n创作者的平台席位：${seats}。派活与一稿多发只在这些平台里给建议,不要推荐用户没开通的平台;用户明确要求新平台时先建议去开通席位。`;
    }
  } catch { /* 无档案照常对话 */ }

  // 视图上下文拼进本轮 userMessage（§C1）:只发模型,不进持久历史（chat-persist 存原文）
  const ctx = params.viewContext;
  const userMessage = ctx?.contentId
    ? `【当前上下文】用户正打开稿件《${ctx.contentTitle || "无标题"}》（id: ${ctx.contentId}${ctx.platform ? `，平台: ${ctx.platform}` : ""}）——「这篇」「开头」等指代默认指它，可用 get_draft 读全文。\n\n${params.message}`
    : params.message;

  try {
    const result = await runLoop(config, {
      model: config.fastModel,
      systemPrompt,
      userMessage,
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
