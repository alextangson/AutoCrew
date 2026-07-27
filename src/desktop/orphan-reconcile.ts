/**
 * 孤儿占位稿 reconcile — server 崩溃/被杀时，后台生成来不及走失败路径，
 * 占位稿会永远停在「［生成中］/drafting」（SESSION-8 §3.1）。启动时扫全部
 * 工作区，把这类稿标成与运行时失败同形状（标题前缀 + lastError），UI 现有
 * 中断徽章与重试入口直接生效，零前端改动。
 *
 * 只认生成占位稿哨兵（GENERATING_TITLE_PREFIX）：content-save 允许手工稿
 * 也存 drafting，不能按 status 一刀切。不设「N 分钟无更新」门槛——本进程
 * 启动瞬间不可能有存活的本进程生成；唯一误伤面是并行 MCP 进程正在写的稿，
 * 而它转正/失败时会整体覆盖标题与 lastError，误标可自愈。
 */
import { listWorkspaces } from "./workspace-store.js";
import { listContents, updateContent } from "../storage/local-store.js";
import {
  GENERATING_TITLE_PREFIX,
  INTERRUPTED_TITLE_PREFIX,
} from "../modules/writing/generate-script.js";
import { emitEngineEvent } from "./event-hub.js";

export interface OrphanReconcileResult {
  /** 标记数 >0 的工作区：id → 篇数 */
  markedByWorkspace: Record<string, number>;
  total: number;
}

const ORPHAN_ERROR = "server 重启:上次生成没跑完,内容未写入。点「重新生成」重写。";

export async function reconcileOrphanDrafts(): Promise<OrphanReconcileResult> {
  const { workspaces } = await listWorkspaces();
  const markedByWorkspace: Record<string, number> = {};
  let total = 0;

  for (const ws of workspaces) {
    let marked = 0;
    try {
      const contents = await listContents(ws.dataDir);
      for (const c of contents) {
        if (c.status !== "drafting") continue;
        if (c.lastError) continue; // 运行时失败路径已标过,保留真实错误原因
        if (!c.title.startsWith(GENERATING_TITLE_PREFIX)) continue; // 手工 drafting 稿不动
        try {
          const updated = await updateContent(
            c.id,
            {
              title: `${INTERRUPTED_TITLE_PREFIX}${c.title.slice(GENERATING_TITLE_PREFIX.length)}`,
              lastError: ORPHAN_ERROR,
            },
            ws.dataDir,
          );
          if (updated) marked += 1;
        } catch (err) {
          // updateContent 现在写失败会 throw:单篇标记失败留痕后继续,不中断本工作区其余稿件
          console.warn(`[orphan-reconcile] mark ${c.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch {
      continue; // 单工作区坏数据不阻断其余工作区的清理
    }
    if (marked > 0) {
      markedByWorkspace[ws.id] = marked;
      total += marked;
      // 任务动态带留痕(观测层,emitEngineEvent 自吞错)——「看得见」是失败边界的一部分
      await emitEngineEvent(
        {
          role: "system",
          kind: "work",
          label: `server 重启:${marked} 篇写到一半的稿子已标记中断,看板点开可重试`,
        },
        ws.dataDir,
      );
    }
  }

  return { markedByWorkspace, total };
}
