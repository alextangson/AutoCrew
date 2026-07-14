/**
 * 管线看板(B 期,qingmo 设计细节原生重实现):
 * 列=灵感库→在写→待审→待发布→已发布;卡=内容原子(idea+平台变体)。
 * 拖拽换列=content:transition;卡可入回收站(软删)+回收站恢复;
 * 点原子→平台矩阵(灵感详情/方向补充/有稿点开/无稿生成)。
 */
import { useEffect, useMemo, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { toast, openDialog } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import {
  BOARD_COLUMNS, DROP_TARGET_STATUS, STATUS_COLUMN, VARIANT_STATUS, PLATFORM_CATALOG,
  platformLabel, sourceLabel, groupAtoms, atomRep, type Atom, type Content, type Topic,
} from "../lib";

/** 灵感行副标签:来源 + 天龄(3 天未选用会自动清,天龄是紧迫感) */
function ideaAge(createdAt?: string): string {
  if (!createdAt) return "";
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
  if (!isFinite(days) || days < 0) return "";
  return days === 0 ? "今天" : `${days} 天前`;
}

interface TrashData {
  topics: Topic[];
  contents: Content[];
}

export function Board(props: { openEditor: (id: string) => void }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [contents, setContents] = useState<Content[]>([]);
  const [seats, setSeats] = useState<string[]>(["wechat_mp"]);
  const [mode, setMode] = useState<{ kind: "columns" } | { kind: "matrix"; atomKey: string } | { kind: "trash" }>({ kind: "columns" });
  const [trash, setTrash] = useState<TrashData>({ topics: [], contents: [] });
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [radarBusy, setRadarBusy] = useState<"more" | "rescore" | null>(null);
  const send = useChatSend();

  const load = async () => {
    const [tr, cr, ob] = await Promise.all([invoke("topics:list"), invoke("content:list"), invoke("onboarding:status")]);
    if (tr.ok) setTopics(((tr as Record<string, unknown>).topics ?? (tr as { data?: { topics?: Topic[] } }).data?.topics ?? []) as Topic[]);
    if (cr.ok) setContents(((cr as Record<string, unknown>).contents ?? []) as Content[]);
    const platforms = (ob as { platforms?: string[] }).platforms ?? (ob as { data?: { platforms?: string[] } }).data?.platforms;
    if (Array.isArray(platforms) && platforms.length) setSeats(platforms);
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    let timer: number | undefined;
    const off = subscribeEvents((event) => {
      if (event.kind !== "engine") return;
      const kind = String(event.data.kind ?? "");
      if (!event.data.contentId && !["radar", "trash", "transition", "run_done", "run_failed"].includes(kind)) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 180);
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const atoms = useMemo(() => groupAtoms(topics, contents), [topics, contents]);
  const cols = useMemo(() => {
    const c: Atom[][] = BOARD_COLUMNS.map(() => []);
    for (const atom of atoms) {
      const rep = atomRep(atom);
      c[rep ? (STATUS_COLUMN[rep.status] ?? 1) : 0].push(atom);
    }
    return c;
  }, [atoms]);

  const trashAtom = async (atom: Atom) => {
    if (atom.members.length === 0 && atom.topic) {
      const r = await invoke("topic:delete", { id: atom.topic.id });
      if (!r.ok) return toast(r.error ?? "删除失败");
    } else {
      for (const m of atom.members) {
        const r = await invoke("content:delete", { id: m.id });
        if (!r.ok) return toast(r.error ?? "删除失败");
      }
    }
    toast("已移入回收站(可恢复)");
    void load();
  };

  const openTrash = async () => {
    const r = await invoke("trash:list");
    if (!r.ok) return toast(r.error ?? "回收站加载失败");
    const d = ((r as Record<string, unknown>).data ?? r) as unknown as TrashData;
    setTrash({ topics: d.topics ?? [], contents: d.contents ?? [] });
    setMode({ kind: "trash" });
  };

  const collectMore = async () => {
    setRadarBusy("more");
    try {
      const r = await invoke("radar:more", { limit: 5, refresh: true });
      if (!r.ok) return toast(r.error ?? "继续收集失败");
      const d = ((r as Record<string, unknown>).data ?? {}) as { savedCount?: number; failedSources?: string[] };
      await load();
      if ((d.savedCount ?? 0) > 0) {
        toast(`新增 ${d.savedCount} 条中文高分选题`);
      } else {
        toast("这一批没有新的合格选题——可删除不喜欢的条目后再找，或在设置里开启更多情报源");
      }
    } finally {
      setRadarBusy(null);
    }
  };

  const rescore = async () => {
    setRadarBusy("rescore");
    try {
      const r = await invoke("radar:rescore");
      if (!r.ok) return toast(r.error ?? "重评失败");
      const d = ((r as Record<string, unknown>).data ?? {}) as { updatedCount?: number };
      await load();
      toast(`已把 ${d.updatedCount ?? 0} 条旧选题补成中文标题、评分和可写角度`);
    } finally {
      setRadarBusy(null);
    }
  };

  // ── 平台矩阵 ──
  if (mode.kind === "matrix") {
    const atom = atoms.find((a) => a.key === mode.atomKey);
    if (!atom) {
      setMode({ kind: "columns" });
      return null;
    }
    return <Matrix atom={atom} seats={seats} back={() => setMode({ kind: "columns" })} openEditor={props.openEditor} send={send} reload={load} />;
  }

  // ── 回收站 ──
  if (mode.kind === "trash") {
    const restore = async (channel: string, id: string) => {
      const r = await invoke(channel, { id });
      toast(r.ok ? "已恢复" : (r.error ?? "恢复失败"));
      if (r.ok) void openTrash().then(load);
    };
    return (
      <div>
        <div className="board-bar">
          <button onClick={() => setMode({ kind: "columns" })}>← 看板</button>
          <span className="serif board-title">回收站</span>
        </div>
        {trash.topics.length + trash.contents.length === 0 && <p className="muted pad">回收站是空的。</p>}
        {trash.topics.map((t) => (
          <div key={t.id} className="row">
            <span className="mono pri">灵感</span>
            <span className="row-title">{t.title}</span>
            <button onClick={() => void restore("topic:restore", t.id)}>恢复</button>
          </div>
        ))}
        {trash.contents.map((c) => (
          <div key={c.id} className="row">
            <span className="mono pri">{platformLabel(c.platform)}</span>
            <span className="row-title">{c.title}</span>
            <button onClick={() => void restore("content:restore", c.id)}>恢复</button>
          </div>
        ))}
      </div>
    );
  }

  // ── 列视图:左灵感面板(独立滚动、行式高密度) + 右管线四列(V5.6.2 重排) ──
  const ideaAtoms = [...cols[0]].sort((a, b) => (b.topic?.score ?? -1) - (a.topic?.score ?? -1));
  return (
    <div>
      <div className="board-bar">
        <span className="serif board-title">管线看板</span>
        <span className="muted">点灵感/卡片进平台矩阵 · 拖卡换列</span>
        <button disabled={radarBusy !== null} onClick={() => void collectMore()}>
          {radarBusy === "more" ? "侦察员继续搜…" : "再找 5 条"}
        </button>
        <button disabled={radarBusy !== null} onClick={() => void rescore()}>
          {radarBusy === "rescore" ? "选题总监重评中…" : "重评现有选题"}
        </button>
        <button onClick={() => void openTrash()}>回收站</button>
      </div>
      <div className="board-split">
        <div className="idea-pane">
          <div className="kcol-head mono">
            灵感库 <span className="muted">{ideaAtoms.length} · 3 天未选用自动清</span>
          </div>
          {ideaAtoms.length === 0 && <p className="muted">灵感库空——工作台「派侦查员搜灵感」,或顶栏「＋新想法」。</p>}
          {ideaAtoms.map((atom) => (
            <div key={atom.key} className="idea-row" onClick={() => setMode({ kind: "matrix", atomKey: atom.key })}>
              <div className="idea-title">
                {typeof atom.topic?.score === "number" && (
                  <span className={"topic-score" + (atom.topic.score >= 80 ? " topic-score-high" : "")}>{atom.topic.score}</span>
                )}
                {atom.topic?.title ?? atomRep(atom)?.title ?? "（无标题）"}
              </div>
              <div className="idea-sub mono muted">
                {[typeof atom.topic?.score === "number" ? "综合评分" : "待评分", sourceLabel(atom.topic?.source), ideaAge(atom.topic?.createdAt)].filter(Boolean).join(" · ")}
              </div>
              <button
                className="acard-del"
                title="移入回收站"
                onClick={(e) => {
                  e.stopPropagation();
                  void trashAtom(atom);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="kanban">
          {BOARD_COLUMNS.map((col, i) => i === 0 ? null : (
          <div
            key={col.key}
            className={"kcol" + (dragOver === col.key && DROP_TARGET_STATUS[col.key] ? " kcol-over" : "")}
            onDragOver={(e) => {
              if (!DROP_TARGET_STATUS[col.key]) return;
              e.preventDefault();
              setDragOver(col.key);
            }}
            onDragLeave={() => setDragOver((d) => (d === col.key ? null : d))}
            onDrop={async (e) => {
              setDragOver(null);
              const id = e.dataTransfer.getData("text/autocrew-content");
              if (!id || !DROP_TARGET_STATUS[col.key]) return;
              const r = await invoke("content:transition", { id, target_status: DROP_TARGET_STATUS[col.key] });
              if (!r.ok) return toast(r.error ?? "流转失败(状态机拒绝了这一步)");
              toast("已流转到「" + col.label + "」");
              void load();
            }}
          >
            <div className="kcol-head mono">
              {col.label} <span className="muted">{cols[i].length}</span>
            </div>
            {cols[i].map((atom) => {
              const rep = atomRep(atom);
              return (
                <div
                  key={atom.key}
                  className="acard"
                  draggable={Boolean(rep)}
                  onDragStart={(e) => {
                    if (rep) e.dataTransfer.setData("text/autocrew-content", rep.id);
                  }}
                  onClick={() => setMode({ kind: "matrix", atomKey: atom.key })}
                >
                  <div className="acard-head">
                    <span className="acard-title">{atom.topic?.title ?? rep?.title ?? "（无标题）"}</span>
                    <button
                      className="acard-del"
                      title="移入回收站"
                      onClick={(e) => {
                        e.stopPropagation();
                        void trashAtom(atom);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {atom.topic && atom.members.length === 0 && atom.topic.source && (
                    <div className="muted mono acard-sub">{sourceLabel(atom.topic.source)}</div>
                  )}
                  {atom.members.length > 0 && (
                    <div className="acard-chips">
                      {atom.members.map((m) => (
                        <button
                          key={m.id}
                          className={"chip" + (m.status === "published" ? " chip-pub" : "")}
                          onClick={(e) => {
                            e.stopPropagation();
                            props.openEditor(m.id);
                          }}
                        >
                          {platformLabel(m.platform)} {VARIANT_STATUS[m.status] ?? m.status}
                        </button>
                      ))}
                    </div>
                  )}
                  {atom.members.some((m) => m.lastError) && <div className="acard-err">⚠ 生成中断,点开可重试</div>}
                </div>
              );
            })}
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}

function Matrix(props: {
  atom: Atom;
  seats: string[];
  back: () => void;
  openEditor: (id: string) => void;
  send: (msg: string) => Promise<{ ok: boolean; error?: string; actionId?: string }>;
  reload: () => Promise<void>;
}) {
  const { atom, seats } = props;
  const [direction, setDirection] = useState("");
  const t = atom.topic;
  const title = t?.title ?? atomRep(atom)?.title ?? "（无标题）";
  const byPlatform = new Map(atom.members.map((m) => [m.platform, m]));
  const shown = PLATFORM_CATALOG.filter((c) => seats.includes(c.id) || byPlatform.has(c.id));
  const retentionLeft = (() => {
    if (!t || atom.members.length > 0) return null;
    const age = (Date.now() - new Date(t.createdAt).getTime()) / 86400000;
    return isFinite(age) ? Math.max(0, Math.ceil(3 - age)) : null;
  })();

  const dispatch = async (platform: string) => {
    let brief = `用选题《${title}》写一篇${platformLabel(platform)}原生版本`;
    const ctx: string[] = [];
    if (t) {
      ctx.push(`灵感库编号：${t.id}（开写时带上 topic_id,血缘别断）`);
      if (t.reason) ctx.push("入库理由：" + t.reason);
      if (t.description && t.description !== title) ctx.push("背景：" + t.description);
      if (typeof t.score === "number") ctx.push(`选题评分：${t.score}/100`);
      if (t.angles?.length) ctx.push(`可写角度：${t.angles.join("；")}`);
      if (t.link) ctx.push(`参考链接：${t.link}（先用 read_url 读原文再写，不要凭标题脑补）`);
    }
    if (direction.trim()) ctx.push(`创作者想写的方向：${direction.trim()}（这是最高优先级的角度指引）`);
    if (ctx.length) brief += "。选题上下文——" + ctx.join("；");
    const receipt = await props.send(brief);
    toast(receipt.ok ? `已受理${receipt.actionId ? ` · ${receipt.actionId}` : ""}` : (receipt.error ?? "派活失败"));
  };

  const renameTopic = async () => {
    if (!t) return;
    const v = await openDialog({
      title: "改选题标题",
      body: "改的是灵感库这条选题的标题(看板卡片显示用);不改已写稿件的正文标题。",
      fields: [{ key: "title", label: "标题", initial: t.title, required: true, multiline: true }],
      confirmLabel: "保存",
    });
    if (!v) return;
    const next = v.title.trim();
    if (!next || next === t.title) return;
    const r = await invoke("topic:update", { id: t.id, title: next });
    if (!r.ok) return toast((r as { error?: string }).error ?? "改名失败");
    toast("已更新选题标题");
    void props.reload();
  };

  return (
    <div>
      <div className="board-bar">
        <button onClick={props.back}>← 看板</button>
        <span className="serif board-title">{title}</span>
        {t && <button onClick={() => void renameTopic()}>改标题</button>}
      </div>
      {t && (
        <div className="matrix-detail">
          {typeof t.score === "number" && (
            <div className="topic-score-panel">
              <strong className="serif">综合评分 {t.score}/100</strong>
              {t.scoreBreakdown && (
                <div className="topic-score-grid mono">
                  <span>受众契合 {t.scoreBreakdown.audienceFit}/30</span>
                  <span>材料支撑 {t.scoreBreakdown.materialRichness}/25</span>
                  <span>差异化 {t.scoreBreakdown.novelty}/25</span>
                  <span>时效 {t.scoreBreakdown.timeliness}/20</span>
                </div>
              )}
            </div>
          )}
          {t.description && <p className="muted">{t.description}</p>}
          {t.reason && <p>为什么值得写：{t.reason}</p>}
          {t.originalTitle && <p className="muted mono">原始标题：{t.originalTitle}</p>}
          {t.angles && t.angles.length > 0 && (
            <div className="topic-angles">
              <strong>可以怎么写</strong>
              <ol>{t.angles.map((angle, i) => <li key={i}>{angle}</li>)}</ol>
            </div>
          )}
          <p className="muted mono">
            {t.source && "来源 " + sourceLabel(t.source)}
            {retentionLeft !== null && (retentionLeft > 0 ? ` · 未选用保留 3 天,还剩 ${retentionLeft} 天` : " · 已到期,即将自动移入回收站")}
          </p>
          {t.link && (
            <p>
              <a href={t.link} target="_blank" rel="noreferrer">查看原始内容 ↗</a>{" "}
              <button onClick={() => void props.send(`拆解一下这篇参考：${t.link}（选题《${t.title}》,灵感库编号 ${t.id}）`).then((receipt) => {
                toast(receipt.ok ? `已受理${receipt.actionId ? ` · ${receipt.actionId}` : ""}` : (receipt.error ?? "派活失败"));
              })}>
                派总编辑读原文拆解
              </button>
            </p>
          )}
          <input
            className="matrix-direction"
            placeholder="你想写的方向/角度(可选,派活时带给写手)"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          />
        </div>
      )}
      <div className="mono muted" style={{ margin: "8px 0 6px" }}>平台矩阵 · 有稿点开,无稿生成</div>
      <div className="matrix-grid">
        {shown.map((c) => {
          const m = byPlatform.get(c.id);
          return (
            <div key={c.id} className={"mcell" + (m ? " mcell-filled" : "")}>
              <div className="mono">{c.label}</div>
              {m ? (
                <button className="chip" onClick={() => props.openEditor(m.id)}>
                  {VARIANT_STATUS[m.status] ?? m.status} →
                </button>
              ) : c.gen ? (
                <button onClick={() => void dispatch(c.id)}>生成</button>
              ) : (
                <span className="muted mono">席位未开通</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
