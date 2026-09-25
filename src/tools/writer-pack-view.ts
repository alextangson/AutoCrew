/**
 * 写作包回执的形状——`pack` 与 `pack_status` 说同一份话（P3 §5.1、P6 §3.7）。
 *
 * 全是只看包文件的纯视图（`countPoll` 除外：轮询计数要落盘，才跨得过进程）。
 * 流程（领号、备料、同步等待、孤儿重跑）在 `writer-prepare.ts`；包文件本身在 `writer-pack.ts`。
 */
import { writingContinueParams } from "./writing-readiness.js";
import {
  isReadyPack,
  packBudget,
  readPack,
  renderPack,
  serializeWriterCall,
  writePack,
  writerProgress,
  type PackState,
  type ReadyPack,
  type WritingPackFile,
} from "./writer-pack.js";

export type Fail = { ok: false; error: string } & Record<string, unknown>;

/** 领号回执（备料还在跑） */
export interface PackPreparingResult extends Record<string, unknown> {
  ok: true;
  status: "preparing";
  content_id: string;
  pack_id: string;
  note: string;
}

/** 备料完成的完整回执——**与改异步之前那份同步 `pack` 的返回体逐字段相同** */
export interface PackReadyResult extends Record<string, unknown> {
  ok: true;
  status: "ready";
  content_id: string;
  pack_id: string;
  pack_md: string;
  budget: ReturnType<typeof packBudget>;
  note: string;
}

export interface PackStatusResult extends Record<string, unknown> {
  ok: true;
  status: PackState;
  pack_id: string;
  started_at: string;
  elapsed_s: number;
}

export type PackResult = PackPreparingResult | PackReadyResult | PackStatusResult | Fail;

export const POLL_NOTE = "正在装配本地写作材料：隔 poll_after_seconds 用 pack_status{content_id} 查，至多 3 次；status=ready 之后再动笔，宿主模式不会启动后台模型。";
export const FIRST_NOTE = "写完用 submit 交回来；数字要能指到证据编号，缺证据先 find_evidence。";

function elapsedSeconds(iso: string): number {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

export function readyResult(contentId: string, pack: ReadyPack): PackReadyResult {
  return {
    ok: true,
    status: "ready",
    content_id: contentId,
    pack_id: pack.packId,
    pack_md: renderPack(contentId, pack),
    budget: packBudget(pack),
    note: pack.note ?? FIRST_NOTE,
    ...writerProgress(pack),
  };
}

/** The same frozen facts must survive repeated pack calls and process restarts. */
export function preparationProgress(contentId: string, pack: WritingPackFile): Record<string, unknown> {
  return {
    preparation: pack.request?.readiness ?? {
      status: "unknown",
      note: "旧写作包未记录领包时的研究与立意状态，不能追认为已完成。",
    },
    writing_source: { kind: "host", host: pack.host },
    next_action: { tool: "autocrew_writer", params: { action: "pack_status", content_id: contentId } },
    // 宿主模式几秒就备完，5 秒回查；engine 模式的补证仍是分钟级
    poll_after_seconds: pack.request?.req.modelExecution === "engine" ? 30 : 5,
  };
}

/** 重领这份包的下一步：备料失败与卡住都指向带原请求的 pack{force:true} */
function repackAction(pack: WritingPackFile): Record<string, unknown> {
  const req = pack.request?.req;
  return req?.topicId ? { next_action: { tool: "autocrew_writer", params: { ...writingContinueParams(req.topicId, req), action: "pack", force: true } } } : {};
}

/** 三态回执（`pack` 同步等到结果时回的也是这一份，外加 `synchronous:true`） */
export function packView(contentId: string, pack: WritingPackFile): PackStatusResult {
  const base = { ok: true as const, status: pack.state, content_id: contentId, pack_id: pack.packId, started_at: pack.issuedAt, elapsed_s: elapsedSeconds(pack.issuedAt) };
  if (isReadyPack(pack)) return { ...base, ...readyResult(contentId, pack), status: "ready" as const };
  if (pack.state === "failed") {
    return {
      ...base,
      ...preparationProgress(contentId, pack),
      ...(pack.reason ? { reason: pack.reason } : {}),
      error: pack.error ?? "未记原因",
      note: "这份包没备成，别动笔——pack{force:true} 重来一次；连着失败就先跑 autocrew_workflow doctor 看线路。",
      ...repackAction(pack),
    };
  }
  return { ...base, ...preparationProgress(contentId, pack), note: POLL_NOTE };
}

/** 等待的终点（P6 §5 轮询 ≤3 次）：再查就不许宿主空转，给出重领的下一步 */
export function stalledResult(contentId: string, pack: WritingPackFile): Fail {
  return {
    ok: false,
    code: "pack_stalled",
    status: "needs_review",
    error: "备料超过预期仍未就绪",
    content_id: contentId,
    pack_id: pack.packId,
    polls: pack.polls ?? 0,
    elapsed_s: elapsedSeconds(pack.issuedAt),
    note: "别再轮询：告诉创作者备料卡住了，按 next_action 重领（force:true，旧号作废）；接连卡住先跑 autocrew_workflow doctor。",
    ...repackAction(pack),
  };
}

/** 轮询计数落盘（排进写手队列，不与备料写回互相覆盖）；包已不在 preparing 就不计，回最新的包 */
export function countPoll(contentId: string, dataDir: string): Promise<WritingPackFile | null> {
  return serializeWriterCall(contentId, async () => {
    const pack = await readPack(contentId, dataDir);
    if (pack?.state !== "preparing") return pack;
    const counted = { ...pack, polls: (pack.polls ?? 0) + 1 };
    await writePack(contentId, counted, dataDir);
    return counted;
  });
}
