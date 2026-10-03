/**
 * 判断要对账（docs/2026-10-03-prediction-calibration-spec.md）的常数。
 *
 * 全部照搬 cheat-on-content（MIT）已验证过的协议常数，只读不配：改它们本身是一次「元层级升级」，
 * 不是某次升级里能顺手调的旋钮（bump-validation-protocol.md：THRESHOLD 写死）。
 */

/** 复盘窗口：T+3d 主复盘（cheat-retro RETRO_WINDOW_DAYS） */
export const RETRO_WINDOW_DAYS = 3;
/** D+7 追加一次读数 */
export const FOLLOWUP_READING_DAY = 7;
/** 盲评与主通道单维分差 ≥ 此值 → 摆给创始人裁定（cheat-predict DISAGREEMENT_THRESHOLD） */
export const DISAGREEMENT_THRESHOLD = 2;
/** 盲度检查只有 strict（lenient 仅供演练，这里不提供） */
export const BLIND_CHECK = "strict" as const;
/** 升级排序一致性阈值 4/5 = 80%（写死；冻结防运行时改） */
export const BUMP_RULES = Object.freeze({ THRESHOLD: 0.8, RANK_DELTA_TOLERANCE: 1 });
/** 升级审计理由最少字数（cheat-bump Phase 4：≥100 字） */
export const AUDIT_REASON_MIN_CHARS = 100;
/** 「何时可以提议」的软门槛（可显式写理由打破）：校准池 ≥5、距上次升级 ≥3 条新样本 */
export const SOFT_MIN_POOL = 5;
export const SOFT_MIN_NEW_SAMPLES = 3;
/** 复盘偏差判定：实绩偏离中枢 ±25% 外才算一次方向性偏差；连续 3 次同向提示升级 */
export const DIRECTIONAL_TOLERANCE = 0.25;
export const DIRECTIONAL_STREAK = 3;
/** 单次 ≥10 倍偏差也提示升级（judgment-driven） */
export const EXTREME_DEVIATION_RATIO = 10;
/** 每 10 条新校准样本提示一次清算（创始人裁定） */
export const CLEANUP_EVERY_SAMPLES = 10;
/** 样本 ≥10 → 用校准池自己的中位数重算基线（state-management.md） */
export const BASELINE_RECALC_SAMPLES = 10;
/** 对标导入（cheat-learn-from） */
export const LEARN_MIN_SAMPLES = 3;
export const LEARN_MAX_SAMPLES_PER_RUN = 15;
/** 观察升格默认门槛：跨视频观察 ≥2 样本 */
export const CROSS_VIDEO_MIN_SAMPLES = 2;
/** 冷启动（校准样本 0–2）时概率分布要更平：最高一档不超过 50%（opinion-video-zero：30%–50% 而非 ≥80%） */
export const COLD_START_SAMPLES = 3;
export const COLD_START_MAX_PROB = 50;
/** 盲评白名单兜底自检（observation-lifecycle.md Blind channel leak guard） */
export const BLIND_LEAK_RE = /\d+\s*[wWmMkK万]|播放|实绩|实际/;

export const STATE_SCHEMA_VERSION = "1.4";
