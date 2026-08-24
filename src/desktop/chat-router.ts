/**
 * Chat 路由 — Agent 态对话主入口（PRD §7.3：对话是驱动层）。
 *
 * 每轮：loadEngineConfig → runLoop(fastModel, 工具集) → {reply, cards}。
 * 工具包装既有 execute*；执行成功向 sink 推一张结构化卡（呈现层直达
 * renderer），给模型只回紧凑 JSON（标题/ID/计数）。例外：get_draft 回全文
 * 正文——总编辑要能读稿才能讨论；工具结果只活在本轮 loop，不进持久历史。
 * 引擎未配置 → {ok:false, needsSetup:true}，renderer 引导去设置页。
 */
import { loadEngineConfig, type EngineConfig } from "../engine/config.js";
import { runLoop, type LoopTool, type LoopEvent, type LoopStreamEvent } from "../engine/loop.js";
import { cleanErrorMessage } from "./error-clean.js";
import { executeGenerate } from "../tools/generate.js";
import { executeRewrite } from "../tools/rewrite.js";
import { executeFlywheel } from "../tools/flywheel.js";
import { executeStyle } from "../tools/style.js";
import { executeContentSave } from "../tools/content-save.js";
import { executePublish } from "../tools/publish.js";
import { executeResearch } from "../tools/research.js";
import { addWritingRule, loadProfile, personaSummary, goalSummary, type CreatorProfile, type WritingRule } from "../modules/profile/creator-profile.js";
import { getGoal, setGoal } from "../modules/profile/goal.js";
import { generateAudiencePersonaProposal, savePersonaCalibrated } from "../modules/profile/persona.js";
import { reviewAudienceStay } from "../modules/review/audience-review.js";
import { scoutInspiration } from "../modules/research/scout-search.js";
import { prepareVideoKit } from "../modules/publish/video-kit.js";
import { getTopicCandidates, type RadarItem } from "../modules/radar/topic-radar.js";
import { fetchPageText, type PageText } from "../utils/fetch-page.js";
import { searchAssets, type LibraryAssetType, type LibraryAssetView } from "../storage/library-store.js";
import { getDataDir, getTopic, saveTopic, updateTopic, listSiblings, type Topic } from "../storage/local-store.js";
import { loadLatestBrief, type AngleCard, type ResearchBrief } from "../modules/research/brief-store.js";
import { activeAngleCard, angleCardsOf, findAngleCard } from "../modules/research/angle-cards.js";
import { topicHashOf } from "../modules/research/research-job-store.js";
import { loadRadarSources, saveRadarSources } from "../modules/radar/topic-radar.js";
import { startGenerateScript, retryGenerateScript, type StartedGeneration } from "../modules/writing/generate-script.js";
import { videoBuildStartHandler } from "./video-handlers.js";
import { reviseDraft, type ReviseDraftResult } from "../modules/writing/draft-revision.js";
import { reviseFocus, type ReviseFocus, type ReviseFocusResult } from "../modules/writing/revise-focus.js";
import type { ScriptRequest } from "../modules/writing/script-prompt.js";
import { emitEngineEvent } from "./event-hub.js";
import { triggerDeepResearch } from "./research-runtime.js";
import { makeEnsureBrief } from "./write-research-gate.js";
import { listGuiSkills, type GuiSkill } from "./skills-reader.js";
import { buildWorkspaceTools, type WorkspaceToolDeps } from "./chat-tools-workspace.js";
import { claimJob, releaseJob, holdJobUntilSettled, GENERATE_JOB_KEY } from "./job-claims.js";
import { readRecentActions, recentActionsBlock } from "./recent-actions.js";
import { viewContextLine, type ChatViewContext } from "./chat-view-context.js";
import type { TriggerResult } from "../modules/research/research-runner.js";

export interface ChatCard {
  type:
    | "draft" | "report" | "drafts_list" | "style" | "publish" | "publish_confirm" | "published" | "topic"
    | "topic_saved" | "assets" | "persona" | "audience_review" | "video_kit" | "revision_proposal" | "focus_cleared"
    // Phase 2 到达面：封面/配图投递回执、看板流转、发布前检查、活动/收件箱/版本只读查询
    | "cover_job" | "article_images_job" | "content_moved" | "pre_publish" | "campaigns" | "inbox" | "versions"
    // 角度候选卡（角度卡 spec §1.6）：写稿闸口不接单时回它，让创始人点选/改写/手写/直写
    | "angle_cards";
  data: Record<string, unknown>;
}

/**
 * §C1 上下文感知：renderer 报告用户正看着哪（只进模型上下文，不进持久历史）。
 * 类型与校验都住在 chat-view-context.ts，这里只转出口，老 import 路径不动。
 */
export type { ChatViewContext } from "./chat-view-context.js";

export interface ChatProgressEvent {
  phase: "start" | "end";
  /** 原始工具名（来自模型 tool_call，模型可控字符串）。渲染层不得直接展示——展示一律用 label。 */
  tool: string;
  /** editor = 剪辑师（视频生产线入职，视频 spec §8.4），与 EngineEventRole 同一套席位名 */
  role: "scout" | "writer" | "review" | "analyst" | "publisher" | "editor" | null;
  label: string;
  /** 任务归属（chatTurnHandler 注入，同 turn 事件共享）——前端任务带按此聚合 */
  runId?: string;
}

/**
 * 流式正文事件（对话控制面设计 §Phase 3）——turnId/seq 由上层（chatTurnHandler）补齐后广播。
 * delta = 正文增量；reset = 新 attempt 开始，作废本轮已累积的增量；done = 本轮流结束，等 invoke 全量覆盖。
 */
export interface ChatDeltaEvent {
  ev: "delta" | "reset" | "done";
  text?: string;
}

/** 工具 → 角色/人话状态（UI 状态流署名；与 cards.js 的 CREW_META 角色键一致）。导出供覆盖断言。 */
export const CREW_TOOL_STATUS: Record<string, { role: ChatProgressEvent["role"]; label: string }> = {
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
  generate_persona: { role: "analyst", label: "分析师在推导受众画像" },
  save_persona: { role: "analyst", label: "分析师把校准后的画像归档" },
  set_goal: { role: "analyst", label: "分析师把目标记进档案" },
  get_goal: { role: "analyst", label: "分析师在对照目标" },
  audience_review: { role: "review", label: "审核员代入受众画像审稿" },
  scout_inspiration: { role: "scout", label: "侦查员出去搜灵感了" },
  prepare_video_kit: { role: "publisher", label: "发布员在备发布件" },
  build_video: { role: "editor", label: "剪辑师在起成片构建" },
  revise_draft: { role: "writer", label: "编剧正在按你的意见修改稿件" },
  revise_focus: { role: "writer", label: "编剧正在改这段" },
  clear_revision_focus: { role: "writer", label: "编剧退出修改模式" },
  deep_research: { role: "scout", label: "调研员在派四视角深调研" },
  read_skill: { role: null, label: "总编辑在翻工作手册" },
  // Phase 2 到达面（角色按现有席位语义选：封面/配图是 publisher 的活——两条产线的引擎事件
  // 本来就以 publisher 席位发；流转与预检是 review 的关卡；活动/经营只读归 analyst；
  // 收件箱是情报入口归 scout；版本是稿件本身，归 writer）
  create_cover: { role: "publisher", label: "封面设计师在出候选图" },
  generate_article_images: { role: "publisher", label: "发布员在补正文配图" },
  move_content: { role: "review", label: "审核员在挪看板卡" },
  pre_publish_check: { role: "review", label: "审核员在跑发布前检查" },
  list_campaigns: { role: "analyst", label: "分析师在翻增长活动" },
  campaign_status: { role: "analyst", label: "分析师在查活动进度" },
  list_inbox: { role: "scout", label: "侦察员在翻灵感收件箱" },
  retry_inbox: { role: "scout", label: "侦察员把这条重新排队" },
  list_versions: { role: "writer", label: "编剧在翻版本历史" },
};

/**
 * 备用模型接管的进度条状态（引擎 LoopEvent "fallback" 的人话版）。
 * tool 位不是模型给的工具名,而是这个保留标记——渲染层只展示 label,这里只做归类。
 */
export const FALLBACK_STATUS_TOOL = "__fallback__";
export const FALLBACK_STATUS_LABEL = "主模型接不上，备用 DeepSeek 顶上了";

/**
 * 引擎事件 → 聊天进度条事件。备用模型接管走 phase:"start"（dock 的状态条只收 start），
 * 红线：切换绝不静默——用户必须看得见这轮是备用模型顶上的。
 */
export function chatProgressEvent(e: LoopEvent): ChatProgressEvent {
  if (e.type === "fallback") {
    return { phase: "start", tool: FALLBACK_STATUS_TOOL, role: null, label: FALLBACK_STATUS_LABEL };
  }
  const meta = CREW_TOOL_STATUS[e.tool] ?? { role: null, label: "正在处理" };
  return { phase: e.type === "tool_start" ? "start" : "end", tool: e.tool, role: meta.role, label: meta.label };
}

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

// ── 对话模型档位（右栏切换器）────────────────────────────────────────────────

/** 缺省 fast = 今天的行为；fallback_* 直接点名备用端点（engine.json 的 fallback 块）。 */
export type ChatModelChoice = "fast" | "strong" | "fallback_fast" | "fallback_strong";

/** 引擎默认档（四档）：`{id, model, tier}` */
export interface ChatModelTierOption {
  id: ChatModelChoice;
  /** 用户自己配的真实模型名——选择器显示它,不显示抽象档位代号 */
  model: string;
  /** 档位字（快/强/备用快/备用强） */
  tier: string;
}

/** 用户自定义端点 × 模型：`{id:"p:<pid>:<model>", model, group:端点名}`，前端按 group 分组 */
export interface ChatModelProviderOption {
  id: string;
  model: string;
  /** optgroup 标题 = 端点显示名 */
  group: string;
}

export type ChatModelOption = ChatModelTierOption | ChatModelProviderOption;

/** 选项 id 前缀：自定义端点走 `p:<providerId>:<model>`（providerId 字符集禁冒号，前两个冒号定界） */
const PROVIDER_CHOICE_PREFIX = "p:";

/**
 * 可选档位清单。**只有模型名与端点显示名**——apiKey/baseUrl 一个字节都不出主进程
 * （这个清单要经 IPC 到渲染层）。未配备用端点时只有主端点两档；
 * 自定义端点按 端点 × 模型 追加在四档之后（设计 §Phase 4）。
 */
export function chatModelOptions(config: EngineConfig): ChatModelOption[] {
  const options: ChatModelOption[] = [
    { id: "fast", model: config.fastModel, tier: "快" },
    { id: "strong", model: config.strongModel, tier: "强" },
  ];
  const fb = config.fallback;
  if (fb) {
    options.push({ id: "fallback_fast", model: fb.fastModel, tier: "备用快" });
    options.push({ id: "fallback_strong", model: fb.strongModel, tier: "备用强" });
  }
  for (const provider of config.providers ?? []) {
    for (const model of provider.models) {
      options.push({ id: `${PROVIDER_CHOICE_PREFIX}${provider.id}:${model}`, model, group: provider.name });
    }
  }
  return options;
}

/**
 * `p:<providerId>:<model>` → 本轮的 {config, model}。
 * 解析按**前两个冒号**定界：providerId 字符集不含冒号，剩余整体是 model（模型名可含冒号）。
 * 以顶层 config 为基底只覆盖 baseUrl/apiKey/protocol —— dataDir 必须留住（run-log 的落点）。
 */
function resolveProviderChoice(config: EngineConfig, choice: string): ChatModelResolution {
  const rest = choice.slice(PROVIDER_CHOICE_PREFIX.length);
  const cut = rest.indexOf(":");
  const providerId = cut < 0 ? "" : rest.slice(0, cut);
  const model = cut < 0 ? "" : rest.slice(cut + 1);
  const provider = (config.providers ?? []).find((p) => p.id === providerId);
  if (!provider || !model || !provider.models.includes(model)) {
    return {
      ok: false,
      error: `该模型未配置：找不到端点「${cleanErrorMessage(providerId, 40)}」的模型「${cleanErrorMessage(model, 40)}」——它可能已在设置里被删掉，请在对话框的模型选择器里重选`,
    };
  }
  const picked: EngineConfig = {
    ...config,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    protocol: provider.protocol,
  };
  delete picked.fallback; // 用户点名了端点，没有"点名端点的备用"
  return { ok: true, config: picked, model };
}

export type ChatModelResolution =
  | { ok: true; config: EngineConfig; model: string }
  | { ok: false; error: string };

/**
 * 档位 → 本轮实际用的 {config, model}。三条纪律：
 * 1. 缺省/"fast" 字面等于今天（主端点快档，引擎级 fallback 链照常兜底）。
 * 2. 用户点名备用端点时，这次调用**不再带二级 fallback**——他要的就是这个端点，
 *    打不通就如实报错，不许再悄悄绕回主端点。
 * 3. 非法值、或点了备用但根本没配备用：显式报错，绝不静默降级到别的模型
 *    （"我选了 opus，它却拿 flash 写了"是最贵的那种静默失败）。
 * 4. `p:*`（自定义端点）与 fallback_* 同一条规矩：点名即无兜底链。
 */
export function resolveChatModel(config: EngineConfig, choice?: string): ChatModelResolution {
  if (choice === undefined || choice === "fast") return { ok: true, config, model: config.fastModel };
  if (choice === "strong") return { ok: true, config, model: config.strongModel };
  if (choice.startsWith(PROVIDER_CHOICE_PREFIX)) return resolveProviderChoice(config, choice);
  if (choice !== "fallback_fast" && choice !== "fallback_strong") {
    return { ok: false, error: `该模型未配置：不认识的档位「${cleanErrorMessage(choice, 40)}」——请在对话框的模型选择器里重选` };
  }
  const fb = config.fallback;
  if (!fb) {
    return { ok: false, error: "该模型未配置：engine.json 里没有备用端点（fallback），请先在配置里补上再选它" };
  }
  const picked: EngineConfig = {
    ...config,
    baseUrl: fb.baseUrl,
    apiKey: fb.apiKey,
    protocol: fb.protocol,
    strongModel: fb.strongModel,
    fastModel: fb.fastModel,
  };
  delete picked.fallback; // 点名备用后没有"备用的备用"
  return { ok: true, config: picked, model: choice === "fallback_fast" ? fb.fastModel : fb.strongModel };
}

type ExecuteFn = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** 测试注入口 — 缺省全部用真实 execute*（镜像 buildIpcHandlers 的 deps 模式） */
export interface ChatToolDeps extends WorkspaceToolDeps {
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
  retryGenerate?: (
    contentId: string,
    dataDir?: string,
    override?: Partial<ScriptRequest>,
  ) => Promise<StartedGeneration>;
  reviseDraftImpl?: (contentId: string, instruction: string, dataDir?: string) => Promise<ReviseDraftResult>;
  reviseFocusImpl?: (contentId: string, instruction: string, focus: ReviseFocus, dataDir?: string) => Promise<ReviseFocusResult>;
  deepResearch?: (topicId: string, dataDir?: string) => Promise<TriggerResult>;
  buildVideo?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface ChatEffects {
  contentIds: Set<string>;
}

const SYSTEM_PROMPT = `你是 AutoCrew 编辑部的总编辑，带一支数字员工团队（情报、文案、审核、发布、分析），帮创作者把「想法→成稿→发布→回流」整条链跑成默认值。你的职责：接需求派活、报进展、把关不可逆动作、答数据与状态问题。

规则：
1. 永远用工具完成实际工作（生成、查数据、记风格、发布），不要口头承诺。
2. 工具结果会以卡片形式直接呈现给用户——你的文字回复只做一句简短引导或下一步建议，不要复述卡片内容。
3. 用户针对当前稿件给修改反馈（如“这篇太 AI 味”“开头口语一点”“删掉第三段”）时，必须调用 revise_draft 修改并保存当前稿件，不能只口头答应；若反馈同时是长期偏好，再调用 add_style_rule 记录。只有与具体稿件无关的通用偏好才只调用 add_style_rule。
3.5 但当存在「当前修改焦点」时（用户在编辑器选了一段或点了改整篇），焦点范围内的修改意见一律改走 revise_focus（不是 revise_draft）：要求不明确先反问澄清一句、别硬改；revise_focus 返回问题时，把问题原样问用户、等回答；它的改动是提案不直接保存，改完提示用户在编辑器看红绿 diff、满意点「收下这版」。
3.6 焦点你自己就能退：用户说「不改这段了／直接改整篇／取消」，或这轮要求明显超出焦点范围（改别的稿、整篇重写、写新的）时，调用 clear_revision_focus 退出，同一轮接着用 revise_draft、generate_script 等常规工具把事办完——绝不要让用户去编辑器里点什么、取消选区、再回来说「好了」。用户想自己退的出口只有两个：对话顶部「正在改」那条的 ×，或编辑器里「修改模式」窄条/修改提案卡上的「退出修改」按钮；只在他主动问怎么退时才提这句。
4. 用户给链接（对标文章、资料）时，先调用 read_url 读取内容，再基于内容写作或吸收风格——不要凭空假装读过。
5. 缺少必要信息（选题、平台）时先问清，一次只问一个问题。
6. 始终用中文，语气像靠谱的同事：简短、直接、不客套。
7. 用户问「写什么」「找选题」「最近热点」时调用 find_topics，然后从候选里挑 3 个最适合该创作者定位的，用一两句话说明各自为什么值得写。
8. 用户想找海外/国外/英文圈选题（或问某英文话题最近动态）时调用 find_overseas_topics，需要一个关键词；同样从候选里挑几个最契合定位的推荐。
9. 用户说「记下来」「存进灵感库」，或对话中聊出一个值得写的想法、用户看中某条候选时，调用 save_topic 落进灵感库——reason 必填，一句话说清为什么值得写（命中定位/对标爆款/读者追问）。存完不要顺手开写，等用户发话。
10. 推送公众号草稿箱是写操作：调用 push_wechat_draft 只会弹出确认卡，由用户亲手点「推送」执行——你不要宣称已推送，只说「已备好，等你确认」。
11. 用户贴对标文章链接（「拆解一下」「看看人家怎么写的」）时：先 read_url 读原文，拆出钩子（前 3 句怎么抓人）、结构（骨架几段、各段干什么）、CTA（结尾怎么引导），用一两句话讲给用户；值得借鉴的角度用 save_topic 入库，description 写拆解要点，reason 写「对标拆解 · <账号/来源>」。
12. 用户想加信息源/订阅某媒体/看海外内容时，调用 manage_radar_sources。加 RSS 前先 read_url 验证链接确实是 feed（内容含 <rss 或 <feed）；用户只给了网站名时，先试常见路径（/feed、/rss）验证，验证不过就说清并建议在设置·情报源里手动处理。海外源（HN/GitHub 等）用 toggle 开关即可。
13. 受众画像是选题、写作、审稿共用的标准。用户要「校准受众/画像」或画像缺失、未校准时：generate_persona 出提案 → 带用户逐层过（名字/焦虑/痛点准不准）→ 用户认可后 save_persona 落库。未经用户确认绝不保存；画像未校准时主动提一句（一次就好，别唠叨）。
14. 用户问「这篇受众会怎么看」「能留住人吗」或要求审稿时，调用 audience_review（稿件 id 在上下文里）。讲结果时按层说人话：谁会停、谁会划走、卡在哪句——引导用户框选那一段直接改。
15. 用户要「主动搜/去找找/全网搜一下 X」或想按定位补充灵感时，调用 scout_inspiration（可带 query，不带则按定位+画像自动生成搜索词）。搜索未配置时把报错原样告诉用户（去设置配 key），不要假装搜过。
16. 用户粘贴一大段自己写过的文案时，先问一句用途：是「学我的风格」（→ absorb_style）还是「里面有想法要入灵感库」（→ 提炼观点后 save_topic，reason 注明来自用户旧文）；两者都要就都做。不要不问就默认其一。
17. 视频稿（抖音/视频号/小红书/B站）要发布时，先调用 prepare_video_kit 备发布件：平台发布文案+分镜表+竖版封面。口播稿是「读的」，发布件才是「发的」——不要把口播稿当发布文案。备好后引导用户看卡片，粘贴发布走 publish_clipboard。
18. 用户说「/goal …」「我的目标是…」「这个季度要…」时调用 set_goal 记录（目标会注入选题、写作、复盘全链，旧目标自动留档）；问目标或要对照进展时用 get_goal。有目标后，选题推荐与建议围绕目标排优先级，明显偏航时提醒一句。
19. 用户说「深入调研/深调研某个选题」「多找点材料再写」时调用 deep_research，参数是灵感库选题编号（还没入库先 save_topic）。它是**异步任务，投递即返回**：回执任务状态（新任务已派下去／已经在跑，进度在选题卡上看）就结束本轮，不要等它跑完，更不要凭空复述简报内容；简报出来后写这条选题会自动带上。
20. 用户说「剪成片」「把这篇做成视频」「开始剪」时调用 build_video 投递给剪辑师（稿件须已过审、且是视频平台，A-roll 要先拍好并挂进稿件素材）。这是后台任务：投完就告诉用户去成片卡看进度，不要在对话里等、更不要宣称已剪好。转写完成后需要用户亲手在成片卡里勾选分句、审片确认——这两步是人的活，你只负责投递和答状态。
21. 用户要封面/正文配图时调用 create_cover / generate_article_images。两者都是**异步投递即返回**：回执「已派下去，进度看卡」就结束本轮，不要等图、不要描述你没见过的图。工具回「已在跑」时照实说，别重复派活；封面选哪张是用户亲手在封面卡上点的。
22. 用户说「送审」「打回重写」「挪到待审」时调用 move_content——它只管在写与待审之间这几步。**待发布/已发布不归对话管**：用户说要发布时，引导他去工作区稿件卡上亲手确认，别承诺代发。
23. 用户问「能发了吗」「帮我检查一下」时调用 pre_publish_check（只读，不改状态、不发布）：挑没过的两三项用人话讲清楚怎么改；全过了也只说「检查通过，去工作区点发布」。
24. 用户问增长活动进度时用 list_campaigns（全部）/ campaign_status（单个），都是只读；创建活动、推进活动、改自治档位一律引导去工作区增长面板。
25. 用户问收件箱（转发进来的链接消化了没）时用 list_inbox；某条失败要重试用 retry_inbox——worker 没在跑时工具会照实说，原样转达，不要假装重试成功。问「改过几版」用 list_versions，回滚要用户去编辑器版本面板亲手点。
26. 用户提到某篇既有稿件（「抖音那篇」「上次发的」「之前写的 XX」）而上下文里没有它的 id 时，先调用 list_drafts 带关键词/平台/状态筛选自己找——绝不开口向用户要稿件 id 或看板位置；筛完命中多篇拿不准，列出候选标题让用户挑即可。
27. generate_script 回 needsAngle 时说明这条选题有调研出的角度候选、还没定角度：把每张卡的切入点与核心论点用人话念给用户听（一两句一张），然后等他拍板——**绝不替用户选**，角度是他的品味不是你的判断。他挑了某张就带 angle_id 重调；他自己说了个角度就把**原话**放进 direction；他明说「直接写/别选角度」才把那句原话放进 skip_reason 重调。这三样都没有就别重调，等他说话。`;

const PLATFORM_ENUM = ["douyin", "xiaohongshu", "wechat_mp", "wechat_video", "bilibili", "twitter", "reddit", "toutiao"];
const PLATFORM_LABELS: Record<string, string> = {
  wechat_mp: "公众号", douyin: "抖音", xiaohongshu: "小红书", wechat_video: "视频号",
  bilibili: "B站", twitter: "X (Twitter)", instagram: "Instagram", reddit: "Reddit", toutiao: "头条",
};

/** 平台表达习惯:派生/改写到该平台时注入,让输出是平台原生腔调而非机械套原文结构。 */
const PLATFORM_VOICE: Record<string, string> = {
  twitter: "X/Twitter 偏观点输出:首行即钩子、短、金句密度高、少铺陈论证——一条立得住的判断胜过完整论述,长了拆 thread。",
};

/** "web_search: https://github.com/x/y" → "github.com" (clean source label for cards) */
function sourceDomain(s: string): string {
  const m = s.match(/https?:\/\/([^/\s]+)/);
  return m ? m[1].replace(/^www\./, "") : "海外";
}

/**
 * 兜底文案（设计 §Phase 3）：中止分支必须排在其它兜底之前——
 * 用户按了停止却看到「任务已完成」是彻头彻尾的误报。
 * 「中止 ≠ 取消」：已投递的后台任务继续跑，文案不得暗示它们停了（前端另附一行提示）。
 */
function visibleChatReply(raw: string, cards: ChatCard[], toolCallCount: number, stopReason?: string): string {
  const reply = raw.trim();
  if (reply && reply !== "(no content)") return reply;
  if (stopReason === "aborted") return cards.length > 0 ? "已停，以下是已完成的部分。" : "已停。";
  if (cards.length > 0) return "任务已完成，结果见下方卡片。";
  if (toolCallCount > 0) return "任务已经交给对应成员执行，可在看板和工作日志查看进度。";
  return "这轮模型没有返回可显示内容，请重试一次。";
}

/**
 * 同一轮里同一篇稿只留**最后一张**稿件卡。一轮多工具常见形态:get_draft(读全文)→
 * clear_revision_focus → revise_draft(存新版),前两步各推一张同稿卡,用户看到的是
 * 「旧版卡 + 分隔线 + 新版卡」两张重复(2026-08-23 创始人截图)。读稿是模型的内部动作,
 * 版本以最后一张为准;位置也取最后出现处,保证新版卡落在「已退出修改模式」分隔线之后。
 * 稿件 id 兼容两种载荷形态(contentId=generate/revise 系,id=get_draft 直回内容体)。
 */
export function dedupeDraftCards(cards: ChatCard[]): ChatCard[] {
  const keyOf = (c: ChatCard): string | null => {
    if (c.type !== "draft") return null;
    const d = c.data as Record<string, unknown>;
    const key = d.contentId ?? d.id;
    return typeof key === "string" && key ? key : null;
  };
  const lastIndex = new Map<string, number>();
  cards.forEach((c, i) => {
    const key = keyOf(c);
    if (key) lastIndex.set(key, i);
  });
  return cards.filter((c, i) => {
    const key = keyOf(c);
    return !key || lastIndex.get(key) === i;
  });
}

/**
 * 同选题同平台的中断稿（未删、带 lastError）。listContents 已按 createdAt 倒序，
 * 所以 find 拿到的就是最新那一张——用户眼里那张卡就在看板最上面。
 */
function findInterruptedDraft(
  contents: Array<Record<string, unknown>>,
  topicId: string,
  platform: string,
): string | null {
  const hit = contents.find((c) => c.topicId === topicId && c.platform === platform && c.lastError);
  return typeof hit?.id === "string" ? hit.id : null;
}

/** 工具名唯一是 fail-closed 断言(设计 §Phase 1):重名会被 loop 静默覆盖,宁可起不来也不带病跑 */
export function assertUniqueToolNames(tools: LoopTool[]): LoopTool[] {
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`chat 工具重名：${t.name}——注册表必须唯一`);
    seen.add(t.name);
  }
  return tools;
}

/** GUI 技能索引段:名字 + 一句话摘要 + 何时读手册。低频变化,不破 system prompt 前缀缓存。 */
export function skillIndexPrompt(skills: GuiSkill[]): string {
  if (skills.length === 0) return "";
  return (
    "\n\n编辑部的专项工作手册（命中下列场景时，先调用 read_skill 读对应手册，再按手册里的方法与步骤操作，别凭印象硬干）：\n" +
    skills.map((s) => `- ${s.id}：${s.summary}`).join("\n")
  );
}

export function buildChatTools(sink: ChatCard[], dataDir?: string, deps?: ChatToolDeps, effects?: ChatEffects, viewContext?: ChatViewContext, guiSkills?: GuiSkill[]): LoopTool[] {
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
          // 与桌面写作入口同一道闸口：选题没简报就先补调研，闸口故障只降级不阻断
          ensureBriefImpl: makeEnsureBrief(dd),
        })),
    retryGenerate:
      deps?.retryGenerate ??
      ((contentId, dd, override) =>
        retryGenerateScript(
          contentId,
          dd,
          {
            onEvent: (e) => void emitEngineEvent(e, dd).catch(() => {}),
            ensureBriefImpl: makeEnsureBrief(dd),
          },
          override,
        )),
    reviseDraftImpl: deps?.reviseDraftImpl ?? reviseDraft,
    reviseFocusImpl: deps?.reviseFocusImpl ?? reviseFocus,
    deepResearch: deps?.deepResearch ?? triggerDeepResearch,
    buildVideo: deps?.buildVideo ?? videoBuildStartHandler,
  };
  const dirParams = dataDir ? { _dataDir: dataDir } : {};

  /** 模型 args 来自 tool_call，剥掉内部保留键（_ 前缀），防 _dataDir 注入 */
  const sanitize = (args: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith("_")));

  const fail = (error: unknown) => JSON.stringify({ ok: false, error: String(error ?? "未知错误") });

  /**
   * 本轮焦点（可被 clear_revision_focus 撤下）。焦点的事实源是前端 store，
   * 服务端只在本轮内跟着改一份：退出后同一轮里 revise_draft 等常规工具立刻放行，
   * 用户不必再发一轮（真机 dogfood 死循环的根因之一）。前端由 focus_cleared 卡同步。
   */
  let revisionFocus = viewContext?.revisionFocus;

  /**
   * 中断稿原地重写分支（generate_script 的前置）。返回工具回执，null = 没有中断稿，照旧新建。
   *
   * 老路是「重试 = 再派一次活」→ 中断稿成僵尸卡，每重试一次看板多一张重复卡
   * （2026-08-24 缺陷）。claim 与编辑器按钮共用一把锁：两个入口不许同时改一份 meta。
   */
  const retryInterrupted = async (req: ScriptRequest): Promise<string | null> => {
    const list = await d.content({ ...dirParams, action: "list" });
    if (!list.ok) return fail(list.error);
    const staleId = findInterruptedDraft(
      (list.contents ?? []) as Array<Record<string, unknown>>,
      req.topicId ?? "",
      req.platform,
    );
    if (!staleId) return null;
    const key = GENERATE_JOB_KEY(staleId);
    if (!claimJob(key)) {
      return JSON.stringify({
        ok: true, alreadyRunning: true, contentId: staleId,
        note: "这篇已经在写了——照实说「已在跑,进度看看板」,不要重复派活。",
      });
    }
    let held = false;
    try {
      // 带上这一轮的新要求:用户换了角度就按新角度重写(见 retryGenerateScript 的 override)
      const started = await d.retryGenerate(staleId, dataDir, req);
      holdJobUntilSettled(key, started.completion);
      held = true;
      effects?.contentIds.add(staleId);
      return JSON.stringify({
        ok: true, pending: true, contentId: staleId,
        note: "上次这篇写崩了,已在原稿上重写,没有新建稿件（约 1-3 分钟）。告诉用户去看板看那张卡,不要编造成稿内容。",
      });
    } finally {
      if (!held) releaseJob(key);
    }
  };

  /** 落选题 + 放行。卡不在最新简报里 = 用户看的是过期候选，拒绝并让他重看一次 */
  const selectAngle = async (topicId: string, brief: ResearchBrief, angleId: string): Promise<string | null> => {
    const card = findAngleCard(brief, angleId);
    if (!card) {
      return fail(`角度 ${angleId} 不在这条选题的最新简报（v${brief.revision}）里——重新把候选念给用户听,让他重选`);
    }
    const updated = await updateTopic(
      topicId,
      { selectedAngle: { briefRevision: brief.revision, angleId, card, selectedAt: new Date().toISOString() } },
      dataDir,
    );
    return updated ? null : fail(`选题不存在：${topicId}`);
  };

  /** 不接单回执：把候选原样交给总编辑去念，**由用户拍板**——替他选就等于没有品味闸口 */
  const needsAngleReply = (topicId: string, brief: ResearchBrief, cards: AngleCard[]): string => {
    sink.push({ type: "angle_cards", data: { topicId, revision: brief.revision, cards } });
    return JSON.stringify({
      ok: true,
      needsAngle: true,
      cards: cards.map((c) => ({
        id: c.id, angle: c.angle, thesis: c.thesis,
        antiScope: c.antiScope, audiencePain: c.audiencePain, hookDraft: c.hookDraft,
      })),
      note: "把候选讲给用户听,让他选一张/说自己的角度/明说直接写;不要替用户选。",
    });
  };

  /**
   * 角度闸口（角度卡 spec §1.6「聊天 write_script」）。返回工具回执 = **不接单**，
   * null = 放行开写。
   *
   * 有候选卡却没选就直接开写，等于把整条角度链白建——所以这里多走一轮往返
   * （创始人 2026-08-23 裁决点 1：接受这一轮）。放行的四条路：
   * 用户点了卡（angle_id）、自己写了角度（direction）、明说直接写（skip_reason）、
   * 或这条选题压根没有角度卡（无简报 / 旧简报 / 证据为空的降级简报，§1.8 不硬出角度）。
   */
  const angleGate = async (req: ScriptRequest, angleId: string): Promise<string | null> => {
    if (!req.topicId) return null;
    const brief = await loadLatestBrief(req.topicId, getDataDir(dataDir), () => {});
    const cards = angleCardsOf(brief);
    if (!brief || cards.length === 0) return null; // 没有候选就没有闸口（§1.8 降级：不硬出角度）
    if (angleId) return selectAngle(req.topicId, brief, angleId);
    if (req.direction?.trim() || req.angleSkipReason?.trim()) return null;
    const topic = await getTopic(req.topicId, dataDir);
    const hash = topic ? topicHashOf(topic.title, topic.description) : "";
    if (topic && activeAngleCard(topic.selectedAngle, brief, hash)) return null; // 之前选过且还作数
    return needsAngleReply(req.topicId, brief, cards);
  };

  const tools: LoopTool[] = [
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
        "开写一篇稿件（后台任务）。调用立即返回占位稿——写作在后台进行（长文约 1-3 分钟）,完成后看板卡片自动转正、任务带显示进度。需要明确的选题和目标平台。选题来自灵感库时必须带 topic_id（灵感库编号,形如 topic-xxx——brief/候选卡里都有）,血缘断了归因和灵感保护就断了。带 topic_id 时,这条选题上次写崩的那张卡会被就地重写（不新建）——用户说「重新生成/再写一次」照常调这个工具即可。若这条选题调研出了角度候选卡而用户还没定角度,本工具**不接单**,回 needsAngle + 候选清单让你念给用户挑（见守则 27）。",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "脚本选题" },
          platform: { type: "string", enum: PLATFORM_ENUM, description: "目标平台" },
          research: { type: "string", description: "参考素材（可选）" },
          topic_id: { type: "string", description: "灵感库编号（选题来自灵感库时必带）" },
          use_patterns: {
            type: "boolean",
            description: "是否借鉴对标拆解卡(默认 true;用户明说「别参考对标/别套模板」时传 false)",
          },
          angle_id: {
            type: "string",
            description:
              "用户选中的角度卡编号(形如 angle-2),来自本工具上一轮回执里的角度候选。用户从候选里挑了一张才传,不要自己替他挑。",
          },
          direction: {
            type: "string",
            description:
              "用户自己手写的角度原话(不是你的转述、不是候选卡的复述)。他说「我想从 XX 角度写」时传这句,它压过一切候选卡。",
          },
          skip_reason: {
            type: "string",
            description:
              "仅当用户原话明确表示不选角度直接写(「别选角度」「直接写」「就按老样子」)时,把那句原话转述进来。用户没说过就绝不要传。",
          },
        },
        required: ["topic", "platform"],
      },
      execute: async (args) => {
        const a = sanitize(args);
        // 没给值的键**不出现**（而不是置 undefined）：这份请求也当重写的覆盖层用，
        // 带一个 undefined 进去就等于把原稿上存着的那一格擦掉
        const req: ScriptRequest = {
          topic: String(a.topic ?? ""),
          platform: a.platform as never,
          ...(typeof a.research === "string" && a.research ? { research: a.research } : {}),
          ...(typeof a.topic_id === "string" && a.topic_id ? { topicId: a.topic_id } : {}),
          // 缺省启用；只有显式 false 才关掉对标拆解卡注入（收件箱设计 §3.5）
          ...(a.use_patterns === false ? { usePatterns: false } : {}),
          // 角度三口（§1.3/§1.6）：手写 direction 最高优先级；skip_reason 只进 run-log 留痕
          ...(typeof a.direction === "string" && a.direction.trim() ? { direction: a.direction.trim() } : {}),
          ...(typeof a.skip_reason === "string" && a.skip_reason.trim()
            ? { angleSkipReason: a.skip_reason.trim() }
            : {}),
        };
        try {
          const angleId = typeof a.angle_id === "string" ? a.angle_id.trim() : "";
          // 用户这轮点了卡：先落选题再走任何路——即便下一步命中中断稿重写,
          // 重写读的也是 topic.selectedAngle,不先落盘他刚选的角度就会被静默丢掉
          if (angleId) {
            const selected = await angleGate(req, angleId);
            if (selected) return selected;
          }
          // 这条选题上次就写崩了 → 救活那张卡，而不是再开一张（见 retryInterrupted）。
          // **排在 needsAngle 弹卡之前**：中断重写不该再问一遍角度。
          if (req.topicId) {
            const retried = await retryInterrupted(req);
            if (retried) return retried;
          }
          // angleId 那条已在上面选定并放行,不必再过一遍闸口
          const gated = angleId ? null : await angleGate(req, "");
          if (gated) return gated;
          // 后台化（契约 P1 完全体）:任务生命周期与本次对话请求解耦——对话立即回,写作照跑
          const started = await d.startGenerate(req, dataDir);
          effects?.contentIds.add(started.contentId);
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
      description:
        "列出/搜索现有稿件（标题、状态、平台）。用户提到某篇既有稿件（「抖音那篇」「之前发的 XX」）时，先用关键词/平台/状态筛选自己找到它的 id——不要向用户要稿件 id 或看板位置；命中多篇拿不准再列候选让用户挑。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "标题关键词，大小写不敏感的包含匹配" },
          platform: { type: "string", enum: PLATFORM_ENUM, description: "按平台筛选" },
          status: { type: "string", description: "按状态筛选，如 published、approved、draft_ready" },
        },
      },
      execute: async (args) => {
        const a = sanitize(args);
        const res = await d.content({ ...dirParams, action: "list" });
        if (!res.ok) return fail(res.error);
        const all = (res.contents ?? []) as Array<Record<string, unknown>>;
        const query = String(a.query ?? "").trim().toLowerCase();
        const platform = String(a.platform ?? "").trim();
        const status = String(a.status ?? "").trim();
        const contents = all.filter((c) =>
          (!query || String(c.title ?? "").toLowerCase().includes(query)) &&
          (!platform || c.platform === platform) &&
          (!status || c.status === status));
        sink.push({ type: "drafts_list", data: { contents } });
        const compact = contents.slice(0, 20).map((c) => ({
          id: c.id, title: c.title, status: c.status, platform: c.platform,
        }));
        return JSON.stringify({
          ok: true, total: contents.length, drafts: compact,
          // 截断必须显式说——模型以为「看全了」就会漏掉老稿,又回到问用户要 id 的老路
          ...(contents.length > compact.length ? { note: `共 ${contents.length} 条仅显示前 ${compact.length} 条，用 query/platform/status 缩小范围` } : {}),
        });
      },
    },
    {
      name: "get_draft",
      description: "按 id 读取单篇稿件详情，返回含完整正文——需要基于稿件内容讨论/提建议时先调它读全文。",
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
        // 正文要回给模型：上下文注入承诺了「可用 get_draft 读全文」，总编辑靠它讨论标题/开头/观点。
        // 工具结果只活在本轮 loop（chat-persist 只存用户消息+最终回复），不会长期膨胀对话历史。
        return JSON.stringify({ ok: true, id: content.id, title: content.title, status: content.status, body: content.body });
      },
    },
    {
      name: "revise_draft",
      description:
        "按用户反馈修改一篇现有稿件，并原地保存为新版本。用户针对‘这篇/开头/结尾/某一段’提出修改时必须调用；不要新建另一篇稿。",
      parameters: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "要修改的稿件 id；优先使用当前上下文里的 id" },
          instruction: { type: "string", description: "用户的完整修改要求" },
        },
        required: ["content_id", "instruction"],
      },
      execute: async (args) => {
        const a = sanitize(args);
        const contentId = String(a.content_id ?? "");
        const instruction = String(a.instruction ?? "").trim();
        if (!contentId || !instruction) return fail("revise_draft 需要 content_id 和 instruction");
        if (revisionFocus) return fail("当前有修改焦点——焦点内的修改请用 revise_focus(出提案让用户收下);要改的超出焦点范围就先 clear_revision_focus 退出,再用本工具。");
        try {
          const result = await d.reviseDraftImpl(contentId, instruction, dataDir);
          const content = result.content;
          effects?.contentIds.add(content.id);
          sink.push({
            type: "draft",
            data: {
              contentId: content.id,
              title: content.title,
              body: content.body,
              platform: content.platform,
              status: content.status,
              version: content.versions?.length ?? 1,
            },
          });
          return JSON.stringify({
            ok: true,
            contentId: content.id,
            title: content.title,
            version: content.versions?.length ?? 1,
            note: "已原地保存为新版本，稿件卡已更新。",
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "revise_focus",
      description:
        "当「修改焦点」激活时（用户在编辑器选了一段或点了改整篇），按用户这轮意见改写焦点范围。要求不明确就先反问澄清、别硬改；改好的是提案、不直接保存——提示用户在编辑器看红绿 diff、满意点「收下这版」。",
      parameters: {
        type: "object",
        properties: { instruction: { type: "string", description: "用户这轮的完整修改要求" } },
        required: ["instruction"],
      },
      execute: async (args) => {
        const focus = revisionFocus;
        const contentId = viewContext?.contentId ?? "";
        if (!focus || !contentId) return fail("当前没有修改焦点——请用户在编辑器里选段「改这段」或点「改这篇」");
        const instruction = String(sanitize(args).instruction ?? "").trim();
        if (!instruction) return fail("revise_focus 需要 instruction");
        try {
          const rf: ReviseFocus =
            focus.scope === "selection" ? { scope: "selection", selection: focus.selection ?? "" } : { scope: "draft" };
          const r = await d.reviseFocusImpl(contentId, instruction, rf, dataDir);
          if (r.kind === "question") {
            return JSON.stringify({ ok: true, kind: "question", question: r.question, note: "把这个问题原样问用户，等回答再改。" });
          }
          effects?.contentIds.add(contentId);
          sink.push({
            type: "revision_proposal",
            data: {
              contentId,
              scope: focus.scope,
              feedback: instruction,
              ...(r.title !== undefined ? { title: r.title } : {}),
              ...(r.body !== undefined ? { body: r.body } : {}),
              ...(r.span !== undefined ? { span: r.span } : {}),
              ...(focus.scope === "selection" ? { selection: focus.selection } : {}),
            },
          });
          return JSON.stringify({ ok: true, kind: "revision", note: "改好一版提案，编辑器已出红绿 diff。提示用户满意点「收下这版」，要继续磨就再说。" });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "clear_revision_focus",
      description:
        "退出当前修改焦点。用户说「不改这段了／直接改整篇／取消」，或这轮要求超出焦点范围（改别的稿、整篇重写、写新的）时调用——退出后同一轮就能直接用 revise_draft、generate_script 等常规工具，别让用户自己去编辑器里操作再回来。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        // 无焦点时不推卡:给用户看一张"已退出修改模式"的空回执只会造成困惑
        if (!revisionFocus) {
          return JSON.stringify({ ok: true, note: "当前没有修改焦点,无需退出;直接用 revise_draft/generate_script 等常规工具即可" });
        }
        revisionFocus = undefined;
        sink.push({ type: "focus_cleared", data: {} });
        return JSON.stringify({
          ok: true,
          note: "焦点已退出，本轮接下来可直接用 revise_draft/generate_script 等常规工具",
        });
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
      name: "scout_inspiration",
      description:
        "侦查员主动搜集:网页搜索 → 按定位/画像做相关性过滤 → 入灵感库。用户说「搜一下 X」「去找找最近有什么可写的」时调用;query 可选,不传则按定位+核心画像痛点自动生成搜索词。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索词(可选)" } },
      },
      execute: async (args) => {
        const a = sanitize(args);
        try {
          const r = await scoutInspiration({ query: typeof a.query === "string" ? a.query : undefined }, dataDir);
          if (r.saved.length > 0) {
            sink.push({
              type: "topic",
              data: {
                industry: "侦查搜集 · " + r.queriesUsed.join(" / "),
                candidates: r.saved.map((t) => ({ title: t.title, source: t.source ?? "search", link: t.link })),
              },
            });
          }
          return JSON.stringify({
            ok: true,
            queriesUsed: r.queriesUsed,
            found: r.found,
            saved: r.saved.map((t) => ({ id: t.id, title: t.title })),
            skippedDuplicates: r.skippedDuplicates,
            filter: r.filter,
            note: r.saved.length > 0
              ? "已入灵感库(看板第一列)。向用户报告搜到什么、为什么值得写。"
              : "没有达标候选(宁缺勿滥)。告诉用户搜了什么词、可以换词再试。",
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "generate_persona",
      description:
        "生成三层受众画像提案(core 核心/adjacent 邻近/surprise 意外)。用户要校准受众、问「我的读者是谁」、或画像缺失/未校准需要建立时调用。提案必须与用户逐层确认或修正——不要自行保存,确认后调用 save_persona。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          const { proposal, basis } = await generateAudiencePersonaProposal(dataDir);
          sink.push({ type: "persona", data: { persona: proposal, basis, calibrated: false } });
          return JSON.stringify({
            ok: true,
            proposal,
            basis,
            note: "画像卡已展示。带用户逐层过一遍(名字/焦虑/痛点准不准),收集修正;用户明确认可后调用 save_persona 保存最终版。",
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "save_persona",
      description:
        "保存用户确认后的受众画像(打校准章,此后作为选题过滤/写作/受众停留审的标准)。只在用户对画像明确认可或给出修正并同意后调用,传入最终三层画像。",
      parameters: {
        type: "object",
        properties: {
          core: { type: "object", description: "核心受众 {name,age,job,coreAnxiety,painPoints[],scrollStopTriggers[]}" },
          adjacent: { type: "object", description: "邻近受众,同形状(可省)" },
          surprise: { type: "object", description: "意外受众,同形状(可省)" },
        },
        required: ["core"],
      },
      execute: async (args) => {
        try {
          const profile = await savePersonaCalibrated(sanitize(args), dataDir);
          sink.push({ type: "persona", data: { persona: profile.audiencePersona, calibrated: true } });
          return JSON.stringify({
            ok: true,
            summary: personaSummary(profile.audiencePersona, { allTiers: true }),
            note: "画像已校准落库。选题过滤、写作、受众停留审从现在起都以它为准。",
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "set_goal",
      description:
        "记录/更新创作者目标(北极星)。用户说「/goal …」「我的目标是…」「这个季度要…」时调用;目标会注入选题、写作、复盘全链,旧目标自动留档。",
      parameters: {
        type: "object",
        properties: {
          statement: { type: "string", description: "目标一句话,如「3 个月公众号做到 1 万粉」" },
          horizon: { type: "string", description: "期限(可选),如 2026-09-30 / 3 个月" },
          metrics: { type: "array", items: { type: "string" }, description: "关键指标(可选)" },
        },
        required: ["statement"],
      },
      execute: async (args) => {
        try {
          const goal = await setGoal(
            {
              statement: String(args.statement ?? ""),
              horizon: typeof args.horizon === "string" ? args.horizon : undefined,
              metrics: Array.isArray(args.metrics) ? args.metrics.filter((m): m is string => typeof m === "string") : undefined,
            },
            dataDir,
          );
          return JSON.stringify({ ok: true, goal, note: "目标已入档——选题、写作、复盘从现在起围绕它对齐。" });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "get_goal",
      description: "读取创作者当前目标。用户问「我的目标是什么」「进展怎么样」或你要围绕目标给建议时调用。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          const goal = await getGoal(dataDir);
          return JSON.stringify({
            ok: true,
            goal,
            note: goal ? "围绕这个目标给建议。" : "还没设目标——建议用户设一个(set_goal),全链会围绕它对齐。",
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "audience_review",
      description:
        "受众停留审:代入已校准的受众画像审一篇稿——每层受众会不会停下来读完、在哪里会划走、怎么改。用户说「审一下」「受众会怎么看」「这篇能留住人吗」时调用;用户正看着的稿件 id 在上下文里。",
      parameters: {
        type: "object",
        properties: { content_id: { type: "string", description: "稿件 id" } },
        required: ["content_id"],
      },
      execute: async (args) => {
        const a = sanitize(args);
        const res = await d.content({ id: a.content_id, ...dirParams, action: "get" });
        if (!res.ok) return fail(res.error);
        const content = res.content as { title?: string; body?: string; platform?: string };
        try {
          const result = await reviewAudienceStay(
            { title: String(content.title ?? ""), body: String(content.body ?? ""), platform: content.platform },
            dataDir,
          );
          sink.push({ type: "audience_review", data: { contentId: a.content_id, ...result } });
          return JSON.stringify({
            ok: true,
            coreStops: result.coreStops,
            verdicts: result.verdicts,
            suggestions: result.suggestions,
            note: "结果卡已展示;把不通过层的原因讲给用户,建议按 losesAt 定位到原文改。",
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "prepare_video_kit",
      description:
        "为视频稿备发布件:平台发布文案(不是口播稿摘要)+分镜表+竖版封面。用户要发视频稿、或问「怎么发/帮我准备发布」时调用;稿件须是视频平台(抖音/视频号/小红书/B站)。",
      parameters: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "稿件 id" },
          generate_cover: { type: "boolean", description: "是否生成封面图(需生图中转已配置),默认 true" },
        },
        required: ["content_id"],
      },
      execute: async (args) => {
        const a = sanitize(args);
        try {
          const r = await prepareVideoKit(
            String(a.content_id ?? ""),
            { generateCover: a.generate_cover !== false },
            dataDir,
          );
          sink.push({ type: "video_kit", data: { contentId: a.content_id, ...r.kit, coverError: r.coverError ?? null } });
          return JSON.stringify({
            ok: true,
            caption: r.kit.caption.slice(0, 120),
            shots: r.kit.storyboard.length,
            coverText: r.kit.coverText,
            cover: r.kit.coverPath ?? null,
            coverError: r.coverError ?? null,
            note: "发布件卡已展示。提醒用户:口播稿照着读,发布时用卡里的文案;粘贴发布走 publish_clipboard(会自动取发布件文案)。",
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
    {
      name: "build_video",
      description:
        "把一篇已过审的视频稿投给剪辑师做成片(A-roll 转写→选段→组装→渲染)。**成片构建是后台任务**:本工具只投递,立刻返回当前状态——进度用 video:status 查(成片卡会自动刷新),不要在对话里等结果、更不要宣称已剪好。转写完成后需要用户亲手勾选分句、渲染完成后需要用户审片确认。",
      parameters: {
        type: "object",
        properties: { content_id: { type: "string", description: "稿件 id(须已过审、视频平台)" } },
        required: ["content_id"],
      },
      execute: async (args) => {
        const contentId = String(sanitize(args).content_id ?? "").trim();
        if (!contentId) return fail("build_video 需要 content_id");
        try {
          const res = await d.buildVideo({ content_id: contentId, ...dirParams });
          if (!res.ok) return fail(res.error);
          const state = (res.data as { state?: { phase?: string; state?: string } } | null)?.state;
          return JSON.stringify({
            ok: true,
            contentId,
            phase: state?.phase ?? "ingest",
            state: state?.state ?? "queued",
            note: "已投给剪辑师,后台在跑(分钟级)。告诉用户去稿件的成片卡看进度;转写完成后要他亲手勾选分句,渲染完成后要他审片确认。",
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
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
    {
      name: "deep_research",
      description:
        "深调研:给灵感库某条选题派四视角并行侦察(受众痛点/证据数据/反方/对标),产出带跨视角张力点的调研简报,之后写这条选题会自动注入。用户说「深入调研一下这个选题」「多找点材料再写」时调用。**异步任务,投递即返回**——不要等它跑完,也不要假装已经读到简报。",
      parameters: {
        type: "object",
        properties: { topic_id: { type: "string", description: "灵感库选题编号(topic-…);没有就先 save_topic 入库" } },
        required: ["topic_id"],
      },
      execute: async (args) => {
        const topicId = String(sanitize(args).topic_id ?? "").trim();
        if (!topicId) return fail("topic_id 必填(灵感库选题编号)");
        let res: TriggerResult;
        try {
          res = await d.deepResearch(topicId, dataDir);
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
        // 被拒(搜索 key 未配/选题不存在/运行时没起)照原样回,让总编辑把原因转达给用户
        if (!res.accepted) return fail(res.reason);
        const done = res.job.perspectives.filter((p) => p.status === "succeeded").length;
        return JSON.stringify({
          ok: true,
          topicId,
          jobStatus: res.job.status,
          deduped: res.deduped,
          perspectivesDone: `${done}/${res.job.perspectives.length}`,
          note: res.deduped
            ? "这条选题的深调研已经在跑,本次合并进去了。告诉用户「已经在调研中」和当前进度,别重复派活。"
            : "已排队,四视角并行侦察,通常几分钟。告诉用户「已派下去」,进度在选题卡上看;不要在本轮等结果。",
        });
      },
    },
  ];

  // 到达面(设计 §Phase 2):封面/配图/流转/预检/活动/收件箱/版本——同一套包装模式,单独成文件
  tools.push(
    ...buildWorkspaceTools({
      sink,
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(deps !== undefined ? { deps } : {}),
      ...(effects !== undefined ? { effects } : {}),
      content: d.content,
    }),
  );

  // 工作手册(设计 §Phase 1):只有存在 GUI 面技能时才注册——无技能时工具集与今天完全一致。
  if (guiSkills && guiSkills.length > 0) {
    const ids = guiSkills.map((s) => s.id);
    // 本轮缓存:同一轮里模型翻同一本手册第二次直接回上次的结果(cache 建在本次调用作用域,天然按轮隔离)
    const turnCache = new Map<string, string>();
    tools.push({
      name: "read_skill",
      description:
        "读取一本专项工作手册的正文（方法论 + 操作步骤）。命中手册覆盖的场景时先读再干；一轮里同一本读一次就够。",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", enum: ids, description: `手册名，只能是：${ids.join(" | ")}` },
        },
        required: ["skill"],
      },
      execute: async (args) => {
        const id = String(sanitize(args).skill ?? "").trim();
        const cached = turnCache.get(id);
        if (cached) return cached;
        // 只查预加载白名单——不用模型输入拼任何路径,harness-only 技能与 `../` 串一律未命中
        const manual = guiSkills.find((s) => s.id === id)?.guiContent;
        if (manual === undefined) {
          // 只回显模型自己给的 id(截断),不带任何本地路径
          return JSON.stringify({ ok: false, error: `未知技能「${id.slice(0, 40)}」——可用手册：${ids.join("、")}` });
        }
        const payload = JSON.stringify({ ok: true, skill: id, manual });
        turnCache.set(id, payload);
        return payload;
      },
    });
  }

  return assertUniqueToolNames(tools);
}

export async function runChatTurn(params: {
  message: string;
  history?: ChatHistoryMessage[];
  dataDir?: string;
  viewContext?: ChatViewContext;
  deps?: ChatToolDeps;
  fetchImpl?: typeof fetch;
  /** 工作手册目录(缺省仓库 skills/)——测试用 fixture 目录 */
  skillsDir?: string;
  /** 运行日志归属(V5.6):与任务动态卡同一 runId,工作日志视图按它聚合 */
  runId?: string;
  onEvent?: (e: ChatProgressEvent) => void;
  /**
   * 流式正文出口（设计 §Phase 3）:reset/delta 来自 runLoop，done 由本函数在 loop 收尾后补。
   * 只对可寻址的 turn 接线（见 chatTurnHandler）——不传 = 不流式，行为与今天一致。
   */
  onDelta?: (e: ChatDeltaEvent) => void;
  /** 用户中止信号（设计 §Phase 3）:中止走 ok:true + stopReason="aborted",不是失败轮 */
  signal?: AbortSignal;
  /** 右栏选的模型档位（chat:model_options 的 id）；不传 = 主端点快档,与今天一致 */
  modelChoice?: string;
}): Promise<Record<string, unknown>> {
  let config;
  try {
    config = await loadEngineConfig(params.dataDir);
  } catch (err) {
    return { ok: false, needsSetup: true, error: err instanceof Error ? err.message : String(err) };
  }
  // 档位解析在最前面:选了一个不存在的模型就该当场失败,不该先跑完工具再发现
  const picked = resolveChatModel(config, params.modelChoice);
  if (!picked.ok) return { ok: false, error: picked.error };

  const cards: ChatCard[] = [];
  const effects: ChatEffects = { contentIds: new Set<string>() };
  // 工作手册加载失败不阻断对话——视同无技能(索引不注入、read_skill 不注册)
  let guiSkills: GuiSkill[] = [];
  try {
    guiSkills = await listGuiSkills(params.skillsDir);
  } catch (err) {
    console.warn(`[chat] 工作手册加载失败，本轮按无技能处理：${err instanceof Error ? err.message : String(err)}`);
  }
  const tools = buildChatTools(cards, params.dataDir, params.deps, effects, params.viewContext, guiSkills);

  // 定位摘要进 system（§C1）:总编辑说话像「你的总编辑」。只注入定位,不注入全量风格——
  // 总编辑不写稿,写手席才吃声音内核（PRD-v4 §4.3 上下文隔离）。profile 低频变化,不破前缀缓存。
  let systemPrompt = SYSTEM_PROMPT + skillIndexPrompt(guiSkills);
  try {
    const profile = await loadProfile(params.dataDir);
    if (profile?.industry) {
      // V5.1:画像三层结构,personaSummary 是唯一渲染口径
      const audience = personaSummary(profile.audiencePersona);
      systemPrompt +=
        `\n\n创作者定位：${profile.industry}` +
        (audience ? `；核心受众：${audience}` : "") +
        (profile.audiencePersona && !profile.audiencePersona.calibratedAt
          ? "（画像未校准,建议提醒用户完成校准）"
          : "");
    }
    // 席位注入（IA v4.2）:派活、一稿多发只围绕用户开通的平台,不撒网到没开的席位
    if (profile?.platforms?.length) {
      const seats = profile.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join("、");
      systemPrompt += `\n创作者的平台席位：${seats}。派活与一稿多发只在这些平台里给建议,不要推荐用户没开通的平台;用户明确要求新平台时先建议去开通席位。`;
    }
    // 目标注入（V5.6 /goal）:总编辑对齐北极星,选题与建议围绕它排优先级
    const goalLine = goalSummary(profile?.goal);
    if (goalLine) {
      systemPrompt += `\n创作者当前目标：${goalLine}。选题推荐、写作建议、数据解读都围绕它对齐;明显偏航时提醒一句。`;
    }
  } catch { /* 无档案照常对话 */ }

  // 视图上下文拼进本轮 userMessage（§C1）:只发模型,不进持久历史（chat-persist 存原文）
  const ctx = params.viewContext;
  // 兄弟稿注入:总编辑要能看到同主题的其他平台稿件,才能从已过审的那篇派生(不用再问用户要 id)。
  let siblingLine = "";
  if (ctx?.contentId) {
    try {
      const sibs = await listSiblings(ctx.contentId, params.dataDir);
      if (sibs.length > 0) {
        const list = sibs
          .map((s) => `${(s.platform && PLATFORM_LABELS[s.platform]) || s.platform || "未分平台"}(id: ${s.id}，状态: ${s.status})`)
          .join("；");
        siblingLine = `\n本主题的其他平台稿件（同选题兄弟稿）：${list}。做一稿多发/派生时优先用 get_draft 读同主题「已过审(approved)」的那篇,从它的内容按目标平台的腔调重写(别机械套原文结构),别凭空另写。`;
      }
    } catch { /* 兄弟稿加载失败不阻断对话 */ }
  }
  // 当前平台腔调:让派生/改写贴平台表达习惯(如 X 偏观点),而非把长文照搬。
  const voiceLine = ctx?.platform && PLATFORM_VOICE[ctx.platform] ? `\n当前平台腔调:${PLATFORM_VOICE[ctx.platform]}` : "";
  // 最近工作区动作（设计 §Phase 2）:用户刚在工作区点过什么,总编辑得知道——只进模型不进持久历史
  // (与 siblingLine 同模式);无动作不注入,读失败当无动作。
  const actionsBlock = recentActionsBlock(await readRecentActions(params.dataDir).catch(() => []));
  // 位置行（设计 §Phase 3）:用户在看板/增长面板时,总编辑也该知道他正看着哪——
  // 字段已在 chat-view-context 过白名单/存在性,这里只负责拼话。
  const draftLine = ctx?.contentId
    ? `用户正打开稿件《${ctx.contentTitle || "无标题"}》（id: ${ctx.contentId}${ctx.platform ? `，平台: ${ctx.platform}` : ""}）——「这篇」「开头」等指代默认指它，可用 get_draft 读全文。${siblingLine}${voiceLine}`
    : "";
  const whereLine = viewContextLine(ctx);
  const contextBlock = draftLine || whereLine
    ? `【当前上下文】${[draftLine, whereLine].filter(Boolean).join("\n")}\n\n`
    : "";
  const userMessage = `${actionsBlock ? actionsBlock + "\n\n" : ""}${contextBlock}${params.message}`;

  try {
    const result = await runLoop(picked.config, {
      model: picked.model,
      systemPrompt,
      userMessage,
      history: params.history ?? [],
      tools,
      maxTurns: 6,
      logMeta: { ...(params.runId ? { runId: params.runId } : {}), agent: "chief-editor" },
      ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      onEvent: params.onEvent ? (e: LoopEvent) => params.onEvent!(chatProgressEvent(e)) : undefined,
      ...(params.onDelta ? { onTextDelta: (e: LoopStreamEvent) => params.onDelta!(e) } : {}),
    });
    // 同稿多卡去重要在收尾做——工具执行期间不知道后面还会不会再推同一篇
    const finalCards = dedupeDraftCards(cards);
    return {
      ok: true,
      data: {
        reply: visibleChatReply(result.finalMessage, finalCards, result.toolCallCount, result.stopReason),
        cards: finalCards,
        // 中止是正常收尾:ok:true + stopReason 透传,持久层按正常轮落盘,前端据此提示后台任务继续跑
        stopReason: result.stopReason,
        tokensUsed: result.totalTokens,
        contentIds: [...effects.contentIds],
        ...(params.runId ? { runId: params.runId, actionId: params.runId } : {}),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // 流结束（成功/中止/失败都算）:前端据此把气泡切到「整理回复中」，等 invoke 全量覆盖。
    // 失败轮也发——否则气泡会永远停在「还在吐字」的假象里。
    try {
      params.onDelta?.({ ev: "done" });
    } catch {
      /* 观测层异常不破坏执行层 */
    }
  }
}
