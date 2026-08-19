/**
 * 流式 delta 的纯状态机（对话控制面设计 §Phase 3「流式 delta 协议」）。
 *
 * 为什么单独一个模块：SSE 是广播——本页发起的轮、别的标签页的轮、上一轮的迟到帧
 * 全从同一根管子出来，「这一帧该不该进气泡」是要断言的判断，ChatDock 只负责接线与渲染。
 *
 * 三条规则：
 * 1. 只认当前活跃 turnId，其余一律丢弃（异 turn / 旧 turn 不污染当前气泡）；
 * 2. seq 服务端单调递增，收到 <= 已见 seq 的帧丢弃（重复投递/乱序都当迟到帧处理）；
 * 3. reset 清空累积（失败 attempt 与工具往返的上一轮都不该留在屏幕上）。
 *
 * 事实源永远是 chat:turn 的 invoke 返回——done 只表示「别再等字了」，
 * 真正的回复到达时调用方直接 clear + 用响应全量覆盖。
 */

export interface DeltaFrame {
  turnId: string;
  seq: number;
  ev: "delta" | "reset" | "done";
  text?: string;
}

export interface DeltaStream {
  /** null = 当前没有在跑的轮，任何帧都不收 */
  turnId: string | null;
  /** 已消费的最大 seq（-1 = 还没收过帧） */
  seq: number;
  /** 当前 attempt 累积的正文 */
  text: string;
  /** 流已结束，等 invoke 返回（UI 显示「整理回复中」） */
  done: boolean;
}

export const EMPTY_STREAM: DeltaStream = { turnId: null, seq: -1, text: "", done: false };

/** 新一轮开始：turnId 换人，累积清零 */
export function startStream(turnId: string): DeltaStream {
  return { turnId, seq: -1, text: "", done: false };
}

/** 本轮收尾（invoke 已返回，回复由响应全量覆盖）：回到不收帧的状态 */
export function clearStream(): DeltaStream {
  return EMPTY_STREAM;
}

/**
 * 收一帧。不相干/迟到的帧原样返回同一个对象引用——调用方 setState 时可据此免掉重渲染。
 */
export function applyDelta(state: DeltaStream, frame: DeltaFrame): DeltaStream {
  if (!state.turnId || frame.turnId !== state.turnId) return state;
  if (!Number.isFinite(frame.seq) || frame.seq <= state.seq) return state;
  if (frame.ev === "reset") return { ...state, seq: frame.seq, text: "", done: false };
  if (frame.ev === "done") return { ...state, seq: frame.seq, done: true };
  const text = typeof frame.text === "string" ? frame.text : "";
  if (!text) return { ...state, seq: frame.seq };
  return { ...state, seq: frame.seq, text: state.text + text };
}

/** SSE data 帧 → DeltaFrame；形状不对回 null（坏帧丢弃，不进状态机） */
export function parseDeltaFrame(data: Record<string, unknown>): DeltaFrame | null {
  const turnId = typeof data.turnId === "string" ? data.turnId : "";
  const seq = typeof data.seq === "number" ? data.seq : Number.NaN;
  const ev = data.ev;
  if (!turnId || !Number.isFinite(seq)) return null;
  if (ev !== "delta" && ev !== "reset" && ev !== "done") return null;
  return { turnId, seq, ev, ...(typeof data.text === "string" ? { text: data.text } : {}) };
}
