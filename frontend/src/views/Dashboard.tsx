/**
 * Dashboard(四问 IA,与 vanilla V5.5a 同构):今天该做什么/团队在干什么/内容资产/数据与成长。
 * 数据同源 dashboard:summary 单通道;行动跳转 A 期先回 vanilla(看板/工作台未迁移)。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import { useRuns } from "../runs";
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
  const { runs, runOrder } = useRuns();
  const send = useChatSend();

  const load = () => {
    invoke("dashboard:summary").then((r) => {
      if (!r.ok) setErr(r.error ?? "加载失败");
      else setD((r as unknown as { data: Summary }).data);
    });
  };
  useEffect(load, []);

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
        <Card title="任务动态" kicker="按任务聚合">
          {runOrder.length === 0 ? (
            <p className="muted">编辑部待命中——派活、搜灵感、审稿的进度都在这里。</p>
          ) : (
            [...runOrder].reverse().slice(0, 3).map((id) => {
              const run = runs[id];
              return (
                <div key={id} className={"runcard" + (run.status === "failed" ? " runcard-failed" : run.status === "done" ? " runcard-done" : "")}>
                  <span className="mono pri">{run.status === "done" ? "✓ 完成" : run.status === "failed" ? "✕ 中断" : "● 进行中"}</span>
                  {run.doneLabel && <span className="muted"> {run.doneLabel}</span>}
                  {run.steps.slice(-3).map((st, i) => (
                    <p key={i} className="run-line muted">{st.done ? "✓" : "…"} {st.label}</p>
                  ))}
                </div>
              );
            })
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
        <Card title="今日可写" kicker={d.inspirations.length ? `今日前 ${d.inspirations.length}` : "灵感库空"}>
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
        <GoalCard nav={nav} />
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

/** 目标卡(V5.6 /goal):北极星 + 周/月复盘一键生成 + 到期提醒。自带数据,不占 dashboard:summary。 */
function GoalCard({ nav }: { nav: (r: Route) => void }) {
  const [goal, setGoal] = useState<{ statement: string; horizon?: string; metrics?: string[]; setAt: string } | null>(null);
  const [retros, setRetros] = useState<Array<{ file: string; mode: string; date: string }>>([]);
  const [busy, setBusy] = useState<"weekly" | "monthly" | null>(null);

  const load = async () => {
    const [g, r] = await Promise.all([invoke("goal:get"), invoke("retro:list")]);
    if (g.ok) setGoal((g as unknown as { data: { goal: typeof goal } }).data.goal);
    if (r.ok) setRetros((r as unknown as { data: { retros: typeof retros } }).data.retros);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editGoal = async () => {
    const statement = window.prompt("目标(一句话,如:3 个月公众号做到 1 万粉)", goal?.statement ?? "");
    if (!statement?.trim()) return;
    const horizon = window.prompt("期限(可选,如 2026-09-30 / 3 个月)", goal?.horizon ?? "") ?? "";
    const r = await invoke("goal:set", { statement: statement.trim(), ...(horizon.trim() ? { horizon: horizon.trim() } : {}) });
    toast(r.ok ? "目标已设——选题、写作、复盘即刻围绕它对齐" : (r.error ?? "保存失败"));
    if (r.ok) void load();
  };

  const runRetro = async (mode: "weekly" | "monthly") => {
    setBusy(mode);
    toast("分析师在写复盘…约 1 分钟,别关页面");
    const r = await invoke("retro:generate", { mode });
    setBusy(null);
    if (!r.ok) return toast(r.error ?? "复盘生成失败");
    toast("复盘已生成——点「数据回流」看全文");
    void load();
  };

  const lastWeekly = retros.find((r) => r.mode === "weekly");
  const weeklyDue = !lastWeekly || Date.now() - new Date(lastWeekly.date).getTime() >= 7 * 86_400_000;

  return (
    <Card title="目标" kicker={goal ? "北极星" : "未设定"}>
      {goal ? (
        <>
          <p>{goal.statement}</p>
          <p className="muted">
            {goal.horizon ? `期限:${goal.horizon}` : ""}
            {(goal.metrics ?? []).length > 0 ? `${goal.horizon ? " · " : ""}指标:${goal.metrics!.join("、")}` : ""}
          </p>
        </>
      ) : (
        <p className="muted">还没有目标——设一个,选题、写作、复盘都会围绕它对齐(对话里说「/goal …」也行)。</p>
      )}
      <div className="row-actions">
        <button className={goal ? "" : "primary"} onClick={() => void editGoal()}>{goal ? "调整目标" : "设定目标"}</button>
        <button disabled={busy !== null} onClick={() => void runRetro("weekly")}>
          {busy === "weekly" ? "生成中…" : `本周复盘${weeklyDue && goal ? " ⏰" : ""}`}
        </button>
        <button disabled={busy !== null} onClick={() => void runRetro("monthly")}>
          {busy === "monthly" ? "生成中…" : "月度深盘"}
        </button>
      </div>
      {retros.length > 0 && (
        <p className="muted" style={{ cursor: "pointer" }} onClick={() => nav({ view: "report" })}>
          最近复盘:{retros[0].date}({retros[0].mode === "weekly" ? "周" : "月"})——数据回流页看全文 →
        </p>
      )}
      {goal && weeklyDue && <p className="muted">⏰ 该做本周复盘了——1 分钟出报告。</p>}
    </Card>
  );
}
