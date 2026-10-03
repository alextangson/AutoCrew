/**
 * MCP 工具说明瘦身（spec v1.3 §2）：宿主每轮都要全读 tools/list，长篇守则让不支持按需加载的模型又慢又乱。
 * 这里只改**给宿主看的说明**：工具说明 = 做什么 + 每个动作一句话；参数说明 = 一句话。
 * 参数结构（名字、类型、必填、枚举、长度限制）一个不动——`schema-shape.ts` 的快照测试证明这一点。
 * 原来的长说明整段搬进按需资源 `autocrew://tool-guide/<工具名>`；流程守则由工具返回里的报错 + next_action 兜住。
 * 内置引擎、OpenClaw 用的仍是工具注册时的原说明，不受影响。
 */
import { enumify } from "./schema-shape.js";

export const TOOL_GUIDE_PREFIX = "autocrew://tool-guide/";

const GUIDE = (name: string) => `完整用法：${TOOL_GUIDE_PREFIX}${name}`;

export const MCP_TOOL_DOCS: Readonly<Record<string, string>> = {
  autocrew_topic: "选题库。create 建选题；list 列选题；radar_pool 冻结雷达候选池给你打分；radar_score 交分（≥70 入库，同一池重交幂等）；delete 删选题（有稿件时拒绝，需审批）。",
  autocrew_research: "找新选题（不是给写作需求做调研，那个用 autocrew_workflow prepare）。discover 发现并可存选题；session_status 查浏览器登录。",
  autocrew_content: "管理已有稿件。list / get / siblings / allowed_transitions 查询；summary 看进度、请示答复、创始人修改意见 rejections；update 改稿；transition 推进；create_variant 派生平台版；adoption 仅工作台；delete / restore；save 仅手动导入；record 报制作事实；check_slivers 自查抽帧缝；mark_ready 成片可以审了；ask / answer_ask / withdraw_ask 请示创始人（进「等你拍板」，别在聊天里问）。批准只归创始人。新 AI 稿走 workflow → writer。",
  autocrew_workflow: "创作统一入口。prepare 准备材料与立意；research 领调研任务；status 查进度；select_angle 选定角度（带 brief_revision）；write / draft 由 next_action 引导；doctor 自检。每步按返回的 next_action 走。",
  autocrew_scout: "宿主执行的调研。prepare / pack 领任务；status 查进度；search 搜索（要搜索 key，没配就用你自己的搜索找网址）；read_page{perspective,url} 抓页；cite 登记逐字引文；claim_offline 登记未核验说法；perspective 交视角；synthesize 综合；angles 交角度候选。prepare 之后都带 topic_id + task_id。",
  autocrew_review_desk: "宿主审稿。pack 领审稿材料；submit 交审稿意见（带 review_pack_id、attempt、issues）。",
  autocrew_writer: "宿主写稿。pack 领写作包；pack_status 查备包；find_evidence 补证据；submit 交稿；submit_status 查交稿；gap / technique 缺口与技法参考。领包后的每次写都带 claim_token。",
  autocrew_desk: "待办桌。inbox 看本岗待办；claim 认领（拿 claim_token）；release 干完释放。",
  autocrew_video: "剪辑台（口播原片 → 成片），三道门由创作者决定。status 看状态与下一步；start / transcript / cut_confirm / editor_* / reassemble / review 等按 status 的 next 逐步做；handoff / match / confirm / register / report / revoke 用于交给剪辑工位与登记成片。",
  autocrew_editorial: "编辑档案与改稿反馈。profile 读档案；update_profile 改档案（需确认）；inspect 读稿与 draft_hash；feedback 记改稿要求并领改稿包。",
  autocrew_insights: "账号洞察。prepare 备料（内容、定位、回流数据）；submit 保存宿主写的报告；list / get 查看历史报告。meeting_* 选题会。",
  autocrew_cover_review: "封面。按 action 生成、查看、批准或修改封面；批准前先看图。",
  autocrew_publish: "发布。check 发布前把关（被拦平台不提交）；propose_preference 提议偏好；wechat_mp_draft 推公众号草稿（需审批）；clipboard 复制；ego_lite_prepare 备上传包；confirm_published 标记已发布（需审批）；digest 摘要。",
  autocrew_pre_publish: "发布前检查：check 逐项核对标题、正文、封面、平台要求，全过才能发布；video_kit 交发布包；title_methods 读标题方法库与试用期统计。",
  autocrew_asset: "稿件素材。add 登记；list 列；remove 删（需审批）；versions / get_version / revert 版本查看与回滚。",
  autocrew_status: "编辑部概览：选题与稿件数量、状态分布、最近动态。",
  autocrew_review: "确定性检查：敏感词与阅读格式（不是审稿，审稿用 autocrew_review_desk）。",
  autocrew_pipeline: "定时流水线。create / list / get / enable / disable / delete / templates。",
  autocrew_dashboard: "数据看板：作品表现与回流数据。",
};

/** 参数说明压成一句：取第一句、限长。完整说明在 tool-guide 资源里 */
export function oneLine(text: string, max = 60): string {
  const first = text.split(/(?<=[。；;!?！？])|\n|(?<=\.)\s/)[0]?.trim() ?? "";
  const chars = Array.from(first);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : first;
}

/**
 * 顶层参数留一句短说明；嵌套对象里的字段说明去掉（它们的含义在 tool-guide 资源与各动作的任务包里讲清）。
 * 只删 description 键，类型 / 必填 / 枚举 / 长度限制原样保留。
 */
function dropDescriptions(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropDescriptions);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "description").map(([k, x]) => [k, dropDescriptions(x)]));
}

/**
 * 参数一句话提示：只给名字看不出用法的参数（按名字，全工具共用）。其余参数不带说明——每条说明连键带引号就是十几个字，
 * 一百多个参数全写上会把预算吃光（spec v1.3 M7 实测：每个参数只留 10 个字也要 31k）；完整含义在 tool-guide 资源里。
 */
export const PARAM_HINTS: Readonly<Record<string, string>> = {
  claim_token: "领包 / 认领拿到的令牌，之后每次写都带",
  brief_revision: "prepare 返回的简报版本，select_angle 必带",
  research_mode: "auto 自动调研 / provided 已有材料 / skip 创作者明确免调研",
  research_reason: "skip 时创作者的原话",
  research: "provided 时的材料原文与出处",
  requirements: "创作者原话：提纲、篇幅、口吻、必写与禁写",
  direction: "创作者明确给的角度（不是风格要求）",
  skip_reason: "创作者点了「直接写」时的原话",
  execution: "默认宿主执行；engine 仅在创作者明确要求后台时用",
  review_pack_id: "writer submit 或 review_desk pack 返回的审稿包 id",
  attempt: "沿用写稿那一次的 attempt",
  pack_id: "writer pack 返回的包 id",
  revision_of: "要改的那一版的 draft_hash",
  draft_hash: "editorial inspect 返回的当前稿指纹",
  task_id: "prepare / pack 返回的调研任务 id",
  approval_id: "被要求审批时返回的 id，批准后带上重调",
  confirmation_id: "confirm 后创始人在 Mac 上确认得到的 id",
  force: "明确要重来时才用",
  perspective: "audience / evidence / counter / benchmark 之一；search、read_page 必带",
  user_confirmed: "创作者已明确确认",
  request_id: "请求号，重试用同一个",
  for_cut: "字幕所属成片（fact_id 或 sha）",
  uses_aroll: "工程用到的原片 fact_id",
};

function shortenDescriptions(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as { properties?: Record<string, Record<string, unknown>> };
  if (!s.properties) return dropDescriptions(schema);
  const properties = Object.fromEntries(Object.entries(s.properties).map(([name, prop]) => {
    const bare = dropDescriptions(prop) as Record<string, unknown>;
    return [name, PARAM_HINTS[name] ? { description: PARAM_HINTS[name], ...bare } : bare];
  }));
  return { ...(dropDescriptions({ ...s, properties: undefined }) as object), properties };
}

/** `autocrew://tool-guide/<工具名>` 的正文：瘦身前的工具说明原文 + 带原说明的完整参数结构 */
export function toolGuideText(name: string, description: string, parameters: unknown): string {
  return `# ${name}\n\n${description}\n\n## 参数（完整结构与每个参数的原说明）\n\n\`\`\`json\n${JSON.stringify(parameters, null, 1)}\n\`\`\`\n`;
}

/**
 * 本体启用后的说明（spec 2026-09-29 §8「同步改口」）：旧的交接 / 登记 / 封面附件入口在已启用的资料库里关了，
 * 说明跟着资料库的启用状态走，不留两套口径。长度不超过原说明（M7 预算）。
 */
export const ONTOLOGY_TOOL_DOCS: Readonly<Record<string, string>> = {
  autocrew_content: "管理已有稿件。record 报制作事实（原片 / 成片 / 字幕 / 封面 / ChatCut 工程 / 发布回执 / 分镜），名字对不上的原片先回 pending_match（summary 带 since_seq 等结果）；封面用 paths 一次记一对；mark_ready 成片可以审了；ask / answer_ask / withdraw_ask 请示创始人（进「等你拍板」）；summary 看进度、asks[] 与创始人修改意见 rejections[]（交新版前先读）；check_slivers 自查抽帧缝；get / update / list / siblings。批准只归创始人。新 AI 稿走 workflow → writer。",
  autocrew_video: "剪辑台内置剪辑线（start / transcript / review 等按 status 的 next 做）。交接 / 认稿 / 汇报 / 登记 / 撤回已关：原片、成片、字幕、封面改用 autocrew_content record。",
  autocrew_asset: "稿件素材。add 登记库内素材（封面与库外文件改用 autocrew_content record）；list 列；remove 删（需审批）；versions / get_version / revert 版本。",
};

/** tools/list 里给宿主看的那一份：短说明 + 等价压缩的参数结构；`ontology` = 当前资料库已启用本体 */
export function mcpToolView(tool: { name: string; description: string; parameters: unknown }, ontology = false): { name: string; description: string; inputSchema: unknown } {
  const short = (ontology ? ONTOLOGY_TOOL_DOCS[tool.name] : undefined) ?? MCP_TOOL_DOCS[tool.name];
  return {
    name: tool.name,
    description: short ? `${short} ${GUIDE(tool.name)}` : tool.description,
    inputSchema: shortenDescriptions(enumify(tool.parameters)),
  };
}
