import { SharedProjectPanel } from "./SharedProjectPanel";
import { useOntologyEnabled } from "./use-ontology";
/**
 * 稿件编辑器 = **工作台分派点 + 文案工作台**（阶段制 spec §2）。
 *
 * 路由不变，按状态渲染工作台：文案（≤approved）/ 剪辑（editing）/ 封面（cover_pending）
 * / 发布（≥publish_ready）。顶栏推进按钮四张台子全局在场，阶段由它驱动。
 *
 * 文案工作台仍是整屏写作画布（飞书云文档式）：正文用 CodeMirror 实时渲染 markdown,
 * 工具面板收进右侧抽屉。成片向导与封面折叠区**已经搬走**——剪辑不该塞在文案页底下。
 *
 * body 始终是 markdown 纯文本、偏移量与 textarea 同坐标系,所以框选 AI 快改
 * (applySpan)、[IMAGE:] 解析、localStorage 暂存这些逻辑全部原样保留。
 * CodeMirror 挂不起来时降级回 textarea 并提示,不白屏。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// 中文写作常见的「**小标题。**正文」在 CommonMark 里闭合失败（标点+汉字紧邻），此插件修正
import remarkCjkFriendly from "remark-cjk-friendly";
import { type EditorView } from "@codemirror/view";
import { invoke, subscribeEvents, type InvokeResult } from "../transport";
import { toast } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import { copyForWorkbuddy } from "../chat/workbuddy";
import { SelectionBar } from "./SelectionBar";
import { MarkdownEditor } from "./MarkdownEditor";
import { EditorTools } from "./EditorTools";
import { setFocus, clearFocus, clearProposal, getFocus, getProposal, useRevisionFocus, useRevisionProposal } from "../revision";
import { applySpan } from "../apply-span";
import { ArticleImagesPanel } from "./ArticleImagesPanel";
import { EditingWorkspace } from "./EditingWorkspace";
import { CoverWorkspace } from "./CoverWorkspace";
import { PublishWorkspace } from "./PublishWorkspace";
import { StageAdvance } from "./StageAdvance";
import { ProductionBanner } from "./ProductionBanner";
import { loadCard } from "./board-api";
import {
  platformLabel,
  videoStatus,
  VARIANT_STATUS,
  VIDEO_PLATFORMS,
  workspaceForStatus,
  WORKSPACE_LABEL,
  type AllowedTransition,
  type Content,
} from "../lib";
import { fallbackTitle } from "./engine-lib";
import { HostBadges } from "./HostBadges";
import type { EditorPanel } from "../App";
import { type VersionLike } from "../version-diff";
import {
  contentDraft, editEditorState, editorDirty, emptyEditorState, readEditorBuffer,
  reconcileEditorState, restoreEditorState, type EditorBuffer, type EditorDraft, type EditorState,
} from "./editor-sync";
import "./editor-workspace.css";
import "./platform-mock.css";

const IMAGES_KEY = "ed-images-open";
/** 视频稿往前跳（标记发布中 / 已发布）只走看板卡片的「我发了」（看板规格 §16/§25） */
const VIDEO_SKIP_AHEAD = new Set(["publishing", "published"]);

/** 标题:textarea 才能换行(长标题很常见),高度跟着内容长；回车不换行,标题是单行语义 */
function TitleInput(props: { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return (
    <textarea
      ref={ref}
      className="ed-title serif"
      rows={1}
      value={props.value}
      placeholder="无标题"
      onChange={(e) => props.onChange(e.target.value.replace(/\n/g, ""))}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
    />
  );
}

export function Editor(props: { id: string; back: () => void; panel?: EditorPanel; context?: ReactNode }) {
  const [editor, setEditor] = useState(emptyEditorState);
  const currentEditor = useRef(editor);
  const { content: c, draft: { title, body }, remoteChanged } = editor;
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const activeRef = useRef(true);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const [note, setNote] = useState("");
  const [transitions, setTransitions] = useState<AllowedTransition[]>([]);
  const [versions, setVersions] = useState<VersionLike[]>([]);
  /** 视频线跑到哪了。只为文案页那条「此稿已有剪辑进度」横幅服务——不静默丢进度（spec §3①） */
  const [videoStarted, setVideoStarted] = useState(false);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const proposal = useRevisionProposal();
  const focus = useRevisionFocus();
  // 每次打开稿件先留出完整写作空间，发布工具在需要时再打开。
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [articleImagesOpen, setArticleImagesOpen] = useState(() => localStorage.getItem(IMAGES_KEY) === "1");
  const [fallback, setFallback] = useState<string | null>(null);
  const imagesRef = useRef<HTMLDetailsElement | null>(null);
  const proposalRef = useRef<HTMLDivElement | null>(null);
  const cmRef = useRef<EditorView | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const send = useChatSend();

  const bufKey = `v2-draft-${props.id}`;
  const backupKey = `${bufKey}-backup`;
  const [backup, setBackup] = useState(() => readEditorBuffer(localStorage.getItem(backupKey)));
  const dirty = editorDirty(editor);

  const updateEditor = useCallback((next: EditorState) => {
    // Update the ref synchronously: an async receipt must see keystrokes from this event.
    currentEditor.current = next;
    setEditor(next);
  }, []);
  const setTitle = (value: string) => updateEditor(editEditorState(currentEditor.current, { title: value }));
  const setBody = (value: string) => updateEditor(editEditorState(currentEditor.current, { body: value }));

  const persistDraft = useCallback(() => {
    const state = currentEditor.current;
    if (!state.content) return;
    try {
      if (editorDirty(state)) {
        const buffer: EditorBuffer = {
          ...state.draft, at: Date.now(), baseUpdatedAt: state.content.updatedAt, remoteChanged: state.remoteChanged,
        };
        localStorage.setItem(bufKey, JSON.stringify(buffer));
      } else {
        localStorage.removeItem(bufKey);
      }
    } catch { /* 本地空间不足时仍保留当前编辑内容 */ }
  }, [bufKey]);

  const load = useCallback(async (options: { quiet?: boolean; contentOnly?: boolean } = {}) => {
    if (savingRef.current || (options.quiet && loadingRef.current)) return;
    const request = ++requestRef.current;
    loadingRef.current = true;
    const current = () => activeRef.current && request === requestRef.current;
    const r = await invoke("content:get", { id: props.id });
    if (!current()) return;
    if (!r.ok) {
      loadingRef.current = false;
      if (!currentEditor.current.content) setLoadError(r.error ?? "加载稿件失败");
      if (!options.quiet) toast(r.error ?? "加载稿件失败");
      return;
    }
    setLoadError(null);
    const content = (r as unknown as { content: Content }).content;
    const previous = currentEditor.current;
    if (!previous.content) {
      const next = restoreEditorState(content, readEditorBuffer(localStorage.getItem(bufKey)));
      updateEditor(next);
      if (editorDirty(next)) toast("已恢复未保存的本地改动，点保存后才会存为新版本");
    } else {
      updateEditor(reconcileEditorState(previous, content));
    }
    // The fallback poll reads only this draft. Pull supporting data when it actually changes.
    const changed = !previous.content || JSON.stringify(previous.content) !== JSON.stringify(content);
    if (options.contentOnly && !changed) {
      loadingRef.current = false;
      return;
    }
    const [at, vr, vs] = await Promise.all([
      invoke("content:allowed_transitions", { id: props.id }),
      invoke("content:versions", { id: props.id }),
      VIDEO_PLATFORMS.has(content.platform) ? videoStatus(props.id) : Promise.resolve(null),
    ]);
    if (!current()) return;
    loadingRef.current = false;
    // transitions 带阶段门预判(后端算);界面不自己推演规则,灰显与原因都来自这一份
    setTransitions(((at as Record<string, unknown>).transitions ?? []) as AllowedTransition[]);
    setVersions((((vr as Record<string, unknown>).data ?? {}) as { versions?: VersionLike[] }).versions ?? []);
    setVideoStarted(Boolean(vs?.ok && vs.data?.state));
  }, [props.id, bufKey, updateEditor]);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      persistDraft();
      activeRef.current = false;
      ++requestRef.current;
      loadingRef.current = false;
    };
  }, [load, persistDraft]);

  /**
   * 焦点的生命周期绑在这个编辑器上：切稿件或离开编辑器时，属于本稿的焦点自动退。
   * 否则过期焦点会一路跟着用户（回看板、开别的稿），把后续每一轮对话都劫持进修改模式。
   */
  useEffect(() => {
    const id = props.id;
    return () => {
      // 有未收下的提案时不清:用户"回看板瞄一眼再回来收下"是正常路径,提案不能丢;
      // 劫持风险由 clear_revision_focus / 顶部 × / 修改模式窄条兜住。
      if (getFocus()?.contentId === id && getProposal()?.contentId !== id) clearFocus();
    };
  }, [props.id]);

  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load({ quiet: true, contentOnly: true });
    };
    const off = subscribeEvents((event) => {
      if (event.kind !== "reconnect" &&
        !((event.kind === "engine" || event.kind === "video:updated") && event.data.contentId === props.id)) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 180);
    });
    // Generic content updates intentionally do not all enter the engine event log.
    const poll = window.setInterval(refresh, 3000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pagehide", persistDraft);
    window.addEventListener("beforeunload", persistDraft);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pagehide", persistDraft);
      window.removeEventListener("beforeunload", persistDraft);
      off();
    };
  }, [props.id, load, persistDraft]);

  /**
   * 卡片深链（设计 §Phase 3）。阶段制之后封面/成片各自是整页工作台,深链只剩两件事:
   * 配图仍在文案页里滚过去;封面/成片则由**状态**决定人在不在那张台子上——
   * 不在就说一句实话,绝不静默把人扔在一个跟卡片说的不是一回事的页面上。
   */
  useEffect(() => {
    const panel = props.panel;
    if (!panel || !c) return;
    const here = workspaceForStatus(c.status);
    if (panel === "cover" || panel === "video") {
      const want = panel === "cover" ? "cover" : "editing";
      if (here !== want) toast(`这篇现在在「${WORKSPACE_LABEL[here]}」，可在顶栏选择「去${panel === "cover" ? "封面" : "剪辑"}」进入对应阶段`);
      return;
    }
    setArticleImagesOpen(true);
    localStorage.setItem(IMAGES_KEY, "1");
    // 滚两次:配图是异步拉的,第一次滚的时候页面还没长高,只滚到当时的底;
    // 等内容落位后补一次才真的把面板顶到视野里。直接跳位不做平滑动画。
    const timers = [80, 600].map((delay) =>
      setTimeout(() => imagesRef.current?.scrollIntoView({ block: "start" }), delay),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.panel, props.id, c !== null]);

  // 输入防抖落本地；刷新、离页和保存回执都同步冲刷，最后一秒也不丢字。
  useEffect(() => {
    const t = setTimeout(persistDraft, 400);
    return () => clearTimeout(t);
  }, [editor, persistDraft]);

  // Hook 必须在所有提前返回之前无条件调用（加载中 → 加载完 Hook 数不能变）
  const ontology = useOntologyEnabled(Boolean(c && VIDEO_PLATFORMS.has(c.platform)));

  if (!c) return loadError ? (
    <div className="pad">
      <p role="alert">{loadError}</p>
      <div className="row-actions"><button onClick={props.back}>← 返回看板</button><button onClick={() => void load()}>重试</button></div>
    </div>
  ) : <p className="muted pad">加载稿件…</p>;

  const saveMutation = async (channel: string, payload: Record<string, unknown>, submitted: Partial<EditorDraft>): Promise<InvokeResult | null> => {
    if (savingRef.current) return null;
    savingRef.current = true;
    setSaving(true);
    ++requestRef.current; // A read started before this write may no longer update the editor.
    loadingRef.current = false;
    persistDraft();
    const r = await invoke(channel, payload);
    if (!activeRef.current) return null;
    if (r.ok) {
      const receipt = r.content ? r : await invoke("content:get", { id: props.id });
      if (!activeRef.current) return null;
      if (receipt.ok && receipt.content) {
        updateEditor(reconcileEditorState(currentEditor.current, receipt.content as Content, submitted));
        persistDraft();
      } else {
        toast("稿件已保存，暂时未能读取最新内容；本地输入仍保留");
      }
    } else {
      toast(r.error ?? "保存失败");
    }
    savingRef.current = false;
    setSaving(false);
    if (r.ok) void load({ quiet: true });
    return r;
  };

  const save = async () => {
    if (!dirty) return toast("没有改动");
    const submitted = { ...currentEditor.current.draft };
    const submittedNote = note;
    const payload: Record<string, unknown> = { id: props.id, body: submitted.body };
    const newTitle = submitted.title.trim();
    if (newTitle && newTitle !== (c.title || "")) payload.title = newTitle;
    if (note.trim()) payload.diff_note = note.trim().slice(0, 200);
    const r = await saveMutation("content:update", payload, {
      body: submitted.body,
      ...(newTitle ? { title: submitted.title } : {}),
    });
    if (!r?.ok) return;
    setNote((current) => current === submittedNote ? "" : current);
    const learned = (r as { styleLearned?: { summary?: string } }).styleLearned;
    toast("已存为新版本" + (learned?.summary ? " · " + learned.summary : ""));
    if (r.warning) toast(String(r.warning));
  };

  const loadLatest = () => {
    const state = currentEditor.current;
    if (!state.content || savingRef.current) return;
    const buffer: EditorBuffer = { ...state.draft, at: Date.now(), baseUpdatedAt: state.content.updatedAt };
    try {
      localStorage.setItem(backupKey, JSON.stringify(buffer));
    } catch {
      toast("本地备份未能写入，请先复制保存自己的改动，再载入最新内容");
      return;
    }
    setBackup(buffer);
    updateEditor({ content: state.content, draft: contentDraft(state.content), remoteChanged: false });
    persistDraft();
    setSel(null);
    toast("已载入最新内容；原来的本地改动可以恢复");
  };

  const restoreBackup = () => {
    if (!backup || savingRef.current) return;
    // Swap rather than discard: edits made after loading the latest version remain recoverable too.
    const state = currentEditor.current;
    const replacement: EditorBuffer = { ...state.draft, at: Date.now(), baseUpdatedAt: state.content!.updatedAt };
    try {
      localStorage.setItem(backupKey, JSON.stringify(replacement));
    } catch {
      toast("本地备份未能写入，当前内容已保留");
      return;
    }
    updateEditor(editEditorState({ ...state, remoteChanged: true }, { title: backup.title, body: backup.body }));
    setBackup(replacement);
    persistDraft();
    setSel(null);
    toast("已恢复本地备份，保存后才会存为新版本");
  };

  /**
   * 中断重写:在**这一篇**上重跑生成,不派聊天活。老路发一句 brief 给总编辑,
   * 总编辑再调 generate_script 新建一篇——中断稿就此成僵尸卡,每点一次多一张重复卡。
   */
  const retryGenerate = async () => {
    const r = await invoke("generate:retry", { content_id: props.id });
    if (!r.ok) return toast(r.error ?? "重写没起来");
    toast("重写已开始,1-3 分钟");
    void load();
  };

  /** 降级态的 textarea 选区读取(CodeMirror 正常时由 MarkdownEditor 回调) */
  const onTextareaSelect = () => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart, selectionEnd } = ta;
    setSel(selectionEnd > selectionStart ? { start: selectionStart, end: selectionEnd } : null);
  };

  const activeProposal = proposal && proposal.contentId === props.id ? proposal : null;
  const activeFocus = focus && focus.contentId === props.id ? focus : null;
  const bodyReadOnly = activeProposal?.scope === "selection";

  const startSelectionFocus = () => {
    if (!sel) return;
    const text = body.slice(sel.start, sel.end);
    setFocus({ contentId: props.id, scope: "selection", selection: { start: sel.start, end: sel.end, text } });
    setSel(null);
    toast("已锁定这段——总编辑已滑出,说怎么改,改完在这儿收下");
  };

  const startDraftFocus = () => {
    setFocus({ contentId: props.id, scope: "draft" });
    toast("已锁定整篇——总编辑已滑出,说怎么改,改完在这儿收下");
  };

  const adoptProposal = async () => {
    if (!activeProposal) return;
    let newBody = body;
    let newTitle: string | undefined;
    let before: string;
    if (activeProposal.scope === "selection" && activeProposal.selection) {
      before = activeProposal.selection.text;
      newBody = applySpan(body, activeProposal.selection.start, activeProposal.selection.end, activeProposal.span ?? "");
    } else {
      before = c.body;
      newBody = activeProposal.body ?? body;
      newTitle = activeProposal.title;
    }
    const submitted = { ...currentEditor.current.draft };
    const r = await saveMutation("draft:adopt_revision", {
      content_id: props.id,
      scope: activeProposal.scope,
      ...(activeProposal.scope === "selection" && activeProposal.selection ? { selection: activeProposal.selection.text } : {}),
      body: newBody,
      ...(newTitle ? { title: newTitle } : {}),
      before,
      ...(activeProposal.feedback ? { feedback: activeProposal.feedback } : {}),
    }, {
      body: submitted.body,
      // A body-only proposal does not consent to discarding an unsaved local title.
      ...(newTitle || submitted.title.trim() === (c.title || "") ? { title: submitted.title } : {}),
    });
    if (!r?.ok) return;
    clearFocus();
    const receipt = r as { styleLearned?: { summary?: string }; warning?: string };
    toast("已收下并存为新版本" + (receipt.styleLearned?.summary ? " · " + receipt.styleLearned.summary : ""));
    if (receipt.warning) toast(receipt.warning);
  };

  const isVideo = VIDEO_PLATFORMS.has(c.platform);
  const imageSlots = [...body.matchAll(/\[IMAGE:\s*(.+?)\]/g)].length;

  const workspace = workspaceForStatus(c.status);
  // 标题下那一行（1b 验收）：写稿 / 剪辑 / 封面 / 发布各工作台都挂一次，视频稿才有
  const productionBanner = isVideo ? <ProductionBanner contentId={props.id} refreshKey={c.status} /> : null;
  const stageBar = (
    <div className="ed-topbar ed-workspace-header">
      <div className="ed-header-context">
        <button className="ed-quiet-button ed-back-button" onClick={props.back}>← 管线看板</button>
        <div className="ed-current-draft">
          <strong>{platformLabel(c.platform)}</strong>
          <span className="ed-status-label">{VARIANT_STATUS[c.status] ?? c.status}</span>
          {workspace !== "draft" && <span className="muted">{WORKSPACE_LABEL[workspace]}</span>}
        </div>
        <button className="ed-quiet-button" title="复制一句话，粘到 WorkBuddy 里让它通过 AutoCrew 打开这篇" onClick={() => void copyForWorkbuddy(c.title, props.id)}>复制给 WorkBuddy</button>
        {workspace === "draft" && <button
          className={"ed-quiet-button ed-tools-trigger" + (drawerOpen ? " is-open" : "")}
          aria-expanded={drawerOpen}
          aria-controls="editor-publishing-tools"
          onClick={() => setDrawerOpen(true)}
        >发布与版本</button>}
      </div>
      <div className="ed-header-actions">
        {workspace === "draft" && <div className="ed-mode-switch" aria-label="正文显示模式">
          <button aria-pressed={mode === "edit"} className={mode === "edit" ? "is-active" : ""} onClick={() => setMode("edit")}>编辑</button>
          <button aria-pressed={mode === "preview"} className={mode === "preview" ? "is-active" : ""} onClick={() => setMode("preview")}>预览</button>
        </div>}
        <div className="ed-primary-actions">
          {workspace === "draft" && <button
            className="ed-ai-action"
            aria-pressed={!!activeFocus}
            onClick={() => activeProposal ? proposalRef.current?.scrollIntoView({ block: "center" }) : startDraftFocus()}
          >{activeProposal ? "查看 AI 提案" : "AI 改稿"}</button>}
          <StageAdvance
            contentId={props.id}
            currentStatus={c.status}
            transitions={VIDEO_PLATFORMS.has(c.platform) ? transitions.filter((t) => !VIDEO_SKIP_AHEAD.has(t.status)) : transitions}
            dirty={workspace === "draft" && (dirty || saving)}
            loadedBody={c.body ?? ""}
            reload={load}
            isVideo={isVideo}
            landedStage={async () => { const r = await loadCard(props.id); return r.ok ? r.data.stage ?? r.data.column : null; }}
          />
          {workspace === "draft" && <button
            className={"ed-save-action" + (dirty ? " primary" : " is-saved")}
            disabled={saving || !dirty}
            onClick={() => void save()}
            title={remoteChanged ? "保存你保留的本地版本" : "保存当前标题和正文"}
          >{saving ? "保存中…" : dirty ? "保存修改" : "✓ 已保存"}</button>}
        </div>
      </div>
    </div>
  );

  // 工作台随状态（spec §2）：文案之外的三张台子是整页，不带写作画布与抽屉
  // 视频剪辑看板（剪辑中 / 视频封面）：顶栏只剩一行「← 看板 · 标题 · 平台」；
  // 写作阶段的主题行、推进下拉都不放——剪辑阶段只能经 Codex 登记离开
  if (workspace === "editing" || (workspace === "cover" && isVideo)) {
    return (
      <div className="editor editor-workspace">
        <div className="ed-topbar ed-workspace-header pb-header">
          <button className="ed-quiet-button ed-back-button" onClick={props.back}>← 看板</button>
          <strong className="pb-header-title">{c.title || "无标题"}</strong>
          <span className="muted">{platformLabel(c.platform)}</span>
        </div>
        {productionBanner}
        <div className="ed-main-row"><EditingWorkspace content={c} reload={load} /></div>
      </div>
    );
  }

  if (workspace !== "draft") {
    return (
      <div className="editor editor-workspace">
        {stageBar}
        {productionBanner}
        {props.context}
        <div className="ed-main-row">
          {/* 视频稿的封面在剪辑看板里挑 Codex 交的版本（见上），这里只剩公众号稿的封面台 */}
          {workspace === "cover" && <CoverWorkspace content={c} reload={load} />}
          {workspace === "publish" && (
            <PublishWorkspace content={c} versions={versions} reload={load} send={send} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={"editor editor-workspace" + (drawerOpen ? " ed-with-drawer" : "")}>
      {stageBar}
      {productionBanner}
      {props.context}
      <SharedProjectPanel status={c.status} isVideo={isVideo} ontology={ontology} />

      <div className="ed-main-row">
      <div className="ed-stage">
        <div className="ed-canvas">
          {remoteChanged && (
            <div className="pending-edit" role="status">
              <p>这篇稿件已有新内容。你尚未保存的本地改动已保留；载入最新内容会先备份这些改动。</p>
              <button onClick={loadLatest} disabled={saving}>备份本地改动并载入最新</button>
            </div>
          )}
          {backup && (
            <div className="ed-focus-bar muted">
              <span>有一份切换版本前的本地备份</span>
              <button onClick={restoreBackup} disabled={saving}>恢复本地备份</button>
            </div>
          )}
          {/* 旧稿在途 / 从剪辑回文案改稿：剪辑进度一个字都没丢，说清楚，不让人以为白剪了（spec §3①③） */}
          {isVideo && (videoStarted || c.videoReadyAt) && (
            <div className="vid-warn">
              这篇已经有剪辑进度（决策与成片都留着，回文案改稿不会丢）——
              用顶栏的下一阶段动作进入剪辑，接着制作。
            </div>
          )}

          {/* 兜底留痕（P2 §4.3）：这一稿由备用端点顶完，hover 显示主线失败原因 */}
          {c.usedFallback && (
            <div className="ed-fallback" title={fallbackTitle(c.usedFallback)}>备用顶上 · 主线 {c.usedFallback.from} 没跑通，由 {c.usedFallback.to} 顶完</div>
          )}

          {/* 多宿主留痕（P3 §6.1）：谁写的 / 谁在动 / 领了包没交稿。hover 是完整说明 */}
          <HostBadges content={c} />
          {c.lastError && (
            <div className="ed-error">
              ⚠️ 上次生成中断：{String(c.lastError).slice(0, 120)}{" "}
              <button onClick={() => void retryGenerate()}>重新生成</button>
            </div>
          )}

          {/* 缺证据（P1 §4.4）：正文写出来了但数字没出处,不转草稿。走的是同一条重写通道 */}
          {c.status === "needs_evidence" && (
            <div className="ed-error">
              ⚠️ 这一稿有没出处的数字，没转成草稿：
              {(c.unverifiedNumbers ?? []).slice(0, 6).join("、") || String(c.blockedReason ?? "").slice(0, 120)}
              <div className="muted">补一段材料（或把这些数字删掉）之后重新生成；也可以直接在下面改稿。</div>
              <button onClick={() => void retryGenerate()}>重新生成</button>
            </div>
          )}

          {fallback && (
            <div className="ed-error">
              实时渲染编辑器没能启动（{fallback.slice(0, 80)}）——已降级为纯文本编辑，正文内容不受影响。
            </div>
          )}

          <TitleInput value={title} onChange={setTitle} />

          {activeProposal && (
            <div className="pending-edit" ref={proposalRef}>
              <div className="mono muted">
                总编辑的修改提案{activeProposal.scope === "selection" ? "（这一段）" : "（整篇）"}——收下才落库,旧版进版本记录;不满意就在总编辑里继续说
              </div>
              {activeProposal.scope === "selection" ? (
                <>
                  <pre className="pe-before">{activeProposal.selection?.text}</pre>
                  <pre className="pe-after">{activeProposal.span}</pre>
                </>
              ) : (
                <pre className="pe-after">{activeProposal.body}</pre>
              )}
              <div className="row-actions">
                <button className="primary" disabled={saving} onClick={() => void adoptProposal()}>收下这版</button>
                <button onClick={() => clearProposal()}>放弃这版</button>
                <button onClick={() => clearFocus()}>退出修改</button>
              </div>
            </div>
          )}

          {/* 提案还没出来时的修改模式窄条:编辑器里也要有一条明确的退路,不然用户只能干等 */}
          {activeFocus && !activeProposal && (
            <div className="pending-edit ed-focus-bar">
              <span className="mono muted">
                修改模式（{activeFocus.scope === "selection" ? "这一段" : "整篇"}）——在右侧总编辑说怎么改,改完这里出提案
              </span>
              <button onClick={() => clearFocus()}>退出修改</button>
            </div>
          )}

          {bodyReadOnly && mode === "edit" && (
            <div className="ed-readonly mono">
              正文暂时只读——先把上面的修改提案「收下」或「放弃」,再继续编辑
            </div>
          )}

          {mode === "preview" ? (
            <div className="md-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{body}</ReactMarkdown>
            </div>
          ) : (
            <div className="ed-body-wrap">
              {fallback ? (
                <textarea
                  ref={taRef}
                  className="ed-body"
                  value={body}
                  readOnly={bodyReadOnly}
                  onChange={(e) => setBody(e.target.value)}
                  onSelect={onTextareaSelect}
                  onKeyUp={onTextareaSelect}
                  onMouseUp={onTextareaSelect}
                />
              ) : (
                <MarkdownEditor
                  value={body}
                  onChange={setBody}
                  onSelectionChange={setSel}
                  readOnly={bodyReadOnly}
                  placeholder="从这里开始写…（支持 Markdown：# 标题、**加粗**、- 列表）"
                  viewRef={cmRef}
                  onFallback={(reason) => {
                    setFallback(reason);
                    toast("实时渲染编辑器启动失败,已降级为纯文本编辑");
                  }}
                />
              )}
              {sel && !activeProposal && (
                <SelectionBar view={fallback ? null : cmRef.current} ta={taRef.current} sel={sel} onFocus={startSelectionFocus} />
              )}
            </div>
          )}
        </div>

        <div className="ed-writing-footer">
          <details className="ed-change-note">
            <summary>{note.trim() ? "修改说明已填写" : "添加修改说明"}<span>可选</span></summary>
            <label>
              <span className="muted">简单说明这次改了什么，保存时一起记入版本。</span>
              <textarea rows={2} maxLength={200} placeholder="例如：缩短开头，补充实际使用体验" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </details>
          <span className="muted ed-writing-hint">选中文字可让 AI 只改这一段</span>
        </div>

        {/* 配图要宽度,不进窄抽屉——沉到正文下方,默认折叠,不打扰写作。
            成片向导与封面折叠区已搬去各自的工作台（阶段制 spec §2）。 */}
        <div className="ed-below">
          <details
            className="ed-tools"
            ref={imagesRef}
            open={articleImagesOpen}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setArticleImagesOpen(open);
              localStorage.setItem(IMAGES_KEY, open ? "1" : "0");
            }}
          >
            <summary>正文配图 · {imageSlots} 个位置</summary>
            <ArticleImagesPanel contentId={props.id} dirty={dirty} body={body} platform={c.platform} topicId={c.topicId} />
          </details>
        </div>
      </div>

      {drawerOpen && (
        <div className="ed-drawer-layer">
          <aside className="ed-drawer" id="editor-publishing-tools" aria-label="发布与版本">
            <div className="ed-drawer-head">
              <div><strong>发布与版本</strong><p>准备发布材料，查看修改记录</p></div>
              <button className="ed-quiet-button ed-drawer-close" aria-label="关闭发布与版本" onClick={() => setDrawerOpen(false)}>×</button>
            </div>
            <div className="ed-drawer-body">
              <EditorTools
                contentId={props.id}
                content={c}
                versions={versions}
                dirty={dirty}
                reload={load}
                send={send}
              />
            </div>
          </aside>
        </div>
      )}
      </div>

    </div>
  );
}
