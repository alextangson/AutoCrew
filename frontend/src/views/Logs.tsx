/**
 * 工作日志(V5.6 可观测性):两个 tab——
 * 运行日志:每个 run(聊天轮/后台写稿/封面生成)逐步骤展开,看给模型喂了什么、
 * 它回了什么、耗时与错误;团队技能:skills/<name>/SKILL.md 全文(员工工作手册)。
 */
import { useEffect, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { toast } from "../ui";

interface RunSummary {
  runId: string;
  startedAt: string;
  endedAt: string;
  agents: string[];
  llmCalls: number;
  toolCalls: number;
  errorCount: number;
  totalTokens: number;
  firstModel?: string;
}

interface RunRecord {
  ts: string;
  seq: number;
  kind: string;
  agent?: string;
  name: string;
  action?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  tokens?: number;
  input: string;
  output: string;
  truncated?: boolean;
}

interface SkillDoc {
  id: string;
  title: string;
  content: string;
}

const AGENT_LABEL: Record<string, string> = {
  "chief-editor": "总编辑",
  writer: "编剧",
  "cover-designer": "封面设计师",
  "audience-researcher": "受众研究员",
  mcp: "外部会话",
};

const fmtTime = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 19)}`;
const fmtDur = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

export function Logs() {
  const [tab, setTab] = useState<"runs" | "skills">("runs");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [skills, setSkills] = useState<SkillDoc[]>([]);
  const [skillId, setSkillId] = useState<string | null>(null);

  const loadRuns = async () => {
    const r = await invoke("logs:list", { limit: 50 });
    if (r.ok) setRuns((r as unknown as { data: { runs: RunSummary[] } }).data.runs);
  };

  useEffect(() => {
    void loadRuns();
    void invoke("skills:list").then((r) => {
      if (r.ok) setSkills((r as unknown as { data: { skills: SkillDoc[] } }).data.skills);
    });
    const off = subscribeEvents((e) => {
      const kind = (e.data as { kind?: string }).kind;
      if (e.kind === "engine" && (kind === "run_done" || kind === "run_failed")) void loadRuns();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openRun = async (runId: string) => {
    if (selected === runId) return setSelected(null);
    setSelected(runId);
    const r = await invoke("logs:get_run", { run_id: runId });
    if (!r.ok) return toast(r.error ?? "读取失败");
    setRecords((r as unknown as { data: { records: RunRecord[] } }).data.records);
  };

  const skill = skills.find((s) => s.id === skillId) ?? null;

  return (
    <div className="logs">
      <div className="board-bar">
        <span className="board-title serif">工作日志</span>
        <button className={tab === "runs" ? "nav-on" : ""} onClick={() => setTab("runs")}>运行日志</button>
        <button className={tab === "skills" ? "nav-on" : ""} onClick={() => setTab("skills")}>团队技能({skills.length})</button>
        {tab === "runs" && <button onClick={() => void loadRuns()}>刷新</button>}
      </div>

      {tab === "runs" && (
        <>
          <p className="muted">每个 run 是一次任务(聊天轮/后台写稿/封面生成/画像生成);点开看每一步给模型喂了什么、它回了什么、错在哪。保留 14 天。</p>
          {runs.length === 0 && <p className="muted">还没有运行记录——日志从本版本起落盘,跑一次任务就有了。</p>}
          {runs.map((r) => (
            <div key={r.runId}>
              <div className="row" onClick={() => void openRun(r.runId)}>
                <span className="mono pri">{fmtTime(r.startedAt)}</span>
                <span className="row-title">
                  {r.agents.map((a) => AGENT_LABEL[a] ?? a).join("+") || "引擎"} · LLM {r.llmCalls} · 工具 {r.toolCalls}
                  {r.totalTokens > 0 ? ` · ${r.totalTokens} tok` : ""}
                </span>
                <span className={"mono " + (r.errorCount > 0 ? "log-bad" : "muted")}>
                  {r.errorCount > 0 ? `✕ ${r.errorCount} 错` : "✓"}
                </span>
                <span className="muted mono">{r.runId.slice(0, 20)}</span>
              </div>
              {selected === r.runId && (
                <div className="log-run">
                  {records.map((rec) => (
                    <details key={`${rec.seq}-${rec.ts}`} className="log-step">
                      <summary>
                        <span className="mono pri">{rec.kind === "llm" ? "LLM" : "工具"}</span>{" "}
                        {rec.kind === "llm" ? rec.name : `${rec.name}${rec.action ? `·${rec.action}` : ""}`} · {fmtDur(rec.durationMs)} ·{" "}
                        {rec.ok ? "✓" : <span className="log-bad">✕ {rec.error ?? ""}</span>}
                        {rec.tokens ? ` · ${rec.tokens} tok` : ""}
                      </summary>
                      <div className="mono muted">输入{rec.truncated ? "(超长已截断)" : ""}</div>
                      <pre className="log-pre">{rec.input}</pre>
                      <div className="mono muted">输出</div>
                      <pre className="log-pre">{rec.output || "(空)"}</pre>
                    </details>
                  ))}
                  {records.length === 0 && <p className="muted">该 run 无明细(可能已过保留期)。</p>}
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {tab === "skills" && (
        <div className="skills-grid">
          <div>
            {skills.map((s) => (
              <button key={s.id} className={"skill-item" + (skillId === s.id ? " nav-on" : "")} onClick={() => setSkillId(s.id)}>
                {s.title}
              </button>
            ))}
          </div>
          <div>
            {skill ? (
              <>
                <div className="mono muted">skills/{skill.id}/SKILL.md</div>
                <pre className="log-pre skill-doc">{skill.content}</pre>
              </>
            ) : (
              <p className="muted">左边挑一个技能看全文——这是对应员工的工作手册,改它就是调教员工。</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
