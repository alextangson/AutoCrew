/** 比对器的注入口：转写器、时钟、暂停开关。测试一律注入假的（全局测试安全网默认「转写没就绪」） */
import { getVideoSettingsRaw } from "../../../desktop/settings-video.js";
import { THRESHOLDS, type Thresholds } from "./decide.js";
import { funasrTranscriber, type MatchTranscriber } from "./transcribe.js";

export interface MatchDeps {
  transcriber: MatchTranscriber;
  now: () => number;
  /** 设置里「暂停自动找原片」：只停自己去找的转写（1b §2） */
  paused: (dataDir: string) => Promise<boolean>;
  /** L2 阈值与「已校准」开关：生产代码只用 decide.ts 的常量；测试注入以覆盖「校准后」的分支 */
  thresholds: Thresholds;
}

const defaults = (): MatchDeps => ({
  transcriber: funasrTranscriber(),
  now: () => Date.now(),
  thresholds: THRESHOLDS,
  paused: async (dataDir) => (await getVideoSettingsRaw(dataDir)).arollAutoFindPaused === true,
});

let current: MatchDeps | null = null;

export function matchDeps(): MatchDeps {
  return (current ??= defaults());
}

export function setMatchDeps(patch: Partial<MatchDeps> | null): void {
  current = patch ? { ...matchDeps(), ...patch } : null;
}
