import type { Content } from "../lib";

export interface EditorDraft {
  title: string;
  body: string;
}

export interface EditorBuffer extends EditorDraft {
  at: number;
  baseUpdatedAt?: string;
  remoteChanged?: boolean;
}

export interface EditorState {
  content: Content | null;
  draft: EditorDraft;
  remoteChanged: boolean;
}

export const emptyEditorState: EditorState = {
  content: null,
  draft: { title: "", body: "" },
  remoteChanged: false,
};

export function contentDraft(content: Content): EditorDraft {
  return { title: content.title ?? "", body: content.body ?? "" };
}

export function sameDraft(a: EditorDraft, b: EditorDraft): boolean {
  return a.title.trim() === b.title.trim() && a.body === b.body;
}

export function editorDirty(state: EditorState): boolean {
  return !!state.content && !sameDraft(state.draft, contentDraft(state.content));
}

export function readEditorBuffer(raw: string | null): EditorBuffer | null {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<EditorBuffer> | null;
    if (!value || typeof value.title !== "string" || typeof value.body !== "string" || typeof value.at !== "number") return null;
    return value as EditorBuffer;
  } catch {
    return null;
  }
}

/** Restore once on entry. Later refreshes reconcile against live edits, never storage. */
export function restoreEditorState(content: Content, buffer: EditorBuffer | null): EditorState {
  const saved = contentDraft(content);
  if (!buffer || sameDraft(buffer, saved)) return { content, draft: saved, remoteChanged: false };
  // Old buffers did not identify their base; keep their existing newer-than-store rule.
  if (!buffer.baseUpdatedAt && buffer.at <= Date.parse(content.updatedAt)) return { content, draft: saved, remoteChanged: false };
  return {
    content,
    draft: { title: buffer.title, body: buffer.body },
    remoteChanged: !!buffer.remoteChanged || !!buffer.baseUpdatedAt && buffer.baseUpdatedAt !== content.updatedAt,
  };
}

/** Saved receipts acknowledge the submitted snapshot, not typing that happened afterward. */
export function reconcileEditorState(state: EditorState, content: Content, submitted?: Partial<EditorDraft>): EditorState {
  const saved = contentDraft(content);
  if (submitted) {
    return {
      content,
      draft: {
        title: state.draft.title === submitted.title ? saved.title : state.draft.title,
        body: state.draft.body === submitted.body ? saved.body : state.draft.body,
      },
      remoteChanged: false,
    };
  }
  if (!editorDirty(state) || sameDraft(state.draft, saved)) return { content, draft: saved, remoteChanged: false };
  return {
    content,
    draft: state.draft,
    remoteChanged: state.remoteChanged || !sameDraft(contentDraft(state.content!), saved),
  };
}

export function editEditorState(state: EditorState, patch: Partial<EditorDraft>): EditorState {
  const next = { ...state, draft: { ...state.draft, ...patch } };
  return { ...next, remoteChanged: state.remoteChanged && editorDirty(next) };
}
