/**
 * 管线看板(B 期,qingmo 设计细节原生重实现):
 * 流程列按主题归组，每个平台保留当前稿及其他稿件。
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
import { phraseBreak } from "./phrase-break";
import { fallbackTitle } from "./engine-lib";
import { HostBadges } from "./HostBadges";
import { boardColumns, boardMoveTarget, boardPlatforms, type BoardPlatform } from "./board-model";
import "./topic-workspace.css";
import {
  BOARD_COLUMNS, VARIANT_STATUS, PLATFORM_CATALOG,
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
  if (review.status === "passed") {
    if (review.source?.kind === "host_self_review") return "已自审";
    if (review.source?.kind === "host_other_principal_review") return "已由其他宿主审阅";
    return "✓已审稿";
  }
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

export function Board(props: {
  atomKey?: string;
  openTopic: (key: string) => void;
  backToBoard: () => void;
  openEditor: (id: string) => void;
}) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [contents, setContents] = useState<Content[]>([]);
  const [seats, setSeats] = useState<string[]>(["wechat_mp"]);
  const [mode, setMode] = useState<"columns" | "trash">("columns");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [trash, setTrash] = useState<TrashData>({ topics: [], contents: [] });
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<{ id: string; message: string } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const movingRef = useRef(false);
  const dragRef = useRef<string | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const scrollSpeed = useRef(0);
  const loadRevision = useRef(0);
  const loadingRef = useRef(false);
  const [radarBusy, setRadarBusy] = useState<"more" | "rescore" | null>(null);
  const send = useChatSend();

  const load = async () => {
    const revision = ++loadRevision.current;
    loadingRef.current = true;
    const [tr, cr, ob] = await Promise.all([invoke("topics:list"), invoke("content:list"), invoke("onboarding:status")]);
    if (revision !== loadRevision.current) return;
    loadingRef.current = false;
    setLoaded(true);
    setLoadError(!tr.ok || !cr.ok ? tr.error ?? cr.error ?? "主题加载失败，请重试" : null);
    if (tr.ok) setTopics(((tr as Record<string, unknown>).topics ?? (tr as { data?: { topics?: Topic[] } }).data?.topics ?? []) as Topic[]);
    if (cr.ok) setContents(((cr as Record<string, unknown>).contents ?? []) as Content[]);
    const platforms = (ob as { platforms?: string[] }).platforms ?? (ob as { data?: { platforms?: string[] } }).data?.platforms;
    if (Array.isArray(platforms) && platforms.length) setSeats(platforms);
  };
  useEffect(() => {
    void load();
    return () => { loadRevision.current++; };
  }, []);
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 180);
    };
    const off = subscribeEvents((event) => {
      if (event.kind === "reconnect") return refresh();
      if (event.kind !== "engine") return;
      const kind = String(event.data.kind ?? "");
      if (!event.data.contentId && !["radar", "trash", "transition", "run_done", "run_failed"].includes(kind)) return;
      refresh();
    });
    const visible = () => { if (!document.hidden) refresh(); };
    const poll = window.setInterval(() => {
      if (!document.hidden && !loadingRef.current) void load();
    }, 3000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const atoms = useMemo(() => groupAtoms(topics, contents), [topics, contents]);
  const cols = useMemo(() => boardColumns(atoms), [atoms]);

  const stopAutoScroll = () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    scrollSpeed.current = 0;
  };
  useEffect(() => () => stopAutoScroll(), []);

  const endCardDrag = () => {
    dragRef.current = null;
    setDraggingId(null);
    setDragOver(null);
    stopAutoScroll();
  };

  const moveContent = async (content: Content, columnKey: string) => {
    const target = boardMoveTarget(content, columnKey);
    if (!target || movingRef.current) return;
    movingRef.current = true;
    setMovingId(content.id);
    setMoveError(null);
    try {
      const r = await invoke("content:transition", {
        id: content.id, from_status: content.status, target_status: target, force: true,
      });
      if (!r.ok) {
        const message = r.error ?? "移动失败，请重试";
        setMoveError({ id: content.id, message });
        toast(message);
      } else {
        const saved = r.content as Content | undefined;
        if (saved?.id === content.id) setContents((current) => current.map((c) => c.id === saved.id ? { ...c, ...saved } : c));
        const label = BOARD_COLUMNS.find((column) => column.key === columnKey)?.label;
        toast(target === "published" ? `${platformLabel(content.platform)}已标记为已发布（未向平台推送）` : `${platformLabel(content.platform)}已移到「${label}」；主题按各平台进度归列`);
      }
      // 以服务器为准，失败也刷新，避免旧页面覆盖其他编辑的新状态。
      await load();
    } finally {
      movingRef.current = false;
      setMovingId(null);
    }
  };

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
    setMode("trash");
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

  // 主题位置跟随路由，首次加载期间保留深链。
  if (props.atomKey) {
    const atom = atoms.find((a) => a.key === props.atomKey);
    if (!loaded || loadError || !atom) return <div className="topic-load-state">
      <button onClick={props.backToBoard}>← 管线看板</button>
      <p role={loadError ? "alert" : undefined}>{!loaded ? "正在加载主题…" : loadError ?? "这个主题不存在，或已移入回收站。"}</p>
      {loaded && <button onClick={() => void load()}>重新加载</button>}
    </div>;
    return <Matrix key={atom.key} atom={atom} seats={seats} back={props.backToBoard} openEditor={props.openEditor} send={send} reload={load} />;
  }

  // ── 回收站 ──
  if (mode === "trash") {
    const restore = async (channel: string, id: string) => {
      const r = await invoke(channel, { id });
      toast(r.ok ? "已恢复" : (r.error ?? "恢复失败"));
      if (r.ok) void openTrash().then(load);
    };
    return (
      <div>
        <div className="board-bar">
          <button onClick={() => setMode("columns")}>← 看板</button>
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

  // 灵感保留在首列；一个主题只出现一次，拖动平台行只更新该平台当前稿。
  const ideaAtoms = atoms.filter((atom) => atom.members.length === 0)
    .sort((a, b) => (b.topic?.score ?? -1) - (a.topic?.score ?? -1));
  return (
    <div className="board-workspace">
      <div className="board-toolbar">
        <div className="board-heading">
          <h1 className="board-title">管线看板 <span>{atoms.filter((atom) => atom.members.length > 0).length} 个主题 · {contents.length} 篇稿件</span></h1>
          <p className="board-help">按主题推进，各平台分别创作。拖动平台行换阶段，或点状态选择。</p>
        </div>
        <div className="board-tools">
          <button disabled={radarBusy !== null} onClick={() => void collectMore()}>
            {radarBusy === "more" ? "继续搜集中…" : "再找 5 条"}
          </button>
          <button disabled={radarBusy !== null} onClick={() => void rescore()}>
            {radarBusy === "rescore" ? "重评中…" : "重评选题"}
          </button>
          <button onClick={() => void openTrash()}>回收站</button>
        </div>
      </div>
      {loadError && <p className="acard-err" role="alert">{loadError} <button onClick={() => void load()}>重试</button></p>}
      <div className="board-scroll-tools">
        <span>横向滚动查看全部阶段</span>
        <div>
          <button aria-label="向左查看流程" onClick={() => boardRef.current?.scrollBy({ left: -332 })}>←</button>
          <button aria-label="向右查看流程" onClick={() => boardRef.current?.scrollBy({ left: 332 })}>→</button>
        </div>
      </div>
      <div
        className="kanban"
        ref={boardRef}
        role="region"
        aria-label="主题流程看板，可横向滚动"
        tabIndex={0}
        onDragOver={(e) => {
          if (!dragRef.current || !boardRef.current) return;
          const bounds = boardRef.current.getBoundingClientRect();
          scrollSpeed.current = e.clientX > bounds.right - 56 ? 12 : e.clientX < bounds.left + 56 ? -12 : 0;
          if (!scrollSpeed.current) return stopAutoScroll();
          if (scrollFrame.current !== null) return;
          const step = () => {
            boardRef.current?.scrollBy({ left: scrollSpeed.current });
            scrollFrame.current = requestAnimationFrame(step);
          };
          scrollFrame.current = requestAnimationFrame(step);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) stopAutoScroll();
        }}
        onDrop={endCardDrag}
      >
        <section className="kcol kcol-idea" data-column="idea" aria-label="灵感库">
          <div className="kcol-head">
            <h2><span className="kcol-dot" />灵感库</h2>
            <span className="board-count">{ideaAtoms.length}</span>
          </div>
          <p className="kcol-note">3 天未选用自动清理</p>
          <div className="kcol-body">
            {ideaAtoms.length === 0 && (
              <div className="kcol-empty kcol-idea-empty">
                <span>还没有灵感</span>
                <small>点击「再找 5 条」或顶栏「＋新想法」</small>
              </div>
            )}
            {ideaAtoms.map((atom) => (
              <div key={atom.key} className="idea-row">
                <button className="idea-title" title={atom.topic?.title} onClick={() => props.openTopic(atom.key)}>
                  {typeof atom.topic?.score === "number" && <span className={"topic-score" + (atom.topic.score >= 80 ? " topic-score-high" : "")}>{atom.topic.score}</span>}
                  {phraseBreak(atom.topic?.title ?? "（无标题）")}
                </button>
                <div className="idea-sub muted">{[sourceLabel(atom.topic?.source), ideaAge(atom.topic?.renewedAt ?? atom.topic?.createdAt)].filter(Boolean).join(" · ")}</div>
                <button className="acard-del" title="将灵感移入回收站" aria-label="将灵感移入回收站" onClick={() => void trashAtom(atom)}>×</button>
              </div>
            ))}
          </div>
        </section>
        {BOARD_COLUMNS.map((col, i) => i === 0 ? null : (
          <section
            key={col.key}
            data-column={col.key}
            aria-label={col.label}
            className={"kcol kcol-" + col.key + (dragOver === col.key ? " kcol-over" : "")}
            onDragOver={(e) => {
              if (movingRef.current || !dragRef.current) return;
              const content = contents.find((c) => c.id === dragRef.current);
              if (!content || !boardMoveTarget(content, col.key)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOver(col.key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver((d) => d === col.key ? null : d);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const id = e.dataTransfer.getData("text/autocrew-content");
              const content = id === dragRef.current ? contents.find((c) => c.id === id) : undefined;
              endCardDrag();
              if (content) void moveContent({ ...content, status: e.dataTransfer.getData("text/autocrew-status") || content.status }, col.key);
            }}
          >
            <div className="kcol-head">
              <h2><span className="kcol-dot" />{col.label}</h2>
              <span className="board-count">{cols[i].length}</span>
            </div>
            <div className="kcol-body">
              {cols[i].length === 0 && <div className="kcol-empty"><span>{draggingId ? "松开放到这里" : "暂无主题"}</span><small>拖入平台稿件，移到{col.label}</small></div>}
              {cols[i].map((card) => {
                const platformRow = (entry: BoardPlatform) => {
                  const content = entry.current;
                  return <div
                    key={entry.platform}
                    data-content-id={content.id}
                    className={"topic-platform-row" + (draggingId === content.id ? " acard-dragging" : "")}
                    draggable={movingId === null}
                    aria-busy={movingId === content.id}
                    onDragStart={(e) => {
                      if (movingRef.current) return e.preventDefault();
                      dragRef.current = content.id;
                      setDraggingId(content.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/autocrew-content", content.id);
                      e.dataTransfer.setData("text/autocrew-status", content.status);
                      e.dataTransfer.setData("text/plain", content.title);
                    }}
                    onDragEnd={endCardDrag}
                  >
                    <span className="topic-drag-grip" aria-hidden="true" title="拖动这个平台换阶段">⠿</span>
                    <button className="topic-platform-open" title={content.title} onClick={() => props.openEditor(content.id)}>
                      <strong>{platformLabel(entry.platform)}{entry.contents.length > 1 && <small> +{entry.contents.length - 1} 篇</small>}</strong>
                      <span>{content.title || "（无标题）"}</span>
                    </button>
                    <select
                      className={content.status === "needs_evidence" ? "chip-blocked" : ""}
                      aria-label={`移动${platformLabel(entry.platform)}「${content.title}」到`}
                      value=""
                      disabled={movingId !== null}
                      onChange={(e) => void moveContent(content, e.target.value)}
                    >
                      <option value="">{movingId === content.id ? "移动中…" : VARIANT_STATUS[content.status] ?? "草稿"}</option>
                      {BOARD_COLUMNS.filter((column) => column.key !== "idea").map((column) => <option key={column.key} value={column.key} disabled={!boardMoveTarget(content, column.key)}>{column.key === "published" ? "标记已发布" : `移到${column.label}`}</option>)}
                    </select>
                    {moveError?.id === content.id && <div className="acard-err topic-platform-error" role="alert">{moveError?.message}</div>}
                  </div>;
                };
                return <article key={card.atomKey} className="acard topic-card" data-topic-key={card.atomKey}>
                  <button className="acard-title" title={card.title} onClick={() => props.openTopic(card.atomKey)}>{phraseBreak(card.title)}</button>
                  <div className="topic-platforms">{card.platforms.slice(0, 3).map(platformRow)}</div>
                  {card.platforms.length > 3 && <details className="topic-more-platforms"><summary>另外 {card.platforms.length - 3} 个平台</summary>{card.platforms.slice(3).map(platformRow)}</details>}
                  <div className="topic-card-footer"><span>{card.platforms.length} 个平台 · {card.members.length} 篇稿件</span><button onClick={() => props.openTopic(card.atomKey)}>管理平台</button></div>
                </article>;
              })}
            </div>
          </section>
        ))}
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
  const [addedPlatforms, setAddedPlatforms] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState(() => boardPlatforms(atom).find((entry) => entry.current.body?.trim())?.current.id ?? "");
  const [researchOpen, setResearchOpen] = useState(atom.members.length === 0);
  const [dispatching, setDispatching] = useState<string | null>(null);
  /** 角度闸口的事实由 ResearchPanel 上报(它才有简报);这里只用来决定拦不拦 */
  const [gate, setGate] = useState<AngleGate>(NO_ANGLE_GATE);
  /** 非 null = 这个平台的「生成」被角度闸口拦下了,正等创始人四选其一(§1.6) */
  const [asking, setAsking] = useState<string | null>(null);
  const directionRef = useRef<HTMLInputElement | null>(null);
  const t = atom.topic;
  const title = t?.title ?? atomRep(atom)?.title ?? "（无标题）";
  const platformGroups = boardPlatforms(atom);
  const byPlatform = new Map(platformGroups.map((entry) => [entry.platform, entry]));
  const hasTheme = Boolean(t || atom.members.some((member) => member.topicId));
  const suggestedPlatforms = platformGroups.length === 0 ? seats.slice(0, 3) : [];
  const shown = [
    ...PLATFORM_CATALOG.filter((c) => (hasTheme && (suggestedPlatforms.includes(c.id) || addedPlatforms.includes(c.id))) || byPlatform.has(c.id)),
    ...platformGroups.filter((entry) => !PLATFORM_CATALOG.some((c) => c.id === entry.platform)).map((entry) => ({ id: entry.platform, label: platformLabel(entry.platform), gen: false })),
  ];
  const available = PLATFORM_CATALOG.filter((c) => c.gen && !shown.some((shown) => shown.id === c.id));
  const source = atom.members.find((m) => m.id === sourceId);
  const topicId = t?.id ?? atom.members.find((m) => m.topicId)?.topicId;
  const retentionLeft = (() => {
    if (!t || atom.members.length > 0) return null;
    const age = (Date.now() - new Date(t.renewedAt ?? t.createdAt).getTime()) / 86400000;
    return isFinite(age) ? Math.max(0, Math.ceil(3 - age)) : null;
  })();

  const onAngleGate = useCallback((g: AngleGate) => {
    // 值没变就不换对象——否则「上报 → 重渲 → 再上报」会转起来
    setGate((prev) => (prev.cards === g.cards && prev.state === g.state ? prev : g));
  }, []);

  const scrollToAngles = () => {
    setResearchOpen(true);
    requestAnimationFrame(() => document.getElementById(ANGLE_SECTION_ID)?.scrollIntoView({ behavior: "smooth", block: "center" }));
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
    if (dispatching) return;
    if (!skipAngle && needsAnglePick(gate, direction)) {
      setAsking(platform);
      scrollToAngles();
      return;
    }
    setAsking(null);
    setDispatching(platform);
    try {
      const receipt = await props.send(buildDispatchBrief({ title, topic: t ?? null, topicId, source, platform, direction, skipAngle }));
      toast(receipt.ok ? "已交给总编辑，请查看对话反馈" : (receipt.error ?? "派活失败"));
    } finally {
      setDispatching(null);
    }
  };

  const removeDraft = async (content: Content) => {
    const confirmed = await openDialog({ title: "将这篇稿件移入回收站？", body: `《${content.title}》可以在回收站恢复。其他平台和稿件不受影响。`, confirmLabel: "移入回收站", fields: [] });
    if (!confirmed) return;
    const result = await invoke("content:delete", { id: content.id });
    if (!result.ok) return toast(result.error ?? "移入回收站失败");
    toast("已移入回收站，可恢复");
    await props.reload();
    if (atom.members.length === 1 && !atom.topic) props.back();
  };

  const renameTopic = async () => {
    if (!t) return;
    const v = await openDialog({
      title: "改选题标题",
      body: "改的是这组选题的标题；不改各篇稿件的标题和正文。",
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
    <div className="topic-workspace">
      <div className="topic-page-heading">
        <button className="topic-back" onClick={props.back}>← 管线看板</button>
        <div className="topic-heading-line"><h1>{title}</h1>{t && <button onClick={() => void renameTopic()}>编辑主题</button>}</div>
        <p>{platformGroups.length} 个平台 · {atom.members.length} 篇稿件<span>{hasTheme ? "围绕同一个主题，为每个平台写适合它的内容。" : "这是一篇独立稿，尚未关联主题。"}</span></p>
      </div>
      <div className="topic-section-heading">
        <h2>平台内容</h2>
        {hasTheme && available.length > 0 && <select aria-label="添加平台" value="" onChange={(e) => setAddedPlatforms((current) => [...current, e.target.value])}>
          <option value="">＋ 添加平台</option>{available.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>}
      </div>
      {hasTheme && <div className="topic-dispatch-settings">
        {atom.members.length > 0 && <label>参考稿<select aria-label="参考稿" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">从主题材料重新写</option>
          {platformGroups.flatMap((entry) => entry.contents).map((m) => <option key={m.id} value={m.id}>{platformLabel(m.platform)} · {m.title || "无标题"}</option>)}
        </select></label>}
        <label className="topic-direction-label">创作方向<input ref={directionRef} placeholder="补充这次想讲的角度（可选）" value={direction} onChange={(e) => setDirection(e.target.value)} /></label>
      </div>}
      <div className="topic-platform-grid">
        {shown.map((platform) => {
          const group = byPlatform.get(platform.id);
          const current = group?.current;
          const badge = current ? reviewBadge(current.review) : null;
          return <section key={platform.id} data-platform={platform.id} className={"topic-platform-card" + (!current ? " topic-platform-empty" : "")}>
            <header><h3>{platform.label}</h3>{current && <><span className={"acard-status" + (current.status === "needs_evidence" ? " chip-blocked" : "")}>{VARIANT_STATUS[current.status] ?? current.status}</span><details className="topic-draft-menu"><summary aria-label={`${platform.label}稿件操作`}>⋯</summary><button onClick={() => void removeDraft(current)}>移入回收站</button></details></>}</header>
            {current ? <>
              <button className="topic-draft-title" onClick={() => props.openEditor(current.id)}>{current.title || "（无标题）"}</button>
              <div className="topic-draft-detail">当前稿 · 最近修改 {new Date(current.updatedAt).toLocaleDateString("zh-CN")}</div>
              <div className="acard-details">{badge && <span>{badge}</span>}<HostBadges content={current} inline />{current.usedFallback && <span title={fallbackTitle(current.usedFallback)}>备用顶上</span>}</div>
              {(current.blockedReason || current.lastError) && <p className="acard-err">{current.blockedReason || "生成中断，打开稿件查看"}</p>}
              <button className="topic-open-draft" onClick={() => props.openEditor(current.id)}>打开{platform.label}稿</button>
              {group.contents.length > 1 && <details className="topic-other-drafts"><summary>其他稿件（{group.contents.length - 1}）</summary>{group.contents.slice(1).map((m) => <div className="topic-other-draft" key={m.id}><button onClick={() => props.openEditor(m.id)}><span>{m.title || "（无标题）"}</span><small>{VARIANT_STATUS[m.status] ?? m.status}</small></button><button className="topic-remove-draft" aria-label={`将「${m.title}」移入回收站`} onClick={() => void removeDraft(m)}>×</button></div>)}</details>}
            </> : <>
              <p>{source ? `参考${platformLabel(source.platform)}稿，改写适合${platform.label}的内容。` : "沿用主题材料和创作方向，开始这个平台的内容。"}</p>
              {platform.gen ? <button className="topic-create-draft" disabled={dispatching !== null} onClick={() => void dispatch(platform.id)}>{dispatching === platform.id ? "正在安排…" : `写${platform.label}稿`}</button> : <span className="muted">暂不支持自动创作</span>}
            </>}
          </section>;
        })}
      </div>
      {asking && <AngleGuide platform={asking} cards={gate.cards} ready={!needsAnglePick(gate, direction)} onGoPick={scrollToAngles} onWriteOwn={focusDirection} onSkip={() => void dispatch(asking, true)} onGo={() => void dispatch(asking)} onCancel={() => setAsking(null)} />}
      {t && (
        <details className="topic-research" open={researchOpen} onToggle={(event) => setResearchOpen(event.currentTarget.open)}><summary>主题材料与写作角度</summary><div className="matrix-detail">
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
          {/* 深调研:四视角简报 + 写前角度卡,写这条选题时自动注入(deep-research spec §8 / 角度卡 spec §1.4) */}
          <ResearchPanel
            topic={t}
            onAngleGate={onAngleGate}
            onSelectionChange={() => void props.reload()}
            focusAngles={asking !== null}
          />
        </div></details>
      )}

    </div>
  );
}
