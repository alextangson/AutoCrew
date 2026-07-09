/**
 * 任务动态聚合(C 期,平移 vanilla store.js 的 run 逻辑):
 * engine 事件 kind=work/run_done/run_failed 按 runId 开卡步进;
 * chat 进度 phase start/end 也归入同 runId。只留最近 8 个 run(动态非档案)。
 */
import { useSyncExternalStore } from "react";
import { subscribeEvents } from "./transport";

export interface RunStep {
  label: string;
  role: string | null;
  done: boolean;
}

export interface Run {
  steps: RunStep[];
  status: "running" | "done" | "failed";
  doneLabel: string;
  startedAt: number;
}

interface RunsState {
  runs: Record<string, Run>;
  runOrder: string[];
}

let state: RunsState = { runs: {}, runOrder: [] };
const subs = new Set<() => void>();
let wired = false;

function notify() {
  state = { runs: { ...state.runs }, runOrder: [...state.runOrder] }; // 新引用触发 useSyncExternalStore
  for (const fn of subs) fn();
}

function ensureRun(runId: string): Run {
  if (!state.runs[runId]) {
    state.runs[runId] = { steps: [], status: "running", doneLabel: "", startedAt: Date.now() };
    state.runOrder.push(runId);
    while (state.runOrder.length > 8) {
      const drop = state.runOrder.shift();
      if (drop) delete state.runs[drop];
    }
  }
  return state.runs[runId];
}

function wire() {
  if (wired) return;
  wired = true;
  subscribeEvents((e) => {
    const d = e.data as { kind?: string; runId?: string; label?: string; role?: string; phase?: string };
    if (e.kind === "engine") {
      if (!d.label || !d.runId) return;
      if (d.kind === "work") {
        ensureRun(d.runId).steps.push({ label: d.label, role: d.role ?? null, done: false });
        notify();
      } else if (d.kind === "run_done" || d.kind === "run_failed") {
        const run = ensureRun(d.runId);
        run.status = d.kind === "run_done" ? "done" : "failed";
        run.doneLabel = d.label;
        run.steps.forEach((s) => (s.done = true));
        notify();
      }
    } else if (e.kind === "chat" && d.runId && d.label) {
      const run = ensureRun(d.runId);
      if (d.phase === "start") {
        run.steps.push({ label: d.label, role: d.role ?? null, done: false });
      } else if (d.phase === "end") {
        for (let i = run.steps.length - 1; i >= 0; i--) {
          if (run.steps[i].label === d.label && !run.steps[i].done) {
            run.steps[i].done = true;
            break;
          }
        }
      }
      notify();
    }
  });
}

export function useRuns(): RunsState {
  wire();
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
  );
}
