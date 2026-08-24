/**
 * 编辑器：整屏写作画布（飞书云文档式）——正文用 CodeMirror 实时渲染 markdown,
 * 工具面板收进右侧抽屉,封面/配图这类要宽度的面板沉到正文下方且默认折叠。
 *
 * body 始终是 markdown 纯文本、偏移量与 textarea 同坐标系,所以框选 AI 快改
 * (applySpan)、[IMAGE:] 解析、localStorage 暂存这些逻辑全部原样保留。
 * CodeMirror 挂不起来时降级回 textarea 并提示,不白屏。
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// 中文写作常见的「**小标题。**正文」在 CommonMark 里闭合失败（标点+汉字紧邻），此插件修正
import remarkCjkFriendly from "remark-cjk-friendly";
import { type EditorView } from "@codemirror/view";
import { invoke, subscribeEvents } from "../transport";
import { toast } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import { SelectionBar } from "./SelectionBar";
import { MarkdownEditor } from "./MarkdownEditor";
import { EditorTools } from "./EditorTools";
import { setFocus, clearFocus, clearProposal, getFocus, getProposal, useRevisionFocus, useRevisionProposal } from "../revision";
import { applySpan } from "../apply-span";
import { CoverPanel } from "./CoverPanel";
import { ArticleImagesPanel } from "./ArticleImagesPanel";
import { VideoPanel } from "./VideoPanel";
import { platformLabel, VARIANT_STATUS, VIDEO_PLATFORMS, type Content } from "../lib";
import type { EditorPanel } from "../App";
import { type VersionLike } from "../version-diff";

const DRAWER_KEY = "ed-drawer-open";
const IMAGES_KEY = "ed-images-open";

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

export function Editor(props: { id: string; back: () => void; panel?: EditorPanel }) {
  const [c, setC] = useState<Content | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [nextStatus, setNextStatus] = useState("");
  const [versions, setVersions] = useState<VersionLike[]>([]);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const proposal = useRevisionProposal();
  const focus = useRevisionFocus();
  // 抽屉/配图面板的开合是用户偏好,记住它——每次进来都要重开是最烦人的那种细节
  const [drawerOpen, setDrawerOpen] = useState(() => localStorage.getItem(DRAWER_KEY) === "1");
  const [articleImagesOpen, setArticleImagesOpen] = useState(() => localStorage.getItem(IMAGES_KEY) === "1");
  // 封面面板默认折叠(不记忆);对话卡片深链过来时才自动展开
  const [coverOpen, setCoverOpen] = useState(false);
  const [videoDone, setVideoDone] = useState(false);
  const [coverApproved, setCoverApproved] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const panelRefs = {
    cover: useRef<HTMLDetailsElement | null>(null),
    images: useRef<HTMLDetailsElement | null>(null),
    video: useRef<HTMLDivElement | null>(null),
  };
  const cmRef = useRef<EditorView | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const send = useChatSend();

  const bufKey = `v2-draft-${props.id}`;
  const dirty = c !== null && (body !== c.body || title.trim() !== (c.title || ""));

  const load = async () => {
    const r = await invoke("content:get", { id: props.id });
    if (!r.ok) return toast(r.error ?? "加载稿件失败");
    const content = (r as unknown as { content: Content }).content;
    setC(content);
    // 本地暂存恢复:比 store 新才提示(防呆——刷新/崩溃不丢打了一半的字)
    let restored = false;
    try {
      const buf = JSON.parse(localStorage.getItem(bufKey) ?? "null") as { title: string; body: string; at: number } | null;
      if (buf && buf.at > new Date(content.updatedAt).getTime() && (buf.body !== content.body || buf.title !== content.title)) {
        setTitle(buf.title);
        setBody(buf.body);
        restored = true;
        toast("已恢复未保存的本地改动(未落库)——点保存才算数");
      }
    } catch { /* 坏暂存忽略 */ }
    if (!restored) {
      setTitle(content.title ?? "");
      setBody(content.body ?? "");
    }
    const [at, vr] = await Promise.all([
      invoke("content:allowed_transitions", { id: props.id }),
      invoke("content:versions", { id: props.id }),
    ]);
    const transitions = ((at as Record<string, unknown>).allowedTransitions ?? []) as string[];
    setAllowed(transitions);
    setNextStatus((current) => transitions.includes(current) ? current : (transitions[0] ?? ""));
    setVersions((((vr as Record<string, unknown>).data ?? {}) as { versions?: VersionLike[] }).versions ?? []);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id]);

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
    const off = subscribeEvents((event) => {
      if (event.kind !== "engine" || event.data.contentId !== props.id) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 180);
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id]);

  /**
   * 卡片深链（设计 §Phase 3）:对话里点「去封面/配图/成片面板」→ 展开那块并滚到它。
   * 稿件读完(c 有值)才滚——面板挂上去之前滚是空滚。
   */
  useEffect(() => {
    const panel = props.panel;
    if (!panel || !c) return;
    if (panel === "cover") setCoverOpen(true);
    if (panel === "images") {
      setArticleImagesOpen(true);
      localStorage.setItem(IMAGES_KEY, "1");
    }
    // 滚两次:面板内容(封面候选/配图/成片)是异步拉的,第一次滚的时候页面还没长高,
    // 只滚到当时的底;等内容落位后补一次才真的把面板顶到视野里。
    // 直接跳位不做平滑动画:深链是「带我去那儿」,动画只是让位置在某些环境里丢掉
    const timers = [80, 600].map((delay) =>
      setTimeout(() => panelRefs[panel].current?.scrollIntoView({ block: "start" }), delay),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.panel, props.id, c !== null]);

  // 成片通过后自动把下一步展开；用户不必再猜「剪完之后封面在哪里」。
  useEffect(() => {
    if (!videoDone || coverApproved) return;
    setCoverOpen(true);
    const timer = window.setTimeout(() => panelRefs.cover.current?.scrollIntoView({ block: "start" }), 120);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoDone, coverApproved]);

  // 本地暂存(1s 防抖)
  useEffect(() => {
    if (!c || !dirty) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(bufKey, JSON.stringify({ title, body, at: Date.now() }));
      } catch { /* 存不下就算了 */ }
    }, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body]);

  const toggleDrawer = () => {
    setDrawerOpen((open) => {
      localStorage.setItem(DRAWER_KEY, open ? "0" : "1");
      return !open;
    });
  };

  if (!c) return <p className="muted pad">加载稿件…</p>;

  const save = async () => {
    if (!dirty) return toast("没有改动");
    const payload: Record<string, unknown> = { id: props.id, body };
    const newTitle = title.trim();
    if (newTitle && newTitle !== (c.title || "")) payload.title = newTitle;
    if (note.trim()) payload.diff_note = note.trim().slice(0, 200);
    const r = await invoke("content:update", payload);
    if (!r.ok) return toast(r.error ?? "保存失败");
    localStorage.removeItem(bufKey);
    setNote("");
    const learned = (r as { styleLearned?: { summary?: string } }).styleLearned;
    toast("已存为新版本" + (learned?.summary ? " · " + learned.summary : ""));
    void load();
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
    const r = await invoke("draft:adopt_revision", {
      content_id: props.id,
      body: newBody,
      ...(newTitle ? { title: newTitle } : {}),
      before,
      ...(activeProposal.feedback ? { feedback: activeProposal.feedback } : {}),
    });
    if (!r.ok) return toast((r as { error?: string }).error ?? "收下失败");
    clearFocus();
    toast("已收下并存为新版本");
    void load();
  };

  const isVideo = VIDEO_PLATFORMS.has(c.platform);
  const imageSlots = [...body.matchAll(/\[IMAGE:\s*(.+?)\]/g)].length;

  const transitionNext = async () => {
    if (!nextStatus) return;
    if (dirty) return toast("有未保存的改动——先保存或撤销再流转");
    const r = await invoke("content:transition", { id: props.id, target_status: nextStatus });
    if (!r.ok) return toast(r.error ?? "流转失败");
    toast("已流转到「" + (VARIANT_STATUS[nextStatus] ?? nextStatus) + "」");
    void load();
  };

  return (
    <div className={"editor" + (drawerOpen ? " ed-with-drawer" : "")}>
      <div className="ed-topbar">
        <button onClick={props.back}>← 看板</button>
        <span className="mono muted">{platformLabel(c.platform)} · {VARIANT_STATUS[c.status] ?? c.status}</span>
        <span className="ed-topbar-right">
          {!activeProposal && <button onClick={startDraftFocus}>改这篇 →</button>}
          <button onClick={() => setMode(mode === "edit" ? "preview" : "edit")}>
            {mode === "edit" ? "预览" : "回到编辑"}
          </button>
          {allowed.length > 0 && (
            <>
              <select value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}>
                {allowed.map((status) => <option key={status} value={status}>{VARIANT_STATUS[status] ?? status}</option>)}
              </select>
              <button onClick={() => void transitionNext()}>推进 →</button>
            </>
          )}
          <button className={drawerOpen ? "on" : ""} onClick={toggleDrawer}>
            {drawerOpen ? "收起工具 ›" : "‹ 工具"}
          </button>
        </span>
      </div>

      <div className="ed-main-row">
      <div className="ed-stage">
        <div className="ed-canvas">
          {c.lastError && (
            <div className="ed-error">
              ⚠️ 上次生成中断：{String(c.lastError).slice(0, 120)}{" "}
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
            <div className="pending-edit">
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
                <button className="primary" onClick={() => void adoptProposal()}>收下这版</button>
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

        {/* 封面/配图/成片要宽度,不进窄抽屉——沉到正文下方,默认折叠,不打扰写作 */}
        <div className="ed-below">
          {isVideo && (
            <>
              <nav className="video-publish-flow" aria-label="视频发布流程">
                <span className={videoDone ? "flow-step flow-step-done" : "flow-step flow-step-current"}><b>1</b> 成片</span>
                <button
                  className={coverApproved ? "flow-step flow-step-done" : videoDone ? "flow-step flow-step-current" : "flow-step"}
                  disabled={!videoDone}
                  onClick={() => {
                    setCoverOpen(true);
                    window.setTimeout(() => panelRefs.cover.current?.scrollIntoView({ block: "start" }), 0);
                  }}
                ><b>2</b> 封面</button>
                <button
                  className={videoDone && coverApproved ? "flow-step flow-step-current" : "flow-step"}
                  disabled={!videoDone || !coverApproved}
                  onClick={() => {
                    setDrawerOpen(true);
                    localStorage.setItem(DRAWER_KEY, "1");
                  }}
                ><b>3</b> 发布</button>
              </nav>
              <div ref={panelRefs.video}>
                <VideoPanel contentId={props.id} onReadyForCover={setVideoDone} />
              </div>
            </>
          )}
          <details
            className="ed-tools"
            ref={panelRefs.cover}
            open={coverOpen}
            onToggle={(event) => setCoverOpen(event.currentTarget.open)}
          >
            <summary>封面设计{isVideo ? " · 发布前必做" : ""}{coverApproved ? " · 已选用 ✓" : ""}</summary>
            <CoverPanel contentId={props.id} platform={c.platform} onApprovalChange={setCoverApproved} />
          </details>
          <details
            className="ed-tools"
            ref={panelRefs.images}
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
        <aside className="ed-drawer">
          <div className="ed-drawer-head">
            <strong>工具</strong>
            <button onClick={toggleDrawer}>收起 ›</button>
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
      )}
      </div>

      <div className="ed-savebar">
        <span className="muted ed-hint">✎ 选中一段 →「改这段」,或右上「改这篇」整篇改</span>
        <input className="sel-input" placeholder="为什么这么改?(可选,一句话——教团队学你)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="primary" onClick={() => void save()}>
          保存{dirty ? " ●" : ""}
        </button>
      </div>
    </div>
  );
}
