/**
 * Dashboard(四问 IA,与 vanilla V5.5a 同构):今天该做什么/团队在干什么/内容资产/数据与成长。
 * 数据同源 dashboard:summary 单通道;行动跳转 A 期先回 vanilla(看板/工作台未迁移)。
 */
import { useEffect, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { useChatSend } from "../chat/ChatDock";
import type { Route } from "../App";

interface Summary {
  calibration: {
    styleCalibrated: boolean;
    industry: string;
    activeRuleCount: number;
    voiceCoreCount: number;
    recentRules: Array<{ rule: string }>;
    persona: { summary: string; calibrated: boolean };
  };
  reviewQueue: Array<{ id: string; title: string; platform: string | null; ageDays: number; priority: string }>;
  backfillTodos: Array<{ id: string; title: string; daysSince: number; level: string }>;
  pipeline: { idea: number; writing: number; review: number; ready: number; published: number };
  inspirations: Array<{ id: string; title: string; reason: string | null; link: string | null }>;
  isFirstRun: boolean;
}

const PRI_LABEL: Record<string, string> = { overdue: "过期", window: "该发了", fresh: "新完成" };

function Zone(props: { q: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="zone">
      <div className="zone-head">
        <h3 className="zone-q serif">{props.q}</h3>
        {props.hint && <span className="muted zone-hint">{props.hint}</span>}
      </div>
      <div className="zone-grid">{props.children}</div>
    </section>
  );
}

function Card(props: { title: string; kicker?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{props.title}</span>
        {props.kicker && <span className="mono muted">{props.kicker}</span>}
      </div>
      {props.children}
    </div>
  );
}

export function Dashboard({ nav }: { nav: (r: Route) => void }) {
  const [d, setD] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [runLines, setRunLines] = useState<string[]>([]);
  const send = useChatSend();

  const load = () => {
    invoke("dashboard:summary").then((r) => {
      if (!r.ok) setErr(r.error ?? "加载失败");
      else setD((r as unknown as { data: Summary }).data);
    });
  };
  useEffect(load, []);
  // 任务动态:engine 事件滚动窗(A 期轻版——真实事件行,不聚合 runId;B 期上任务卡)
  useEffect(
    () =>
      subscribeEvents((e) => {
        if (e.kind !== "engine") return;
        const label = typeof e.data.label === "string" ? e.data.label : "";
        if (label) setRunLines((prev) => [...prev.slice(-3), label]);
      }),
    [],
  );

  if (err) return <p className="muted pad">工作台数据加载失败：{err}</p>;
  if (!d) return <p className="muted pad">载入中…</p>;

  const rq = d.reviewQueue ?? [];
  const bf = d.backfillTodos ?? [];
  const p = d.pipeline;
  const persona = d.calibration.persona ?? { summary: "", calibrated: false };
  const todo = [rq.length ? `审稿 ${rq.length}` : "", bf.length ? `回数据 ${bf.length}` : ""].filter(Boolean).join(" · ");
  const hour = new Date().getHours();
  const greet = hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const openEditor = (id: string) => nav({ view: "editor", id });
  const openBoard = () => nav({ view: "board" });

  return (
    <div className="dash">
      <div className="dash-head">
        <h2 className="serif">{greet}，编辑部已就位。</h2>
        <button onClick={openBoard}>进看板 →</button>
      </div>

      <Zone q="今天该做什么" hint={todo || "没有排队的事"}>
        <Card title="待审队列" kicker={rq.length ? `${rq.length} 篇` : "空"}>
          {rq.length === 0 ? (
            <p className="muted">没有待审稿——去「今日可写」挑一条开写？</p>
          ) : (
            rq.slice(0, 6).map((it) => (
              <div key={it.id} className="row" onClick={() => openEditor(it.id)}>
                <span className="mono pri">{PRI_LABEL[it.priority] ?? it.priority}</span>
                <span className="row-title">{it.title || "（无标题）"}</span>
                <span className="muted">{it.ageDays} 天</span>
              </div>
            ))
          )}
        </Card>
        <Card title="回填待办" kicker={bf.length ? `${bf.length} 篇` : "无"}>
          {bf.length === 0 ? (
            <p className="muted">没有等回填的稿子。</p>
          ) : (
            bf.slice(0, 5).map((t) => (
              <div key={t.id} className="row" onClick={() => openEditor(t.id)}>
                <span className="mono pri">{t.level === "overdue" ? "拖了" : "该回了"}</span>
                <span className="row-title">{t.title}</span>
                <span className="muted">发布 {t.daysSince} 天</span>
              </div>
            ))
          )}
        </Card>
      </Zone>

      <Zone q="团队在干什么">
        <Card title="任务动态" kicker="真实事件">
          {runLines.length === 0 ? (
            <p className="muted">编辑部待命中——派活、搜灵感、审稿的进度都在这里。</p>
          ) : (
            runLines.map((l, i) => <p key={i} className="run-line">{l}</p>)
          )}
        </Card>
        <Card title="情报与派活">
          <p className="muted">按定位与画像主动出击,命中语义筛才入灵感库。</p>
          <button onClick={() => send("按我的定位和受众画像,主动搜一轮灵感入库")}>派侦查员搜灵感</button>
        </Card>
      </Zone>

      <Zone q="内容资产" hint={`灵感 ${p.idea} · 在写 ${p.writing} · 待审 ${p.review} · 待发 ${p.ready} · 已发 ${p.published}`}>
        <Card title="管线" kicker="点数字进看板">
          <div className="pipe">
            {([["灵感", p.idea], ["在写", p.writing], ["待审", p.review], ["待发", p.ready], ["已发", p.published]] as const).map(
              ([label, n]) => (
                <div key={label} className="pipe-cell" onClick={openBoard}>
                  <div className="pipe-n serif">{n}</div>
                  <div className="muted mono">{label}</div>
                </div>
              ),
            )}
          </div>
        </Card>
        <Card title="今日可写" kicker={d.inspirations.length ? `top ${d.inspirations.length}` : "灵感库空"}>
          {d.inspirations.length === 0 ? (
            <p className="muted">灵感库还是空的——让侦查员搜一轮,或回旧版「＋新想法」。</p>
          ) : (
            d.inspirations.map((t) => (
              <div key={t.id} className="row">
                <span className="row-title">{t.title}</span>
                <button onClick={() => send(`用选题《${t.title}》写一篇。灵感库编号：${t.id}（开写时带上 topic_id）${t.reason ? `；入库理由：${t.reason}` : ""}`)}>
                  开写
                </button>
              </div>
            ))
          )}
        </Card>
      </Zone>

      <Zone q="数据与成长" hint="越用越像你,越用越懂你的读者">
        <Card title="声音内核" kicker={d.calibration.styleCalibrated ? "已校准" : "未校准"}>
          <p>
            写作规则 {d.calibration.activeRuleCount} 条,声音内核 {d.calibration.voiceCoreCount} 条。
          </p>
          {d.calibration.recentRules.slice(0, 2).map((r, i) => (
            <p key={i} className="muted">最近学到：{r.rule}</p>
          ))}
        </Card>
        <Card title="受众画像" kicker={persona.calibrated ? "已校准" : persona.summary ? "待确认" : "未建立"}>
          {persona.summary ? <p>{persona.summary}</p> : <p className="muted">还不知道你写给谁看——生成三层画像并确认一次。</p>}
          <button className={persona.calibrated ? "" : "primary"} onClick={() => send("校准受众画像")}>
            {persona.calibrated ? "重新校准画像" : "生成并校准画像"}
          </button>
        </Card>
      </Zone>
    </div>
  );
}
