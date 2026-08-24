/**
 * 管线看板(B 期,qingmo 设计细节原生重实现):
 * 列=灵感库→在写→待审→待发布→已发布;卡=内容原子(idea+平台变体)。
 * 拖拽换列=content:transition;卡可入回收站(软删)+回收站恢复;
 * 点原子→平台矩阵(灵感详情/方向补充/有稿点开/无稿生成)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { toast, openDialog } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import { ResearchPanel } from "./ResearchPanel";
import { ANGLE_SECTION_ID, AngleGuide } from "./AngleCards";
import { needsAnglePick, NO_ANGLE_GATE, type AngleGate } from "./angle-choice";
import { buildDispatchBrief } from "./dispatch-brief";
import {
  BOARD_COLUMNS, DROP_TARGET_STATUS, STATUS_COLUMN, VARIANT_STATUS, PLATFORM_CATALOG,
  platformLabel, sourceLabel, groupAtoms, atomRep, type Atom, type Content, type Topic,
} from "../lib";

/**
 * 灵感行副标签:来源 + 天龄(3 天未选用会自动清,天龄是紧迫感)。
 * 口径必须与过期清理一致(topic-expiry 用 renewedAt ?? createdAt):深调研续过期的灵感
 * 已经重新计时,还按 createdAt 显示就是假紧迫感——卡上写"5 天前"其实明天才到期。
 */
function ideaAge(anchor?: string): string {
  if (!anchor) return "";
  const days = Math.floor((Date.now() - new Date(anchor).getTime()) / 86400000);
  if (!isFinite(days) || days < 0) return "";
  return days === 0 ? "今天" : `${days} 天前`;
}

/**
 * AI 审稿徽章(审稿 spec §2.5:稿卡读 review.status)。
 * 无 review 字段 = 不显示——旧稿不该被扣一顶「未审稿」的帽子;
 * skipped 才是「这次本该审、没审成」,那顶帽子必须戴上。
 */
function reviewBadge(review: Content["review"]): string | null {
  if (!review) return null;
  if (review.status === "passed") return "✓已审稿";
  if (review.status === "revised") return `✓审稿修订${review.fixed}`;
  if (review.status === "failed") {
    return `⚠残留${review.issues.filter((i) => i.severity === "blocker").length}项`;
  }
  if (review.status === "stale") return "审稿已过期";
  return "未审稿";
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
                {[typeof atom.topic?.score === "number" ? "综合评分" : "待评分", sourceLabel(atom.topic?.source), ideaAge(atom.topic?.renewedAt ?? atom.topic?.createdAt)].filter(Boolean).join(" · ")}
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
              // 看板是人工工具:force 直落目标状态,允许自由拖(前进/跳阶/回退),不受流水线单步状态机约束。
              // 拖到「已发布」只标记状态(+publishedAt),不触发真实推送——推送仍走「推 →」。
              const r = await invoke("content:transition", { id, target_status: DROP_TARGET_STATUS[col.key], force: true });
              if (!r.ok) return toast(r.error ?? "流转失败");
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
                      {atom.members.map((m) => {
                        const badge = reviewBadge(m.review);
                        return (
                          <button
                            key={m.id}
                            className={"chip" + (m.status === "published" ? " chip-pub" : "")}
                            title={m.review?.issues.map((i) => i.rule).join("、") || undefined}
                            onClick={(e) => {
                              e.stopPropagation();
                              props.openEditor(m.id);
                            }}
                          >
                            {platformLabel(m.platform)} {VARIANT_STATUS[m.status] ?? m.status}
                            {badge && <span className="muted"> {badge}</span>}
                          </button>
                        );
                      })}
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
  /** 角度闸口的事实由 ResearchPanel 上报(它才有简报);这里只用来决定拦不拦 */
  const [gate, setGate] = useState<AngleGate>(NO_ANGLE_GATE);
  /** 非 null = 这个平台的「生成」被角度闸口拦下了,正等创始人四选其一(§1.6) */
  const [asking, setAsking] = useState<string | null>(null);
  const directionRef = useRef<HTMLInputElement | null>(null);
  const t = atom.topic;
  const title = t?.title ?? atomRep(atom)?.title ?? "（无标题）";
  const byPlatform = new Map(atom.members.map((m) => [m.platform, m]));
  const shown = PLATFORM_CATALOG.filter((c) => seats.includes(c.id) || byPlatform.has(c.id));
  const retentionLeft = (() => {
    if (!t || atom.members.length > 0) return null;
    const age = (Date.now() - new Date(t.createdAt).getTime()) / 86400000;
    return isFinite(age) ? Math.max(0, Math.ceil(3 - age)) : null;
  })();

  const onAngleGate = useCallback((g: AngleGate) => {
    // 值没变就不换对象——否则「上报 → 重渲 → 再上报」会转起来
    setGate((prev) => (prev.cards === g.cards && prev.state === g.state ? prev : g));
  }, []);

  const scrollToAngles = () => {
    document.getElementById(ANGLE_SECTION_ID)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const focusDirection = () => {
    directionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    directionRef.current?.focus();
  };

  /**
   * 派活。有角度候选却还没定角度时**先不派**(§1.6):拦下来给三个出口,
   * 「直接写」是显式按钮——点了才走,并把这句话原样带进 brief 让总编辑落成 skip_reason。
   */
  const dispatch = async (platform: string, skipAngle = false) => {
    if (!skipAngle && needsAnglePick(gate, direction)) {
      setAsking(platform);
      scrollToAngles();
      return;
    }
    setAsking(null);
    const receipt = await props.send(buildDispatchBrief({ title, topic: t ?? null, platform, direction, skipAngle }));
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
            ref={directionRef}
            className="matrix-direction"
            placeholder="你想写的方向/角度(可选,派活时带给写手——手写角度优先级最高)"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          />
          {/* 深调研:四视角简报 + 写前角度卡,写这条选题时自动注入(deep-research spec §8 / 角度卡 spec §1.4) */}
          <ResearchPanel
            topic={t}
            onAngleGate={onAngleGate}
            onSelectionChange={() => void props.reload()}
            focusAngles={asking !== null}
          />
        </div>
      )}
      {asking && (
        <AngleGuide
          platform={asking}
          cards={gate.cards}
          ready={!needsAnglePick(gate, direction)}
          onGoPick={scrollToAngles}
          onWriteOwn={focusDirection}
          onSkip={() => void dispatch(asking, true)}
          onGo={() => void dispatch(asking)}
          onCancel={() => setAsking(null)}
        />
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
