/**
 * 对话式修改的客户端共享 store（module-observable，照 ui.tsx 的 pushToast 模式）。
 * 编辑器设焦点/收下提案；ChatDock 读焦点塞进 turn、把提案卡写进来。两边不直接耦合。
 */
import { useEffect, useState } from "react";

export interface RevisionFocus {
  contentId: string;
  scope: "selection" | "draft";
  /** scope==="selection" 时存在：选区索引 + 原文（收下时按此替换/对比） */
  selection?: { start: number; end: number; text: string };
}

export interface RevisionProposal {
  contentId: string;
  scope: "selection" | "draft";
  /** draft 范围回 title+body；selection 范围回 span */
  title?: string;
  body?: string;
  span?: string;
  selection?: { start: number; end: number; text: string };
  /** 产出这版的用户指令；收下时作为 feedback 喂给学习闸门 */
  feedback?: string;
}

interface State {
  focus: RevisionFocus | null;
  proposal: RevisionProposal | null;
}

let state: State = { focus: null, proposal: null };
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

export function getFocus(): RevisionFocus | null {
  return state.focus;
}
export function getProposal(): RevisionProposal | null {
  return state.proposal;
}

/** 设焦点：换焦点即作废旧提案（避免上一段的绿字串到新焦点）。 */
export function setFocus(focus: RevisionFocus): void {
  state = { focus, proposal: null };
  emit();
}
export function clearFocus(): void {
  state = { focus: null, proposal: null };
  emit();
}
export function setProposal(proposal: RevisionProposal): void {
  state = { ...state, proposal };
  emit();
}
export function clearProposal(): void {
  state = { ...state, proposal: null };
  emit();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useRevisionFocus(): RevisionFocus | null {
  const [f, setF] = useState(state.focus);
  useEffect(() => {
    setF(state.focus);
    return subscribe(() => setF(state.focus));
  }, []);
  return f;
}
export function useRevisionProposal(): RevisionProposal | null {
  const [p, setP] = useState(state.proposal);
  useEffect(() => {
    setP(state.proposal);
    return subscribe(() => setP(state.proposal));
  }, []);
  return p;
}
