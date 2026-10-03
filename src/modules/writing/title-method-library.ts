/**
 * 发布标题方法库（docs/2026-10-03-title-methods-spec.md §一–§四）。
 *
 * 四平台通用；平台只调字数与语气。每条方法都写清公式、为什么有效、适合 / 不适合什么稿、一个自家受众场景的例子。
 * 有真实性风险的方法挂 redLine：标题里的数字、权威、时限、他人反应，必须能在定稿或证据台账里找到。
 */

export interface TitleCategory {
  id: string;
  name: string;
}

export interface TitleMethod {
  id: string;
  category: string;
  name: string;
  formula: string;
  why: string;
  fits: string;
  notFor: string;
  example: string;
  redLine?: string[];
}

export const TITLE_CATEGORIES: readonly TitleCategory[] = [
  { id: "resonance", name: "共鸣" },
  { id: "result", name: "结果" },
  { id: "pain", name: "痛点" },
  { id: "curiosity", name: "好奇" },
  { id: "thinking", name: "思考" },
  { id: "bigger-picture", name: "格局" },
  { id: "identity", name: "身份" },
  { id: "list", name: "清单" },
];

const NUMBER_RULE = "标题里的数字必须在定稿正文或证据台账里找得到；找不到就换方法，不编";
const AUTHORITY_RULE = "不写「99% 的人」「大佬都在用」这类没有出处的比例和权威";
const REACTION_RULE = "不写「同事都惊呆了」这类不是真事的他人反应";
const DEADLINE_RULE = "不写「最后一波」「过几天就删」这类内容其实不会兑现的时限";

export const TITLE_METHODS: readonly TitleMethod[] = [
  {
    id: "candid-talk", category: "resonance", name: "真诚对话",
    formula: "坦白一件自己的事 + 当时真实的情绪",
    why: "像朋友私下说话，刷到的人防备心低，愿意听下去",
    fits: "有创作者亲历、踩过坑或改过主意的稿", notFor: "纯资讯、没有亲历的稿（编出来的坦白就是假话）",
    example: "说实话，我用 AI 写周报的头一个月，老板一份都没看出来",
    redLine: ["坦白的事必须是稿里写到的真事"],
  },
  {
    id: "precise-shot", category: "resonance", name: "精准镜头",
    formula: "一个具体的人在一个具体场景 + 稿里给的解法",
    why: "画面越具体，越像「说的就是我」",
    fits: "解法明确、受众场景清楚的教程或方法稿", notFor: "面向泛人群、没有具体场景的观点稿",
    example: "周五五点老板要周报？把聊天记录丢给 AI 这样问",
  },
  {
    id: "before-after", category: "result", name: "前后对比",
    formula: "原来的困境 → 改变之后的结果",
    why: "让人看到改变是可能的，而且离自己不远",
    fits: "有真实前后变化的案例稿", notFor: "只有方法、没有结果的稿",
    example: "以前回客户微信要翻半小时记录，现在 AI 先把要点理好",
    redLine: [NUMBER_RULE],
  },
  {
    id: "result-promise", category: "result", name: "结果承诺",
    formula: "数字或步骤 + 明确的效果",
    why: "把行动成本说小，观众觉得「我也能做到」",
    fits: "步骤清楚、效果可验证的教程稿", notFor: "效果因人而异、说不准的稿",
    example: "三句话教会 AI 用你的口气回客户",
    redLine: [NUMBER_RULE, "承诺的效果必须是稿里演示过的"],
  },
  {
    id: "pitfall-list", category: "pain", name: "踩坑清单",
    formula: "警示词 + 常见错误 + 数量",
    why: "怕亏比想赚更能让人停下",
    fits: "列了常见错误和改法的稿", notFor: "正面经验分享、没有「错法」的稿",
    example: "让 AI 写客服话术，别再犯这 3 个错",
    redLine: [NUMBER_RULE],
  },
  {
    id: "hidden-cost", category: "pain", name: "后果提醒",
    formula: "大家都在用的做法 + 你没想到的后果",
    why: "把隐形的代价点出来，制造紧迫感",
    fits: "讲风险、讲长期代价的稿", notFor: "后果其实很轻、要靠夸大才成立的稿",
    example: "把客户资料直接贴进 AI，你可能已经踩了合规的线",
    redLine: [REACTION_RULE, "后果必须是稿里有依据的，不夸大"],
  },
  {
    id: "belief-clash", category: "curiosity", name: "认知冲突",
    formula: "大家都觉得对的一件事，其实不对",
    why: "打破已有认知，人会想知道「凭什么」",
    fits: "有反常识结论且论据扎实的观点稿", notFor: "结论平常、靠硬反才显得新的稿",
    example: "提示词写得越长，AI 反而越不听话",
    redLine: [AUTHORITY_RULE],
  },
  {
    id: "twist", category: "curiosity", name: "反转惊奇",
    formula: "一个反常的做法 + 意外的结果",
    why: "「怎么可能」的念头逼人点进来求证",
    fits: "有真实反常操作和结果的案例稿", notFor: "结果不意外的稿",
    example: "我让 AI 先挑我方案的毛病，结果客户一次就过了",
    redLine: [REACTION_RULE],
  },
  {
    id: "insider-view", category: "curiosity", name: "内行视角",
    formula: "只有做过的人才知道的几件事",
    why: "信息差本身就是价值",
    fits: "创作者有一手经验、外人看不到的稿", notFor: "公开资料拼出来的稿（冒充内行就是假话）",
    example: "帮几家小公司上过 AI 之后，我发现卡住的从来不是工具",
    redLine: [AUTHORITY_RULE, NUMBER_RULE],
  },
  {
    id: "early-mover", category: "curiosity", name: "抢先一步",
    formula: "多数人还没注意到的变化 + 现在该做什么",
    why: "领先感：早知道一步就少落后一步",
    fits: "讲新功能、新趋势且给出行动的稿", notFor: "旧闻、或变化没有出处的稿",
    example: "AI 已经能直接操作你的表格了，先把这一步学会",
    redLine: [DEADLINE_RULE, "「变化」必须有出处，不能把猜测写成已发生"],
  },
  {
    id: "sharp-question", category: "thinking", name: "一针见血的问题",
    formula: "观众真在纠结的问题 + 暗示有答案",
    why: "问题本身就是钩子，被问中的人会想看答案",
    fits: "稿件正面回答了一个具体疑问", notFor: "稿里没有给出答案的（只问不答是骗点击）",
    example: "AI 写的东西为什么一看就是 AI 写的？",
  },
  {
    id: "a-or-b", category: "thinking", name: "二选一对比",
    formula: "A 还是 B + 怎么选",
    why: "替人做决定，省掉纠结",
    fits: "比较两种工具、做法并给出选择标准的稿", notFor: "只讲一样东西的稿",
    example: "该让 AI 写初稿，还是让它改你的稿？",
  },
  {
    id: "name-the-need", category: "thinking", name: "点破需求",
    formula: "你是不是也……（一个隐秘处境）+ 原因或解法方向",
    why: "说中没说出口的感受，人会觉得被理解",
    fits: "受众有共同的隐性困扰、稿里给了解释", notFor: "困扰太普遍、说出来没感觉的稿",
    example: "AI 明明都会用，为什么你还是天天加班",
  },
  {
    id: "small-to-big", category: "bigger-picture", name: "小处见大",
    formula: "一个具体细节 + 连到工作方式或生活方式",
    why: "从小切口看到大变化，有提升格局的感觉",
    fits: "从一个细节引出判断的观点稿", notFor: "纯操作教程",
    example: "从一封 AI 写的道歉信，看出谁会先被 AI 替代",
  },
  {
    id: "identity-call", category: "identity", name: "身份代入",
    formula: "点名一类具体的人 + TA 专属的问题",
    why: "人会自我归类，点到自己的身份就会停下",
    fits: "受众身份明确（按受众档案选核心或邻近受众）", notFor: "受众太泛、点名反而劝退的稿",
    example: "开小店的老板，用 AI 回差评先做这一步",
  },
  {
    id: "complete-guide", category: "list", name: "一篇讲全",
    formula: "全面词 + 核心问题 + 数量",
    why: "一次讲全给人收藏的理由",
    fits: "内容确实系统、覆盖完整的长稿", notFor: "只讲了一两点的短稿（叫「讲全」就是虚标）",
    example: "不写代码的人用 AI 办公，这 5 个用法一篇讲全",
    redLine: [NUMBER_RULE],
  },
];

export const TITLE_CORE_THINKING: readonly string[] = [
  "对一个人说话，不是对一类人：推荐是一条一条推到某个具体的人面前的，要让刷到的那个人觉得「这是在说我」。",
  "写前三问：谁在看？TA 此刻在想什么？TA 想要什么？",
  "用画像，不用人群词：直接用创作者档案里已确认的受众画像（核心 / 邻近 / 意外），不另造人。",
];

export const TITLE_CHECKLIST: readonly string[] = [
  "针对性：指向一个具体的人或场景吗？",
  "情绪：能触发担心、期待或好奇吗？",
  "价值：观众能拿走什么（省事、少踩坑、看懂一件事）？",
  "留悬念：看完标题还需要点进来吗？答案全说完就失败。",
  "张力：对比、数字、悬念、冲突、结果承诺里至少占两样。",
  "真实：见真实性红线。",
];

export const TITLE_RED_LINE: readonly string[] = [
  "标题里出现的数字、权威、时限、他人反应，必须能在定稿或证据台账里找到；找不到就换方法，不硬套。",
  DEADLINE_RULE, AUTHORITY_RULE, NUMBER_RULE, REACTION_RULE,
  "稿件太短太空、撑不起有张力的标题，就直接告诉创始人内容撑不起，不硬凑。",
];

export const PLATFORM_TITLE_TONE: Readonly<Record<string, string>> = {
  xiaohongshu: "可带 1 个 emoji，口语、第一人称更亲切",
  douyin: "少用 emoji，前半句就给冲突或悬念",
  wechat_video: "少用 emoji，语气稳重，别太网感",
  bilibili: "可用【】标类型，信息量可以多一点",
};
