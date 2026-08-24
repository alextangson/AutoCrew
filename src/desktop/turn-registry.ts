/**
 * 活跃 turn 注册表 + recent-turns 有界环
 * （对话控制面设计 §Phase 3「turn 寻址与中止链路」+「断线恢复契约」）。
 *
 * 为什么要有：「停止」这个动作必须有可寻址的目标。turnId 由客户端生成随 chat:turn 传入，
 * 服务端在这里登记 AbortController，chat:abort 按 (turnId, clientId) 找回来掐。
 *
 * 四条纪律：
 * 1. **归属**：clientId 是每标签页的命名空间——另一个标签页拿到 turnId 也中止不了别人的轮
 *    （本地单用户下 server-token 已鉴权，clientId 解决的是标签页间串扰）。
 * 2. **busy 到 settle**：abort 之后条目转 `stopping` 但不删，直到原 chat:turn 真正收尾才清。
 *    否则用户点完停止立刻再发言，新轮会和上一轮的收尾工具并行跑。
 * 3. **重复 turnId 拒绝**：活跃表里已有同名 turnId 直接拒——寻址表里不许有两个同名目标。
 * 4. **done 判定不靠内存**：settle 时把 turnId → conversationId 写进有界环（50 条，覆盖写），
 *    服务端重启/首轮响应丢失后，前端还能凭 turnId 查到会话去 refetch。环写失败不抛
 *    ——观测层不得拖垮执行层（与 recent-actions 同纪律）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

const FILE = "recent-turns.json";
const RING_MAX = 50;

export interface RecentTurn {
  turnId: string;
  conversationId?: string;
  /** ISO 时间戳 */
  at: string;
}

/** running = 正常跑；stopping = 已收到 abort，等原 turn 收尾 */
export type ActiveTurnStatus = "running" | "stopping";

interface ActiveTurn {
  controller: AbortController;
  clientId: string;
  conversationId?: string;
  status: ActiveTurnStatus;
  startedAt: number;
}

const active = new Map<string, ActiveTurn>();

export type RegisterTurnResult =
  | { ok: true; signal: AbortSignal }
  | { ok: false; error: string };

/**
 * 登记一轮。重复 turnId、或该 client 上一轮还没 settle，都直接拒（错误形态沿用 invoke 惯例）。
 * 同步实现是刻意的：check-and-register 中间不许有 await，否则连点两次会双双登记成功。
 */
export function registerTurn(
  turnId: string,
  clientId: string,
  opts?: { conversationId?: string },
): RegisterTurnResult {
  if (active.has(turnId)) {
    return { ok: false, error: "这一轮已经在跑了，别重复发（turn 重复）" };
  }
  for (const entry of active.values()) {
    if (entry.clientId !== clientId) continue;
    return {
      ok: false,
      error: entry.status === "stopping" ? "上一轮正在停止，等它收尾后再发" : "上一轮还在进行，等它收尾后再发",
    };
  }
  const controller = new AbortController();
  active.set(turnId, {
    controller,
    clientId,
    ...(opts?.conversationId ? { conversationId: opts.conversationId } : {}),
    status: "running",
    startedAt: Date.now(),
  });
  return { ok: true, signal: controller.signal };
}

/**
 * - `settling`：命中且归属匹配，已 abort，条目转 stopping（保持到原 turn settle）
 * - `not_found`：未命中（已完成/未知）——调用方按幂等回 already:"done"
 * - `forbidden`：turnId 存在但不是这个 client 发起的——不代别的标签页做主
 */
export type AbortOutcome = "settling" | "not_found" | "forbidden";

export function abortTurn(turnId: string, clientId: string): AbortOutcome {
  const entry = active.get(turnId);
  if (!entry) return "not_found";
  if (entry.clientId !== clientId) return "forbidden";
  entry.status = "stopping";
  if (!entry.controller.signal.aborted) entry.controller.abort(new Error("用户中止本轮对话"));
  return "settling";
}

/**
 * 这段会话上有没有还没收尾的轮（含 stopping——它要到原轮真收尾才清）。
 * 后台回流轮靠它避让：用户正打着字等回复时，总编辑不该从旁边插一段进来。
 * 只看得见**登记过**的轮：老前端不带 turn_id 的轮不在表里（那条路本来就不可寻址）。
 */
export function hasActiveTurnForConversation(conversationId: string): boolean {
  for (const entry of active.values()) {
    if (entry.conversationId === conversationId) return true;
  }
  return false;
}

/** 记下本轮落在哪个会话（首轮建会话后回填，turn_status 的 running 态也能给出会话） */
export function noteTurnConversation(turnId: string, conversationId: string): void {
  const entry = active.get(turnId);
  if (entry) entry.conversationId = conversationId;
}

/** turn 收尾：写有界环（done 判定的持久事实源）并清活跃条目。永不抛。 */
export async function settleTurn(
  turnId: string,
  opts?: { conversationId?: string; dataDir?: string; at?: string },
): Promise<void> {
  const entry = active.get(turnId);
  active.delete(turnId);
  const conversationId = opts?.conversationId ?? entry?.conversationId;
  try {
    const entryOut: RecentTurn = {
      turnId,
      ...(conversationId ? { conversationId } : {}),
      at: opts?.at ?? new Date().toISOString(),
    };
    const next = [...(await readRing(opts?.dataDir)).filter((t) => t.turnId !== turnId), entryOut].slice(-RING_MAX);
    const dir = getDataDir(opts?.dataDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, FILE), JSON.stringify(next), "utf-8");
  } catch (err) {
    console.warn(`[turn-registry] 记录 turn 索引失败（不影响本轮结果）：${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface TurnStatusView {
  status: "running" | "done" | "unknown";
  conversationId?: string;
}

/** 三态查询：活跃注册表（running）→ 有界环（done）→ unknown。stopping 对外仍是 running（还没收尾）。 */
export async function getTurnStatus(turnId: string, dataDir?: string): Promise<TurnStatusView> {
  const entry = active.get(turnId);
  if (entry) {
    return { status: "running", ...(entry.conversationId ? { conversationId: entry.conversationId } : {}) };
  }
  const hit = (await readRing(dataDir)).find((t) => t.turnId === turnId);
  if (hit) return { status: "done", ...(hit.conversationId ? { conversationId: hit.conversationId } : {}) };
  return { status: "unknown" };
}

async function readRing(dataDir?: string): Promise<RecentTurn[]> {
  try {
    const raw = await fs.readFile(path.join(getDataDir(dataDir), FILE), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is RecentTurn =>
        t !== null && typeof t === "object" && typeof (t as RecentTurn).turnId === "string" && typeof (t as RecentTurn).at === "string",
    );
  } catch {
    // 文件不存在/坏了都当空环——查不到就是 unknown，前端提示可重发
    return [];
  }
}

/** 测试用：读环内容 */
export async function readRecentTurns(dataDir?: string): Promise<RecentTurn[]> {
  return readRing(dataDir);
}

/** 测试用：清空进程内活跃表（不碰环文件） */
export function resetActiveTurns(): void {
  active.clear();
}
