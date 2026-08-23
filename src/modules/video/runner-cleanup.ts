/**
 * 成片收尾清理的调度那一半（lifecycle spec §3.3）——runner 的一块，
 * 单独成文件与 `runner-preview.ts` 同款：让「它只动 cleanup 三字段、不动 phase/state」看得见。
 *
 * 清理不是管线的一步，是收尾的副作用：状态一个字都不改，只把 `cleanup`
 * 从 pending 推到 done/warning。队列、串行、写状态的原语由 runner 注入。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isContentId } from "../../storage/entity-id.js";
import { runVideoCleanup } from "./cleanup.js";
import { readVideoState } from "./video-store.js";
import type { VideoState } from "./types.js";

export interface CleanupRunnerDeps {
  dataDir: string;
  now: () => string;
  report: (message: string) => void;
  writeState: (contentId: string, mutate: (cur: VideoState | null) => VideoState) => Promise<VideoState>;
  enqueue: (contentId: string) => void;
}

export interface CleanupRunner {
  run(contentId: string): Promise<void>;
  /** 启动时把死在半路的清理接着做完（§4 #9）。返回重排条数 */
  resume(): Promise<number>;
}

export function createCleanupRunner(ctx: CleanupRunnerDeps): CleanupRunner {
  /** 只对「已完成 + 清理还没做完」的稿件动手；别的一律不碰（旧稿不回溯清理，§4 #14） */
  async function run(contentId: string): Promise<void> {
    const { state } = await readVideoState(ctx.dataDir, contentId);
    if (!state || state.phase !== "done" || state.state !== "done") return;
    if (state.cleanup?.status !== "pending") return;
    const approvedRevision = state.cleanup.approvedRevision;
    const result = await runVideoCleanup(ctx.dataDir, contentId, approvedRevision);
    const note = result.warnings.join("；");
    await ctx.writeState(contentId, (cur) => ({
      ...cur!,
      cleanup: {
        status: result.warnings.length > 0 ? "warning" : "done",
        approvedRevision,
        // 重开再通过时会清第二次：累加才是「这一稿总共释放了多少」
        freedBytes: (cur!.cleanup?.freedBytes ?? 0) + result.freedBytes,
        ...(note ? { note } : {}),
        finishedAt: ctx.now(),
      },
    }));
    if (note) ctx.report(`${contentId} 的收尾清理有清不掉的：${note}`);
  }

  async function resume(): Promise<number> {
    let ids: string[];
    try {
      ids = await fs.readdir(path.join(ctx.dataDir, "contents"));
    } catch {
      return 0;
    }
    let count = 0;
    for (const contentId of ids) {
      // contents/ 下混着 .DS_Store 之类的东西；非法 id 会让 readVideoState 直接抛
      if (!isContentId(contentId)) continue;
      const { state } = await readVideoState(ctx.dataDir, contentId);
      if (state?.phase !== "done" || state.cleanup?.status !== "pending") continue;
      ctx.enqueue(contentId);
      count += 1;
    }
    return count;
  }

  return { run, resume };
}
