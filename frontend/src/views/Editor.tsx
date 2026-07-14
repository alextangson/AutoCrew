/**
 * 编辑器(B 期,qingmo 设计细节原生重实现):60vh 正文 + 标题可改 + 框选浮层 AI 快改
 * + diff 待定卡(采纳→styleRecordEdit 回喂校准) + 保存带"为什么改" + 采纳裁决
 * + 状态流转 + 版本回滚 + 发布动作。未保存改动进 localStorage 暂存(刷新不丢),
 * 版本/diff 仍以显式保存为界——一次保存=一次完整编辑意图,蒸馏信号不碎片化。
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// 中文写作常见的「**小标题。**正文」在 CommonMark 里闭合失败（标点+汉字紧邻），此插件修正
import remarkCjkFriendly from "remark-cjk-friendly";
import { invoke, subscribeEvents } from "../transport";
import { toast, confirmDialog } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import { SelectionBar } from "./SelectionBar";
import { setFocus, clearFocus, clearProposal, useRevisionProposal } from "../revision";
import { applySpan } from "../apply-span";
import { CoverPanel } from "./CoverPanel";
import { ArticleImagesPanel } from "./ArticleImagesPanel";
import { platformLabel, VARIANT_STATUS, VIDEO_PLATFORMS, type Content } from "../lib";
import { compareVersions, isGenericVersionNote, type VersionLike } from "../version-diff";

/** 存量版本备注是英文自动串(V5.6.2 起后端已改中文)——显示层兜底汉化 */
function versionNoteLabel(note?: string): string {
  if (!note) return "";
  if (note === "Initial draft") return "初稿";
  const edit = note.match(/^Edit v(\d+)$/);
  if (edit) return `第 ${edit[1]} 版`;
  const revert = note.match(/^Reverted to v(\d+)$/);
  if (revert) return `回滚到 v${revert[1]}`;
  return note;
}

export function Editor(props: { id: string; back: () => void }) {
  const [c, setC] = useState<Content | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [nextStatus, setNextStatus] = useState("");
  const [versions, setVersions] = useState<VersionLike[]>([]);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const proposal = useRevisionProposal();
  const [articleImagesOpen, setArticleImagesOpen] = useState(true);
  const [clip, setClip] = useState<{ copyText: string; publishUrl: string; fromVideoKit?: boolean } | null>(null);
  const [metrics, setMetrics] = useState<{ views: string; likes: string; comments: string }>({ views: "", likes: "", comments: "" });
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
    setVersions((((vr as Record<string, unknown>).data ?? {}) as { versions?: typeof versions }).versions ?? []);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const onSelect = () => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart, selectionEnd } = ta;
    setSel(selectionEnd > selectionStart ? { start: selectionStart, end: selectionEnd } : null);
  };

  const activeProposal = proposal && proposal.contentId === props.id ? proposal : null;

  const startSelectionFocus = () => {
    if (!sel) return;
    const text = body.slice(sel.start, sel.end);
    setFocus({ contentId: props.id, scope: "selection", selection: { start: sel.start, end: sel.end, text } });
    setSel(null);
    toast("已锁定这段——去右边总编辑说怎么改,改完在这儿收下");
  };

  const startDraftFocus = () => {
    setFocus({ contentId: props.id, scope: "draft" });
    toast("已锁定整篇——去右边总编辑说怎么改,改完在这儿收下");
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

  const submitAdoption = async (verdict: string, reason?: string, reasonNote?: string) => {
    const payload: Record<string, unknown> = { id: props.id, verdict };
    if (reason) payload.reason = reason;
    if (reasonNote) payload.reason_note = reasonNote;
    const r = await invoke("content:adoption", payload);
    if (!r.ok) return toast(r.error ?? "记录失败");
    const stats = (r as { stats?: { rate: number | null; judged: number; adopted: number; lightEdit: number } }).stats;
    toast(
      "反馈已记录——团队会据此学习你的标准" +
        (stats && stats.rate !== null && stats.judged > 0
          ? ` · 可用率 ${Math.round(stats.rate * 100)}%（${stats.adopted + stats.lightEdit}/${stats.judged}）`
          : ""),
    );
    void load();
  };

  const doClipboard = async () => {
    const r = await invoke("publish:clipboard", { content_id: props.id });
    if (!r.ok) return toast(r.error ?? "排版失败");
    setClip((r as unknown as { data: typeof clip }).data);
  };

  const pushWechat = async () => {
    const yes = await confirmDialog({
      title: "推送到公众号草稿箱?",
      body: "会复用你在「正文配图」里已经确认的图片并调用发布脚本；只进草稿箱，最后群发仍由你在公众号后台确认。",
      confirmLabel: "推送",
    });
    if (!yes) return;
    const approval = await invoke("publish:request_wechat", { content_id: props.id });
    if (!approval.ok || typeof approval.approvalToken !== "string") {
      return toast(approval.error ?? "发布前检查未通过");
    }
    toast("推送中——正在复用正文配图并排版,完成后看提示");
    const r = await invoke("publish:wechat_draft", {
      content_id: props.id,
      approval_token: approval.approvalToken,
    });
    if (!r.ok) return toast(r.error ?? "推送失败");
    toast("已进草稿箱:" + ((r as { nextStep?: string }).nextStep ?? "去公众号后台检查"));
  };

  const ADOPT: Array<[string, string]> = [
    ["adopted", "直接能用"],
    ["light_edit", "小改后能用"],
    ["rewritten", "基本要重写"],
  ];
  const isVideo = VIDEO_PLATFORMS.has(c.platform);
  const transitionNext = async () => {
    if (!nextStatus) return;
    if (dirty) return toast("有未保存的改动——先保存或撤销再流转");
    const r = await invoke("content:transition", { id: props.id, target_status: nextStatus });
    if (!r.ok) return toast(r.error ?? "流转失败");
    toast("已流转到「" + (VARIANT_STATUS[nextStatus] ?? nextStatus) + "」");
    void load();
  };

  return (
    <div className="editor">
      <div className="board-bar">
        <button onClick={props.back}>← 看板</button>
        <span className="mono muted">{platformLabel(c.platform)} · {VARIANT_STATUS[c.status] ?? c.status}</span>
        {allowed.length > 0 && (
          <span className="ed-next-action">
            <select value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}>
              {allowed.map((status) => <option key={status} value={status}>{VARIANT_STATUS[status] ?? status}</option>)}
            </select>
            <button onClick={() => void transitionNext()}>推进 →</button>
          </span>
        )}
      </div>

      <div className="ed-grid">
      <div className="ed-main">

      {c.lastError && (
        <div className="ed-error">
          ⚠️ 上次生成中断：{String(c.lastError).slice(0, 120)}{" "}
          <button onClick={() => void send(`用选题《${(c.title || "").replace(/^［生成中断］|^［生成中］/, "")}》重新写一篇${platformLabel(c.platform)}原生版本`).then((receipt) => {
            toast(receipt.ok ? "重写任务已受理" : (receipt.error ?? "派活失败"));
          })}>
            重新生成
          </button>
        </div>
      )}

      <input className="ed-title serif" value={title} placeholder="标题" onChange={(e) => setTitle(e.target.value)} />

      <div className="ed-mode mono">
        <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>编辑</button>
        <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>预览</button>
        {!activeProposal && (
          <button style={{ marginLeft: "auto" }} onClick={startDraftFocus}>改这篇 →</button>
        )}
      </div>

      {activeProposal && (
        <div className="pending-edit">
          <div className="mono muted">
            总编辑的修改提案{activeProposal.scope === "selection" ? "（这一段）" : "（整篇）"}——收下才落库,旧版进版本记录;不满意就在右边继续说
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

      {mode === "edit" ? (
        <div className="ed-body-wrap">
          <textarea
            ref={taRef}
            className="ed-body"
            value={body}
            readOnly={activeProposal?.scope === "selection"}
            onChange={(e) => setBody(e.target.value)}
            onSelect={onSelect}
            onKeyUp={onSelect}
            onMouseUp={onSelect}
          />
          {sel && !activeProposal && <SelectionBar ta={taRef.current} sel={sel} onFocus={startSelectionFocus} />}
        </div>
      ) : (
        <div className="md-preview">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{body}</ReactMarkdown>
        </div>
      )}
      {mode === "edit" && (
        <p className="muted ed-hint">✎ 选中一段 →「改这段」锁定它、去右边总编辑来回磨;或右上「改这篇」整篇改。改完在这儿收下。</p>
      )}

      <div className="ed-save-row">
        <input className="sel-input" placeholder="为什么这么改?(可选,一句话——教团队学你)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="primary" onClick={() => void save()}>
          保存(存为新版本){dirty ? " ●" : ""}
        </button>
      </div>
      </div>

      <aside className="ed-side">

      <details className="ed-tools">
        <summary>这篇稿子好不好用？{c.adoption?.verdict ? ` · ${ADOPT.find(([value]) => value === c.adoption?.verdict)?.[1] ?? "已反馈"}` : ""}</summary>
        <p className="muted adoption-guide">
          成稿后选一次：它只会告诉编辑部这版是否达到你的标准，用来改进后续写作；不会自动改正文，也不会发布。
        </p>
        <div className="ed-section">
          {ADOPT.map(([v, label]) => (
            <AdoptButton key={v} verdict={v} label={label} current={c.adoption?.verdict} submit={submitAdoption} />
          ))}
        </div>
      </details>

      <details className="ed-tools">
        <summary>发布与分发</summary>
        <div className="ed-section">
          <button onClick={() => void doClipboard()}>排版发布文案</button>
          {c.platform === "wechat_mp" && <button onClick={() => void pushWechat()}>推公众号草稿箱</button>}
          {isVideo && (
            <button onClick={() => void send(`给稿件 ${props.id} 备视频发布件(平台标题+发布文案+分镜+封面)`).then((receipt) => {
              toast(receipt.ok ? "发布件任务已受理——看右侧对话" : (receipt.error ?? "派活失败"));
            })}>
              备视频发布件{c.videoKit ? "(已有,重新生成)" : ""}
            </button>
          )}
        </div>
      </details>

      {clip && (
        <div className="pending-edit">
          <div className="mono muted">发布文案{clip.fromVideoKit ? "(来自发布件)" : ""} · 复制后到平台粘贴</div>
          <pre className="ccard-body">{clip.copyText}</pre>
          <div className="row-actions">
            <button
              className="primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(clip.copyText);
                  toast("已复制到剪贴板");
                } catch {
                  toast("剪贴板写入失败,请手动复制");
                }
              }}
            >
              复制
            </button>
            <a href={clip.publishUrl} target="_blank" rel="noreferrer"><button>打开平台后台 ↗</button></a>
            <button
              onClick={async () => {
                const r = await invoke("publish:confirm", { content_id: props.id });
                toast(r.ok ? "已标记为已发布——记得 T+1 回数据" : (r.error ?? "确认失败"));
                if (r.ok) { setClip(null); void load(); }
              }}
            >
              我已发布,确认
            </button>
          </div>
        </div>
      )}

      {c.status === "published" && (
        <div className="ed-section">
          <span className="mono muted">回流数据：</span>
          {(["views", "likes", "comments"] as const).map((k) => (
            <input
              key={k}
              className="bf-input"
              type="number"
              placeholder={{ views: "阅读/播放", likes: "点赞", comments: "评论" }[k]}
              value={metrics[k]}
              onChange={(e) => setMetrics((m) => ({ ...m, [k]: e.target.value }))}
            />
          ))}
          <button
            onClick={async () => {
              const m: Record<string, number> = {};
              for (const [k, v] of Object.entries(metrics)) if (v !== "") m[k] = Number(v);
              if (Object.keys(m).length === 0) return toast("至少填一个数字");
              const r = await invoke("flywheel:record", { content_id: props.id, metrics: m });
              toast(r.ok ? "已回填 ✓ 数据分析师归档" : (r.error ?? "回填失败"));
              if (r.ok) void load();
            }}
          >
            记录回流
          </button>
        </div>
      )}

      <details className="ed-tools">
        <summary>素材附件</summary>
        <AssetsSection contentId={props.id} assets={(c as unknown as { assets?: Array<{ filename: string; type: string; description?: string }> }).assets ?? []} reload={load} />
      </details>

      {versions.length > 0 && (
        <details className="ed-tools ed-version-tools">
          <summary>版本记录 · {versions.length} 版</summary>
          <div className="ed-versions">
          <div className="ed-version-head">
            <strong>版本记录</strong>
            <span className="mono muted">共 {versions.length} 版 · 每次保存都会记录修改说明</span>
          </div>
          {[...versions].reverse().slice(0, 8).map((v) => {
            const previous = versions.find((item) => item.version === v.version - 1);
            const diff = compareVersions(previous, v);
            const note = isGenericVersionNote(v.note) ? diff.summary : versionNoteLabel(v.note);
            const expanded = expandedVersion === v.version;
            return (
              <div key={v.version} className="ed-version-card">
                <div className="ed-version-row">
                  <span className="mono ed-version-number">v{v.version}</span>
                  <div className="ed-version-main">
                    <strong>{note}</strong>
                    {!isGenericVersionNote(v.note) && <span className="muted">{diff.summary}</span>}
                    <span className="mono muted">{new Date(v.savedAt).toLocaleString("zh-CN", { hour12: false })}</span>
                  </div>
                  {v.version > 1 && (
                    <button onClick={() => setExpandedVersion(expanded ? null : v.version)}>
                      {expanded ? "收起差异" : "查看差异"}
                    </button>
                  )}
                  {v.version !== versions.length && (
                    <button
                      onClick={async () => {
                        if (dirty) return toast("有未保存的改动——先保存再回滚");
                        const r = await invoke("content:revert", { id: props.id, version: v.version });
                        toast(r.ok ? `已回滚到 v${v.version}(生成新版本快照)` : (r.error ?? "回滚失败"));
                        if (r.ok) void load();
                      }}
                    >
                      回滚
                    </button>
                  )}
                </div>
                {expanded && (
                  <div className="ed-version-diff">
                    {diff.titleChanged && previous?.title && v.title && (
                      <div><span className="diff-del">− {previous.title}</span><span className="diff-add">＋ {v.title}</span></div>
                    )}
                    {diff.removed.slice(0, 6).map((text, index) => (
                      <p key={`del-${index}`} className="diff-del">− {text}</p>
                    ))}
                    {diff.added.slice(0, 6).map((text, index) => (
                      <p key={`add-${index}`} className="diff-add">＋ {text}</p>
                    ))}
                    {!diff.titleChanged && diff.removed.length === 0 && diff.added.length === 0 && (
                      <p className="muted">与上一版正文一致。</p>
                    )}
                    {(diff.removed.length > 6 || diff.added.length > 6) && (
                      <p className="mono muted">仅展示前 6 处差异。</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </details>
      )}
      </aside>
      </div>

      <div className="ed-media">
        <details className="ed-tools">
          <summary>封面设计</summary>
          <CoverPanel contentId={props.id} platform={c.platform} />
        </details>
        <details
          className="ed-tools"
          open={articleImagesOpen}
          onToggle={(event) => setArticleImagesOpen(event.currentTarget.open)}
        >
          <summary>正文配图 · {[...body.matchAll(/\[IMAGE:\s*(.+?)\]/g)].length} 个位置</summary>
          <ArticleImagesPanel contentId={props.id} dirty={dirty} body={body} />
        </details>
      </div>
    </div>
  );
}

function AdoptButton(props: {
  verdict: string;
  label: string;
  current?: string;
  submit: (verdict: string, reason?: string, reasonNote?: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [noteText, setNoteText] = useState("");
  const isCurrent = props.current === props.verdict;
  if (props.verdict !== "rewritten") {
    return (
      <button className={isCurrent ? "chip chip-pub" : ""} onClick={() => void props.submit(props.verdict)}>
        {isCurrent ? "✓ " : ""}
        {props.label}
      </button>
    );
  }
  return (
    <span className="adopt-rw">
      <button className={isCurrent ? "chip chip-pub" : ""} onClick={() => setAsking((a) => !a)}>
        {isCurrent ? "✓ " : ""}{props.label}
      </button>
      {asking && (
        <span className="adopt-reasons">
          {([["style_mismatch", "风格不像"], ["factual_error", "有事实错误"], ["structure_bad", "结构不好"]] as const).map(([v, txt]) => (
            <button key={v} onClick={() => { setAsking(false); void props.submit("rewritten", v); }}>{txt}</button>
          ))}
          <input
            className="sel-input"
            placeholder="或写一句主要问题，回车记录"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && noteText.trim()) {
                setAsking(false);
                void props.submit("rewritten", undefined, noteText.trim());
              }
            }}
          />
          <button onClick={() => { setAsking(false); void props.submit("rewritten"); }}>只记录结果</button>
        </span>
      )}
    </span>
  );
}


function AssetsSection(props: {
  contentId: string;
  assets: Array<{ filename: string; type: string; description?: string }>;
  reload: () => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const [lib, setLib] = useState<Array<{ id: string; name: string; missing?: boolean }>>([]);

  const openPicker = async () => {
    if (picking) return setPicking(false);
    const r = await invoke("library:list");
    if (!r.ok) return toast(r.error ?? "素材库加载失败");
    const d = (r as unknown as { data: { assets?: typeof lib } }).data;
    setLib((d.assets ?? []).filter((a) => !a.missing));
    setPicking(true);
  };

  return (
    <div className="ed-section" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div>
        <span className="mono muted ed-label">素材（{props.assets.length}）：</span>
        <button onClick={() => void openPicker()}>{picking ? "收起" : "从素材库挂接"}</button>
        <button
          onClick={async () => {
            const r = await invoke("content:open_folder", { id: props.contentId });
            if (!r.ok) return toast((r as { error?: string }).error ?? "打开失败");
            const d = r as { opened?: boolean; path?: string };
            toast(d.opened ? "已在 Finder 打开——文案 draft.md、封面、素材都在里面" : `文件夹:${d.path ?? ""}`);
          }}
        >
          打开稿件文件夹
        </button>
      </div>
      {props.assets.map((a) => (
        <div key={a.filename} className="row">
          <span className="row-title">{a.filename}</span>
          <span className="muted mono">{a.type}{a.description ? " · " + a.description : ""}</span>
          <button
            onClick={async () => {
              const yes = await confirmDialog({
                title: `移除挂接素材「${a.filename}」?`,
                body: "删除稿件项目内的副本,素材库原件不受影响。",
                confirmLabel: "移除",
                danger: true,
              });
              if (!yes) return;
              const r = await invoke("content:asset_remove", { content_id: props.contentId, filename: a.filename });
              toast(r.ok ? "已移除" : (r.error ?? "移除失败"));
              if (r.ok) void props.reload();
            }}
          >
            移除
          </button>
        </div>
      ))}
      {picking && (
        <div className="pending-edit">
          {lib.length === 0 && <p className="muted">素材库暂无可用素材——先到「素材库」粘路径导入。</p>}
          {lib.map((a) => (
            <div key={a.id} className="row">
              <span className="row-title">{a.name}</span>
              <button
                onClick={async () => {
                  const r = await invoke("content:asset_add", { content_id: props.contentId, library_id: a.id });
                  toast(r.ok ? `已挂接「${a.name}」` : (r.error ?? "挂接失败"));
                  if (r.ok) {
                    setPicking(false);
                    void props.reload();
                  }
                }}
              >
                挂接
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
