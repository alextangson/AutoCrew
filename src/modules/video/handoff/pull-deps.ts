/**
 * 认稿自接的外部依赖注入口：转写器、系统弹窗、预览 open、通知窗、Downloads 目录、时钟。
 * 生产用真的；测试用 `setPullDeps` 换成假的——绝不真跑 FunASR、不弹真窗、不碰真 ~/Downloads。
 */
import os from "node:os";
import path from "node:path";
import { osascriptDialog, type DialogRunner } from "./dialog.js";
import { benchReachable, mediaDuration, osascriptNotifier, systemOpener, type Notifier, type Opener } from "./desktop-open.js";
import { funasrTranscriber, type MatchTranscriber } from "./match-l2.js";
import { probeAroll } from "../ingest.js";

export interface PullDeps {
  transcriber: MatchTranscriber;
  dialog: DialogRunner;
  /** 原片媒体探测（有画面、有音轨、不超 30 分钟）：认稿与弹窗确认前先挡掉交接会拒的文件 */
  probe: (file: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 撤回时原路径被占就放回这里（加后缀） */
  downloadsDir: string;
  /** 认稿弹窗里的预览：`open` 原片 / 定稿 / 工作台地址 */
  opener: Opener;
  /** 交接成功后的不阻塞通知窗 */
  notifier: Notifier;
  /** 工作台端口（服务实际端口）与探活 */
  benchPort: number;
  benchReachable: (url: string) => Promise<boolean>;
  /** 媒体时长（毫秒），读不出回 null */
  duration: (file: string) => Promise<number | null>;
  now: () => number;
  /** 测试专用崩溃点：在给定步骤抛错模拟进程死掉（生产是空操作） */
  checkpoint: (step: string) => void;
}

const defaults = (): PullDeps => ({
  transcriber: funasrTranscriber(),
  dialog: osascriptDialog,
  probe: (file) => probeAroll(file),
  downloadsDir: path.join(os.homedir(), "Downloads"),
  opener: systemOpener,
  notifier: osascriptNotifier,
  benchPort: Number(process.env.AUTOCREW_PORT) || 4317,
  benchReachable,
  duration: mediaDuration,
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
