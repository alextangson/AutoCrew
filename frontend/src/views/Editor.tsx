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
import { ArticleImagesPanel } from "./ArticleImagesPanel";
import { EditingWorkspace } from "./EditingWorkspace";
import { CoverWorkspace } from "./CoverWorkspace";
import { PublishWorkspace } from "./PublishWorkspace";
import { StageAdvance } from "./StageAdvance";
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
  const [transitions, setTransitions] = useState<AllowedTransition[]>([]);
  const [versions, setVersions] = useState<VersionLike[]>([]);
  /** 视频线跑到哪了。只为文案页那条「此稿已有剪辑进度」横幅服务——不静默丢进度（spec §3①） */
  const [videoStarted, setVideoStarted] = useState(false);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const proposal = useRevisionProposal();
  const focus = useRevisionFocus();
  // 抽屉/配图面板的开合是用户偏好,记住它——每次进来都要重开是最烦人的那种细节
  const [drawerOpen, setDrawerOpen] = useState(() => localStorage.getItem(DRAWER_KEY) === "1");
  const [articleImagesOpen, setArticleImagesOpen] = useState(() => localStorage.getItem(IMAGES_KEY) === "1");
  const [fallback, setFallback] = useState<string | null>(null);
  const imagesRef = useRef<HTMLDetailsElement | null>(null);
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
    // transitions 带阶段门预判(后端算);界面不自己推演规则,灰显与原因都来自这一份
    setTransitions(((at as Record<string, unknown>).transitions ?? []) as AllowedTransition[]);
    setVersions((((vr as Record<string, unknown>).data ?? {}) as { versions?: VersionLike[] }).versions ?? []);
    if (VIDEO_PLATFORMS.has(content.platform)) {
      const vs = await videoStatus(props.id);
      setVideoStarted(Boolean(vs.ok && vs.data?.state));
    }
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
      if (here !== want) toast(`这篇现在在「${WORKSPACE_LABEL[here]}」——用顶栏「推进」才能到${panel === "cover" ? "封面" : "剪辑"}阶段`);
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
    const receipt = r as { styleLearned?: { summary?: string }; warning?: string };
    toast("已收下并存为新版本" + (receipt.styleLearned?.summary ? " · " + receipt.styleLearned.summary : ""));
    if (receipt.warning) toast(receipt.warning);
    void load();
  };

  const isVideo = VIDEO_PLATFORMS.has(c.platform);
  const imageSlots = [...body.matchAll(/\[IMAGE:\s*(.+?)\]/g)].length;

  const workspace = workspaceForStatus(c.status);
  const stageBar = (
    <div className="ed-topbar">
      <button onClick={props.back}>← 看板</button>
      <span className="mono muted">
        {platformLabel(c.platform)} · {VARIANT_STATUS[c.status] ?? c.status}
        {workspace !== "draft" ? ` · ${WORKSPACE_LABEL[workspace]}` : ""}
      </span>
      <span className="ed-topbar-right">
        {workspace === "draft" && !activeProposal && <button onClick={startDraftFocus}>改这篇 →</button>}
        {workspace === "draft" && (
          <button onClick={() => setMode(mode === "edit" ? "preview" : "edit")}>
            {mode === "edit" ? "预览" : "回到编辑"}
          </button>
        )}
        <StageAdvance
          contentId={props.id}
          currentStatus={c.status}
          transitions={transitions}
          dirty={workspace === "draft" && dirty}
          reload={load}
        />
        {workspace === "draft" && (
          <button className={drawerOpen ? "on" : ""} onClick={toggleDrawer}>
            {drawerOpen ? "收起工具 ›" : "‹ 工具"}
          </button>
        )}
      </span>
    </div>
  );

  // 工作台随状态（spec §2）：文案之外的三张台子是整页，不带写作画布与抽屉
  if (workspace !== "draft") {
    return (
      <div className="editor">
        {stageBar}
        <div className="ed-main-row">
          {workspace === "editing" && <EditingWorkspace content={c} reload={load} />}
          {workspace === "cover" && <CoverWorkspace content={c} reload={load} />}
          {workspace === "publish" && (
            <PublishWorkspace content={c} versions={versions} reload={load} send={send} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={"editor" + (drawerOpen ? " ed-with-drawer" : "")}>
      {stageBar}

      <div className="ed-main-row">
      <div className="ed-stage">
        <div className="ed-canvas">
          {/* 旧稿在途 / 从剪辑回文案改稿：剪辑进度一个字都没丢，说清楚，不让人以为白剪了（spec §3①③） */}
          {isVideo && (videoStarted || c.videoReadyAt) && (
            <div className="vid-warn">
              这篇已经有剪辑进度（决策与成片都留着，回文案改稿不会丢）——
              用顶栏「推进」到「剪辑」接着做。
            </div>
          )}

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
