/**
 * 配音排时（全媒体 spec §3.3「Timing」）：每段一条配音，按顺序摆——不早于它的时间槽起点，
 * 和上一条之间至少留 0.15 秒，永远不重叠。先吃掉原有的停顿；吃不完的超时由尾段画面放慢来吸收，
 * 放慢倍数不能超过 1.15（再慢嘴型和动作就假了），超了就拒，让宿主把英文写短。
 * 口型对齐的脸上不放定格帧，所以只能放慢，不能补帧。
 */

export const LINE_GAP_S = 0.15;
export const MAX_TAIL_SLOWDOWN = 1.15;

export interface TimingInput { index: number; slotStartS: number; slotEndS: number; durationS: number }

export interface PlacedLine extends TimingInput { startS: number; endS: number }

export interface TimingPlan {
  lines: PlacedLine[];
  /** 源成片里英文要覆盖到的结尾（最后一段时间槽的终点） */
  sourceEndS: number;
  /** 最后一条配音的结尾 */
  dubEndS: number;
  /** 超出源结尾多少秒（≤0 = 没超） */
  overrunS: number;
  /** 从哪儿开始放慢画面（第一段配音拖过自己时间槽的那段的槽起点）；不用放慢 = null */
  slowFromS: number | null;
  /** 尾段画面要放慢的倍数（1 = 不放慢） */
  tailSlowdown: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function planTiming(input: TimingInput[]): TimingPlan {
  if (!input.length) throw new Error("没有配音可排");
  const lines: PlacedLine[] = [];
  let prevEnd = -Infinity;
  for (const x of [...input].sort((a, b) => a.slotStartS - b.slotStartS)) {
    const startS = r3(Math.max(x.slotStartS, prevEnd + LINE_GAP_S));
    const endS = r3(startS + x.durationS);
    lines.push({ ...x, startS, endS });
    prevEnd = endS;
  }
  const sourceEndS = Math.max(...input.map((x) => x.slotEndS));
  const dubEndS = lines.at(-1)!.endS;
  const overrunS = r3(dubEndS - sourceEndS);
  const drift = lines.find((l) => l.endS > l.slotEndS);
  if (overrunS <= 0 || !drift) return { lines, sourceEndS, dubEndS, overrunS, slowFromS: null, tailSlowdown: 1 };
  const slowFromS = drift.slotStartS;
  const tailSlowdown = Math.round(((dubEndS - slowFromS) / (sourceEndS - slowFromS)) * 1000) / 1000;
  return { lines, sourceEndS, dubEndS, overrunS, slowFromS, tailSlowdown };
}

/** 放慢超限 → 拒绝原因（指出最该缩的几段）；没超 = null */
export function slowdownRefusal(plan: TimingPlan): string | null {
  if (plan.tailSlowdown <= MAX_TAIL_SLOWDOWN) return null;
  const worst = [...plan.lines].sort((a, b) => (b.durationS - (b.slotEndS - b.slotStartS)) - (a.durationS - (a.slotEndS - a.slotStartS))).slice(0, 3)
    .map((l) => `第 ${l.index} 段（配音 ${l.durationS.toFixed(2)}s / 槽 ${(l.slotEndS - l.slotStartS).toFixed(2)}s）`);
  return `英文配音比原片长 ${plan.overrunS.toFixed(2)} 秒，尾段画面要放慢 ${plan.tailSlowdown}× 才装得下，超过上限 ${MAX_TAIL_SLOWDOWN}×：` +
    `把英文脚本写短（最超的是 ${worst.join("、")}），改完重新给创始人批，再配音`;
}
