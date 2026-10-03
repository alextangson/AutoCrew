/**
 * 评分表 rubric.json（规格 §一）：盲评通道 B 的白名单文件。
 *
 * 起步公式 = cheat-on 观点视频 v2（已校准权重，原样保留）；维度定义用我们自己的话重写，例子换成
 * 「不写代码的职场人用 AI」这一受众的场景。这里只放通用规则：不得出现样本名、数据、评论、链接——
 * 写盘前过 BLIND_LEAK_RE 兜底自检，命中就拒写（observation-lifecycle.md leak guard）。
 */
import { BLIND_LEAK_RE } from "./constants.js";

export const CORE_DIMS = ["ER", "SR", "HP", "QL", "NA", "AB", "SAT"] as const;
export const TRIAL_DIMS = ["MS", "TS"] as const;
export const ALL_DIMS = [...CORE_DIMS, ...TRIAL_DIMS] as const;
export type DimKey = (typeof ALL_DIMS)[number];

export interface RubricDimension {
  key: DimKey;
  name: string;
  question: string;
  anchors: { "0": string; "3": string; "5": string };
  note?: string;
}

export interface RubricFormula {
  /** 进综合分的维度与权重；不在这里的维度（如试评分维度）不进综合分 */
  weights: Partial<Record<DimKey, number>>;
  divisor: number;
  multiplier: number;
}

export interface RubricObservationLine { id: string; stage: string; text: string }

export interface Rubric {
  version: string;
  formula: RubricFormula;
  formula_text: string;
  scale: string;
  dimensions: RubricDimension[];
  /** 只试评分、不进综合分的候选维度 */
  trial_dimensions: DimKey[];
  /** 观察区：只放抽象规则（id + 一句话），由 rubric-memo 的生命周期投影过来 */
  observations: RubricObservationLine[];
  /** 版本速查表 */
  changelog: Array<{ version: string; date: string; formula_text: string }>;
}

const DIMENSIONS: RubricDimension[] = [
  { key: "ER", name: "情感共鸣", question: "前 30 秒能不能让观众生出一种说得出名字的情绪？",
    anchors: { "0": "只在讲信息，没有情绪抓手", "3": "一般共鸣：「嗯，我也有过」", "5": "具体到让人有点不想承认：「这说的就是我」" },
    note: "例：下班前被领导一句「明早给我」逼着拿 AI 赶周报、交出去才发现编了数——认出自己，又有点难堪。" },
  { key: "SR", name: "社会议题共振", question: "有没有碰到一个当下的、有争议的、或结构性的社会模式？",
    anchors: { "0": "纯个人或人际层面", "3": "碰到公认的现象（职场、家庭）但没给新视角", "5": "说出观众都感觉得到、却一直没词形容的结构" },
    note: "例：「会用 AI 的人没变轻松，反而被派了更多活」——把效率红利流向谁说破了。" },
  { key: "HP", name: "钩子强度", question: "前 3 秒能不能逼观众再看 30 秒？",
    anchors: { "0": "通用开场：「大家好，今天聊聊……」", "3": "具体的承诺或反直觉断言", "5": "一个具体到停不下来的场景或断言" },
    note: "钩子不等于猎奇；一句安静但具体的话（「你让 AI 写的那封邮件，客户其实看出来了」）也可以满分。" },
  { key: "QL", name: "金句密度", question: "有没有 2–3 句离开视频也能单独被截图转走的话？",
    anchors: { "0": "全是叙述，没有警句", "3": "结尾有一句记得住的", "5": "开头、中段、结尾都有能独立活下去的句子" },
    note: "看的是离开视频后还能不能在评论区、朋友圈、微信群里独立存活，不是数量。" },
  { key: "NA", name: "叙事性", question: "有没有铺垫—升级—收束的弧线，还是论点平铺？",
    anchors: { "0": "清单式结构", "3": "有一条松散主线", "5": "紧凑三幕，结尾的回报开头就埋好了" },
    note: "观点视频里它是打平时的参考维度，不是主驱动。" },
  { key: "AB", name: "受众广度", question: "这个议题潜在能被多少人认领？",
    anchors: { "0": "很窄（某个专业圈或单一兴趣）", "3": "一类人群（如做行政的、带小团队的）", "5": "几乎人人（上班、家庭、钱）" },
    note: "广不等于愿意转发；转发意愿看候选维度 TS。" },
  { key: "SAT", name: "讽刺深度", question: "有没有用多层反讽、戏仿格式或自嘲？",
    anchors: { "0": "真诚直陈", "3": "一层反讽", "5": "嵌套或自指的反讽（用某种格式去讲这种格式本身）" },
    note: "走真诚路线的账号给 3 占位，别让它左右排序。" },
  { key: "MS", name: "模因可挪用（候选，只试评分）", question: "观众能不能套用这期的句式自己造句？",
    anchors: { "0": "金句只能被原样引用", "3": "句式偶尔能套", "5": "评论区会主动拿这个句式造句、自嘲" },
    note: "例：「不是 AI 不行，是你的需求说了三遍还是一个意思」——能被套成别的场景。" },
  { key: "TS", name: "议题分享冲动（候选，只试评分）", question: "观众转发这条，会不会暴露 TA 不想暴露的处境？",
    anchors: { "0": "转发等于承认一件难堪的事（如被裁、被领导否定、能力跟不上）", "3": "转发是中性的", "5": "转发本身就是表态或安全的自嘲（集体吐槽、站队、圈内黑话）" },
    note: "转给同事看会不会尴尬：「转这条=承认我不会用 AI」压分；「转这条=吐槽老板乱派活」加分。" },
];

export const DEFAULT_RUBRIC: Rubric = {
  version: "v2",
  formula: { weights: { ER: 1.5, SR: 1.5, HP: 1.5, QL: 1, NA: 1, AB: 1, SAT: 1 }, divisor: 8.5, multiplier: 2.0 },
  formula_text: "composite = (ER×1.5 + SR×1.5 + HP×1.5 + QL + NA + AB + SAT) / 8.5 × 2.0",
  scale: "每维 0–5 整数；综合分 0–10。打分只看稿子本身，先盲打再对比。",
  dimensions: DIMENSIONS,
  trial_dimensions: ["MS", "TS"],
  observations: [],
  changelog: [{ version: "v2", date: "2026-10-03", formula_text: "composite = (ER×1.5 + SR×1.5 + HP×1.5 + QL + NA + AB + SAT) / 8.5 × 2.0" }],
};

export type DimScores = Partial<Record<DimKey, number>>;

/** 综合分：Σ(权重×分)/除数×乘数，保留两位；缺进分维度 → null（不拿 0 冒充） */
export function composite(scores: DimScores, formula: RubricFormula): number | null {
  let sum = 0;
  for (const [dim, w] of Object.entries(formula.weights) as Array<[DimKey, number]>) {
    const s = scores[dim];
    if (typeof s !== "number") return null;
    sum += w * s;
  }
  return Math.round((sum / formula.divisor) * formula.multiplier * 100) / 100;
}

export function formulaText(f: RubricFormula): string {
  const terms = (Object.entries(f.weights) as Array<[string, number]>).map(([d, w]) => (w === 1 ? d : `${d}×${w}`));
  return `composite = (${terms.join(" + ")}) / ${f.divisor} × ${f.multiplier}`;
}

/** 盲评白名单自检：返回命中的片段；空 = 干净 */
export function rubricLeaks(rubric: Rubric): string[] {
  const hits: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") { const m = v.match(BLIND_LEAK_RE); if (m) hits.push(v.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + 20)); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(rubric);
  return hits;
}

/** 内容形态是否与观点视频 rubric 匹配：口播（视频平台）= 匹配；长文/图文 = 借用，标 mismatch */
export function rubricFormMismatch(platform: string, videoPlatforms: ReadonlySet<string>): boolean {
  return !videoPlatforms.has(platform);
}
