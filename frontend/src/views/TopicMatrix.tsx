/**
 * 主题页（点选题 / 管理平台进来）：平台矩阵 + 主题材料与写作角度。
 * 从旧看板里原样搬出来，看板改版不动它；路由 #/topic/<key> 自己读主题和稿件。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../transport";
import { toast, openDialog } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import { ResearchPanel } from "./ResearchPanel";
import { ANGLE_SECTION_ID, AngleGuide } from "./AngleCards";
import { needsAnglePick, NO_ANGLE_GATE, type AngleGate } from "./angle-choice";
import { buildDispatchBrief } from "./dispatch-brief";
import { fallbackTitle } from "./engine-lib";
import { HostBadges } from "./HostBadges";
import { boardPlatforms } from "./board-model";
import "./topic-workspace.css";
import {
  VARIANT_STATUS, PLATFORM_CATALOG,
  platformLabel, sourceLabel, groupAtoms, atomRep, type Atom, type Content, type Topic,
} from "../lib";

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


/** 主题页的读取：主题 + 稿件 + 账号平台；深链首次加载期间保留，不存在就明说 */
export function TopicPage(props: { atomKey: string; back: () => void; openEditor: (id: string) => void }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [contents, setContents] = useState<Content[]>([]);
  const [seats, setSeats] = useState<string[]>(["wechat_mp"]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const send = useChatSend();
  const load = useCallback(async () => {
    const [tr, cr, ob] = await Promise.all([invoke("topics:list"), invoke("content:list"), invoke("onboarding:status")]);
    setLoaded(true);
    setLoadError(!tr.ok || !cr.ok ? tr.error ?? cr.error ?? "主题加载失败，请重试" : null);
    if (tr.ok) setTopics(((tr as Record<string, unknown>).topics ?? (tr as { data?: { topics?: Topic[] } }).data?.topics ?? []) as Topic[]);
    if (cr.ok) setContents(((cr as Record<string, unknown>).contents ?? []) as Content[]);
    const platforms = (ob as { platforms?: string[] }).platforms ?? (ob as { data?: { platforms?: string[] } }).data?.platforms;
    if (Array.isArray(platforms) && platforms.length) setSeats(platforms);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const atom = groupAtoms(topics, contents).find((a) => a.key === props.atomKey);
  if (!loaded || loadError || !atom) return <div className="topic-load-state">
    <button onClick={props.back}>← 看板</button>
    <p role={loadError ? "alert" : undefined}>{!loaded ? "正在加载主题…" : loadError ?? "这个主题不存在，或已移入回收站。"}</p>
    {loaded && <button onClick={() => void load()}>重新加载</button>}
  </div>;
  return <Matrix key={atom.key} atom={atom} seats={seats} back={props.back} openEditor={props.openEditor} send={send} reload={load} />;
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
        <button className="topic-back" onClick={props.back}>← 看板</button>
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
