/**
 * 赛道包类型合同（PRD §8）：一个赛道包 = 钩子集 + 结构骨架 + 成功指标定义 + 合规叠加引用。
 * 包是数据不是代码——换赛道/调参改包文件，引擎与打分逻辑不动。
 */
import type { OutcomeMetrics } from "../flywheel/outcome-schema.js";
import type { ClipboardPlatform } from "../publish/clipboard-publisher.js";

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

/**
 * Quality Gate 阈值组（PRD-v4 §4.3 / P0 附录 0-2）：生成后确定性自检，
 * FAIL 反馈进修复轮（writing/quality-gate.ts 执行）。只收可判定检查——
 * 案例数这类不可判定项留在 structure 规则句里，不做假判定。
 */
export interface QualityGateSpec {
  /** 全文（hook+body+cta）最少中文字符数 */
  minChars?: number;
  /** 最少数据引用处数（数字+量纲/百分比，正则口径见 quality-gate.ts） */
  minDataPoints?: number;
  /** 正文最少 [IMAGE: prompt] 配图标记数 */
  minImageTags?: number;
  /** Hook 反模式（RegExp source，对 hook 开头测试），命中即 FAIL */
  bannedHookPatterns?: string[];
  /** Gate FAIL 后允许的修复提交轮数；超限接受最后一稿并透出未过项。默认 2 */
  maxRepairRounds?: number;
}

/** 长文结构模式（thesis-driven 等）：编剧按选题选一种 */
export interface StructureMode {
  id: string;
  name: string;
  guide: string;
}

export interface TrackPack {
  id: string;
  name: string;
  version: number;
  /** 成功指标：default 兜底，byPlatform 按平台覆盖 */
  reward: {
    default: PlatformReward;
    byPlatform?: Partial<Record<ClipboardPlatform, PlatformReward>>;
  };
  hooks: HookPattern[];
  /** 结构骨架：每段是给编剧（人或模型）的规则句 */
  structure: {
    hook: string[];
    body: string[];
    cta: string[];
  };
  selfReview: string[];
  platformAdjustments: Partial<Record<ClipboardPlatform, { chars: string; style: string }>>;
  /** 合规口径引用（具体过滤复用 humanizer/sensitive-words，包只声明口径） */
  complianceNote: string;
  /** 编剧角色一句话（system prompt 开头）；缺省 = 口播编剧 */
  writerRole?: string;
  /** 长文结构模式清单；缺省 = 不渲染该节 */
  structureModes?: StructureMode[];
  /** 质量硬门禁；缺省 = 无 gate（一次生成即提交） */
  qualityGate?: QualityGateSpec;
  /** 封面 prompt 模板（{theme} 占位）；发布链/封面阶段消费，生成阶段不用 */
  coverPromptTemplate?: string;
}
