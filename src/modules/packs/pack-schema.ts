/**
 * 赛道包类型合同（PRD §8）：一个赛道包 = 钩子集 + 结构骨架 + 成功指标定义 + 合规叠加引用。
 * 包是数据不是代码——换赛道/调参改包文件，引擎与打分逻辑不动。
 */
import type { OutcomeMetrics } from "../flywheel/outcome-schema.js";

export type MetricKey = keyof OutcomeMetrics;

export interface PlatformReward {
  /** 该平台的头号信号（报表强调用） */
  primary: MetricKey;
  /** 打分权重：score = Σ weights[k] × metrics[k]。量纲注意：completion 类为 0-100 百分比，views 为原始计数 */
  weights: Partial<Record<MetricKey, number>>;
  /** 平台特殊性说明（如缺列、代理信号理由） */
  note?: string;
}

export interface HookPattern {
  type: string;
  whenToUse: string;
}

export interface TrackPack {
  id: string;
  name: string;
  version: number;
  /** 成功指标：default 兜底，byPlatform 按平台覆盖 */
  reward: {
    default: PlatformReward;
    byPlatform?: Record<string, PlatformReward>;
  };
  hooks: HookPattern[];
  /** 结构骨架：每段是给编剧（人或模型）的规则句 */
  structure: {
    hook: string[];
    body: string[];
    cta: string[];
  };
  selfReview: string[];
  platformAdjustments: Record<string, { chars: string; style: string }>;
  /** 合规口径引用（具体过滤复用 humanizer/sensitive-words，包只声明口径） */
  complianceNote: string;
}
