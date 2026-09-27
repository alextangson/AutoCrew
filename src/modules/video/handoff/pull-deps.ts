/**
 * 认稿自接的外部依赖注入口：转写器、系统弹窗、Downloads 目录、时钟。
 * 生产用真的；测试用 `setPullDeps` 换成假的——绝不真跑 FunASR、不弹真窗、不碰真 ~/Downloads。
 */
import os from "node:os";
import path from "node:path";
import { osascriptDialog, type DialogRunner } from "./dialog.js";
import { funasrTranscriber, type MatchTranscriber } from "./match-l2.js";

export interface PullDeps {
  transcriber: MatchTranscriber;
  dialog: DialogRunner;
  /** 撤回时原路径被占就放回这里（加后缀） */
  downloadsDir: string;
  now: () => number;
  /** 测试专用崩溃点：在给定步骤抛错模拟进程死掉（生产是空操作） */
  checkpoint: (step: string) => void;
}

const defaults = (): PullDeps => ({
  transcriber: funasrTranscriber(),
  dialog: osascriptDialog,
  downloadsDir: path.join(os.homedir(), "Downloads"),
  now: Date.now,
  checkpoint: () => undefined,
});

let current: PullDeps | null = null;

export function pullDeps(): PullDeps {
  return (current ??= defaults());
}

/** 测试专用：部分覆盖；传 null 复位 */
export function setPullDeps(patch: Partial<PullDeps> | null): void {
  current = patch ? { ...defaults(), ...patch } : null;
}
