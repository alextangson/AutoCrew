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
import { invoke } from "../transport";
import { toast } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import { SelectionBar } from "./SelectionBar";
import { CoverPanel } from "./CoverPanel";
import { platformLabel, VARIANT_STATUS, VIDEO_PLATFORMS, type Content } from "../lib";

interface PendingEdit {
  before: string;
  after: string;
  start: number;
  end: number;
}

export function Editor(props: { id: string; back: () => void }) {
  const [c, setC] = useState<Content | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [versions, setVersions] = useState<Array<{ version: number; note?: string; savedAt: string }>>([]);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [rewriting, setRewriting] = useState(false);
  const [pending, setPending] = useState<PendingEdit | null>(null);
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
    setAllowed(((at as Record<string, unknown>).allowedTransitions ?? []) as string[]);
    setVersions((((vr as Record<string, unknown>).data ?? {}) as { versions?: typeof versions }).versions ?? []);
  };
  useEffect(() => {
    void load();
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

  const rewrite = async (inst: string) => {
    if (!sel || rewriting) return;
    const before = body.slice(sel.start, sel.end);
    setRewriting(true);
    const r = await invoke("draft:rewrite_selection", { body, selection: before, instruction: inst });
    setRewriting(false);
    if (!r.ok) return toast(r.error ?? "改写失败");
    const after = ((r as { data?: { rewritten?: string } }).data?.rewritten ?? "").trim();
    if (!after) return toast("模型没有返回改写结果,再试一次");
    setPending({ before, after, start: sel.start, end: sel.end });
  };

  const adoptPending = async () => {
    if (!pending) return;
    setBody((b) => b.slice(0, pending.start) + pending.after + b.slice(pending.end));
    void invoke("style:record_edit", { content_id: props.id, before: pending.before, after: pending.after });
    setPending(null);
    setSel(null);
    toast("已替换选段(记入风格校准)——记得保存");
  };

  const submitAdoption = async (verdict: string, reason?: string, reasonNote?: string) => {
    const payload: Record<string, unknown> = { id: props.id, verdict };
    if (reason) payload.reason = reason;
    if (reasonNote) payload.reason_note = reasonNote;
    const r = await invoke("content:adoption", payload);
    if (!r.ok) return toast(r.error ?? "记录失败");
    const stats = (r as { stats?: { rate: number | null; judged: number; adopted: number; lightEdit: number } }).stats;
    toast(
      "已记录裁决" +
        (stats && stats.rate !== null && stats.judged > 0
          ? ` · 采纳率 ${Math.round(stats.rate * 100)}%（${stats.adopted + stats.lightEdit}/${stats.judged}）`
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
    if (!window.confirm("推送到公众号草稿箱?(会生成配图并调用发布脚本,最后群发仍由你在公众号后台确认)")) return;
    toast("推送中——生成配图约 2 分钟,完成后看提示");
    const r = await invoke("publish:wechat_draft", { content_id: props.id });
    if (!r.ok) return toast(r.error ?? "推送失败");
    toast("已进草稿箱:" + ((r as { nextStep?: string }).nextStep ?? "去公众号后台检查"));
  };

  const ADOPT: Array<[string, string]> = [["adopted", "采纳"], ["light_edit", "轻改采纳"], ["rewritten", "重写"]];
  const isVideo = VIDEO_PLATFORMS.has(c.platform);

  return (
    <div className="editor">
      <div className="board-bar">
        <button onClick={props.back}>← 看板</button>
        <span className="mono muted">{platformLabel(c.platform)} · {VARIANT_STATUS[c.status] ?? c.status}</span>
        {allowed.map((s) => (
          <button
            key={s}
            onClick={async () => {
              if (dirty) return toast("有未保存的改动——先保存或撤销再流转");
              const r = await invoke("content:transition", { id: props.id, target_status: s });
              if (!r.ok) return toast(r.error ?? "流转失败");
              toast("已流转到「" + (VARIANT_STATUS[s] ?? s) + "」");
              void load();
            }}
          >
            → {VARIANT_STATUS[s] ?? s}
          </button>
        ))}
      </div>

      {c.lastError && (
        <div className="ed-error">
          ⚠️ 上次生成中断：{String(c.lastError).slice(0, 120)}{" "}
          <button onClick={() => { send(`用选题《${(c.title || "").replace(/^［生成中断］|^［生成中］/, "")}》重新写一篇${platformLabel(c.platform)}原生版本`); toast("已派给总编辑重写"); }}>
            重新生成
          </button>
        </div>
      )}

      <input className="ed-title serif" value={title} placeholder="标题" onChange={(e) => setTitle(e.target.value)} />

      <div className="ed-mode mono">
        <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>编辑</button>
        <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>预览</button>
      </div>

      {pending && (
        <div className="pending-edit">
          <div className="mono muted">改写待定——采纳会替换选段并记入风格校准</div>
          <pre className="pe-before">{pending.before}</pre>
          <pre className="pe-after">{pending.after}</pre>
          <div className="row-actions">
            <button className="primary" onClick={() => void adoptPending()}>采纳</button>
            <button onClick={() => setPending(null)}>放弃</button>
          </div>
        </div>
      )}

      {mode === "edit" ? (
        <div className="ed-body-wrap">
          <textarea ref={taRef} className="ed-body" value={body} onChange={(e) => setBody(e.target.value)} onSelect={onSelect} onKeyUp={onSelect} onMouseUp={onSelect} />
          {sel && !pending && (
            <SelectionBar ta={taRef.current} sel={sel} rewriting={rewriting} onRewrite={(inst) => void rewrite(inst)} />
          )}
        </div>
      ) : (
        <div className="md-preview">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{body}</ReactMarkdown>
        </div>
      )}
      {mode === "edit" && (
        <p className="muted ed-hint">✎ 选中任意一段 → 改写工具条浮现在选区旁,AI 只改那一段(自由输入修改要求也行)</p>
      )}

      <div className="ed-save-row">
        <input className="sel-input" placeholder="为什么这么改?(可选,一句话——教团队学你)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="primary" onClick={() => void save()}>
          保存(存为新版本){dirty ? " ●" : ""}
        </button>
      </div>

      <div className="ed-section">
        <span className="mono muted">采纳裁决：</span>
        {ADOPT.map(([v, label]) => (
          <AdoptButton key={v} verdict={v} label={label} current={c.adoption?.verdict} submit={submitAdoption} />
        ))}
      </div>

      <div className="ed-section">
        <span className="mono muted">发布：</span>
        <button onClick={() => void doClipboard()}>排版发布文案</button>
        {c.platform === "wechat_mp" && <button onClick={() => void pushWechat()}>推公众号草稿箱</button>}
        {isVideo && (
          <button onClick={() => { send(`给稿件 ${props.id} 备视频发布件(平台标题+发布文案+分镜+封面)`); toast("发布员开工——看右侧对话"); }}>
            备视频发布件{c.videoKit ? "(已有,重新生成)" : ""}
          </button>
        )}
      </div>

      <CoverPanel contentId={props.id} platform={c.platform} />

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

      <AssetsSection contentId={props.id} assets={(c as unknown as { assets?: Array<{ filename: string; type: string; description?: string }> }).assets ?? []} reload={load} />

      {versions.length > 0 && (
        <div className="ed-versions">
          <div className="mono muted">版本（{versions.length}）</div>
          {[...versions].reverse().slice(0, 8).map((v) => (
            <div key={v.version} className="row">
              <span className="mono pri">v{v.version}</span>
              <span className="row-title muted">{v.note ?? ""}</span>
              {v.version !== versions.length && (
                <button
                  onClick={async () => {
                    if (dirty) return toast("有未保存的改动——先保存再回滚");
                    const r = await invoke("content:revert", { id: props.id, version: v.version });
                    toast(r.ok ? `已回滚到 v${v.version}(生成新版本快照)` : (r.error ?? "回滚失败"));
                    if (r.ok) void load();
                  }}
                >
                  回滚到此版
                </button>
              )}
            </div>
          ))}
        </div>
      )}
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
        {isCurrent ? "✓ " : ""}重写
      </button>
      {asking && (
        <span className="adopt-reasons">
          {([["style_mismatch", "风格不像"], ["factual_error", "事实错"], ["structure_bad", "结构差"]] as const).map(([v, txt]) => (
            <button key={v} onClick={() => { setAsking(false); void props.submit("rewritten", v); }}>{txt}</button>
          ))}
          <input
            className="sel-input"
            placeholder="或用你的话说哪里不行,回车记录"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && noteText.trim()) {
                setAsking(false);
                void props.submit("rewritten", undefined, noteText.trim());
              }
            }}
          />
          <button onClick={() => { setAsking(false); void props.submit("rewritten"); }}>跳过</button>
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
        <span className="mono muted">素材（{props.assets.length}）：</span>
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
              if (!window.confirm(`移除挂接素材「${a.filename}」?(项目内副本删除,素材库不受影响)`)) return;
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
