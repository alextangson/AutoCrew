/**
 * 共用的防重复动作执行器（吸收 15）：点下去变灰直到返回；失败把原因常驻在卡里 + 重试（不只弹 toast）。
 * 纯逻辑在 `createGuardedRunner`（可测）；`useGuardedAction` 只是把它接到 React 状态上。
 */
import { useCallback, useRef, useState } from "react";

export type ActionResult = { ok: true } | { ok: false; error: string };
export interface GuardedState { busy: boolean; error: string | null; label: string | null }

export function createGuardedRunner(onChange: (s: GuardedState) => void) {
  let busy = false;
  let last: { label: string; task: () => Promise<ActionResult> } | null = null;
  const run = async (label: string, task: () => Promise<ActionResult>): Promise<ActionResult | null> => {
    if (busy) return null; // 在飞的不再发第二次
    busy = true;
    last = { label, task };
    onChange({ busy: true, error: null, label });
    let r: ActionResult;
    try { r = await task(); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    busy = false;
    onChange({ busy: false, error: r.ok ? null : r.error, label });
    return r;
  };
  return { run, retry: () => (last ? run(last.label, last.task) : Promise.resolve(null)) };
}

export function useGuardedAction() {
  const [state, setState] = useState<GuardedState>({ busy: false, error: null, label: null });
  const runner = useRef(createGuardedRunner(setState));
  const clear = useCallback(() => setState((s) => ({ ...s, error: null })), []);
  return { ...state, run: runner.current.run, retry: runner.current.retry, clear };
}
