import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";

const CHANNELS = [
  ["website", "独立站"], ["seo", "SEO"], ["content", "内容"], ["xiaohongshu", "小红书"],
  ["wechat_mp", "公众号"], ["douyin", "抖音"], ["bilibili", "B站"], ["email", "邮件"],
  ["reddit", "Reddit"], ["x", "X"], ["linkedin", "LinkedIn"], ["product_hunt", "Product Hunt"],
  ["paid_ads", "付费投放"],
] as const;

interface CampaignAgent {
  id: string;
  role: string;
  name: string;
  mission: string;
}

interface CampaignTask {
  id: string;
  title: string;
  status: string;
  assigneeRole: string;
  channel?: string;
  dependsOn: string[];
  requiredApproval?: string;
}

interface CampaignRun {
  id: string;
  taskId: string;
  status: string;
  attempt: number;
  runtime?: "loop" | "pi-agent";
  agentSessionId?: string;
  error?: string;
}

interface CampaignArtifact {
  id: string;
  taskId: string;
  runId?: string;
  kind: string;
  title: string;
  uri: string;
}

type AutonomyMode = "manual" | "supervised" | "managed";

interface CampaignWorkflowPatch {
  id: string;
  baseRevision: number;
  reason: string;
  proposedBy: "human" | "agent" | "system";
  status: "proposed" | "applied" | "rejected";
  requiresApproval: boolean;
  operations: Array<{ op: string }>;
  createdAt: string;
}

interface Campaign {
  id: string;
  name: string;
  mode: "personal" | "managed_growth";
  status: string;
  brief: {
    targetUrl?: string;
    businessDescription?: string;
    goals: string[];
    audience?: string;
    channels: string[];
    constraints: string[];
  };
  team: { version: number; agents: CampaignAgent[] } | null;
  tasks: CampaignTask[];
  runs: CampaignRun[];
  artifacts: CampaignArtifact[];
  workflow: {
    revision: number;
    autonomy: AutonomyMode;
    policy: {
      maxTasksPerCycle: number;
      maxRunsPerDay: number;
      maxPatchOperations: number;
      maxReplansPerDay: number;
      maxConsecutiveFailures: number;
    };
    schedule: {
      intervalMinutes: number;
      nextRunAt?: string;
      lastCycleAt?: string;
      lastCycleStatus?: "succeeded" | "idle" | "attention" | "failed";
      lastCycleSummary?: string;
    };
    patches: CampaignWorkflowPatch[];
    events: Array<{ seq: number; type: string; at: string; summary: string }>;
  };
  updatedAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "待规划", planning: "规划中", ready: "团队就绪", active: "执行中",
  paused: "已暂停", completed: "已完成", archived: "已归档",
};

const ROLE_LABEL: Record<string, string> = {
  growth_lead: "增长负责人", market_researcher: "市场研究员", content_strategist: "内容策略师",
  copywriter: "文案创作者", seo_specialist: "SEO 专员", channel_operator: "渠道运营",
  paid_media_specialist: "投放专员", performance_analyst: "增长分析师",
};

const AUTONOMY_LABEL: Record<AutonomyMode, string> = {
  manual: "手动控制",
  supervised: "监督托管",
  managed: "全托管",
};

export function Campaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [artifactView, setArtifactView] = useState<{ title: string; markdown: string } | null>(null);
  const [form, setForm] = useState({
    name: "",
    mode: "managed_growth" as "personal" | "managed_growth",
    targetUrl: "",
    description: "",
    goals: "",
    audience: "",
    channels: ["website", "seo", "content"] as string[],
  });

  const load = async (preferId?: string) => {
    const result = await invoke("campaign:list");
    if (!result.ok) return toast(result.error ?? "增长项目加载失败");
    const list = (result as unknown as { data: { campaigns: Campaign[] } }).data.campaigns;
    setCampaigns(list);
    setSelectedId((current) => preferId ?? current ?? list[0]?.id ?? null);
  };

  useEffect(() => {
    void load();
  }, []);

  const selected = campaigns.find((campaign) => campaign.id === selectedId) ?? null;

  const toggleChannel = (channel: string) => {
    setForm((current) => ({
      ...current,
      channels: current.channels.includes(channel)
        ? current.channels.filter((item) => item !== channel)
        : [...current.channels, channel],
    }));
  };

  const create = async () => {
    if (busy) return;
    const goals = form.goals.split("\n").map((goal) => goal.trim()).filter(Boolean);
    if (!form.name.trim() || goals.length === 0) return toast("请填写项目名和至少一个推广目标");
    setBusy(true);
    const result = await invoke("campaign:create", {
      name: form.name.trim(),
      mode: form.mode,
      ...(form.targetUrl.trim() ? { target_url: form.targetUrl.trim() } : {}),
      ...(form.description.trim() ? { business_description: form.description.trim() } : {}),
      goals,
      ...(form.audience.trim() ? { audience: form.audience.trim() } : {}),
      channels: form.channels,
    });
    setBusy(false);
    if (!result.ok) return toast(result.error ?? "创建失败");
    const campaign = (result as unknown as { data: { campaign: Campaign } }).data.campaign;
    setCreating(false);
    setForm({ name: "", mode: "managed_growth", targetUrl: "", description: "", goals: "", audience: "", channels: ["website", "seo", "content"] });
    toast("推广项目已建立——下一步组建 Agent Team");
    await load(campaign.id);
  };

  const plan = async () => {
    if (!selected || busy) return;
    setBusy(true);
    const result = await invoke("campaign:plan_team", { id: selected.id });
    setBusy(false);
    if (!result.ok) return toast(result.error ?? "组队失败");
    toast("Agent Team 与首轮任务图已生成");
    await load(selected.id);
  };

  const transition = async (target: string) => {
    if (!selected || busy) return;
    setBusy(true);
    const result = await invoke("campaign:transition", { id: selected.id, target_status: target });
    setBusy(false);
    if (!result.ok) return toast(result.error ?? "状态切换失败");
    await load(selected.id);
  };

  const setAutonomy = async (autonomy: AutonomyMode) => {
    if (!selected || busy) return;
    setBusy(true);
    const result = await invoke("campaign:set_autonomy", {
      id: selected.id,
      autonomy,
      interval_minutes: selected.workflow.schedule.intervalMinutes,
    });
    setBusy(false);
    if (!result.ok) return toast(result.error ?? "自治模式切换失败");
    toast(`已切换为${AUTONOMY_LABEL[autonomy]}`);
    await load(selected.id);
  };

  const setHostingInterval = async (intervalMinutes: number) => {
    if (!selected || busy) return;
    setBusy(true);
    const result = await invoke("campaign:set_autonomy", {
      id: selected.id,
      autonomy: selected.workflow.autonomy,
      interval_minutes: intervalMinutes,
    });
    setBusy(false);
    if (!result.ok) return toast(result.error ?? "托管周期设置失败");
    toast(`托管周期已调整为 ${intervalMinutes >= 1440 ? "每天" : `${intervalMinutes / 60} 小时`}`);
    await load(selected.id);
  };

  const replan = async () => {
    if (!selected || busy) return;
    setBusy(true);
    toast("PiAgent 正在审查目标、任务和产物…");
    const result = await invoke("campaign:replan", { id: selected.id });
    setBusy(false);
    if (!result.ok) return toast(result.error ?? "动态重规划失败");
    const data = (result as unknown as { data: { patch: CampaignWorkflowPatch; runtime: string } }).data;
    toast(data.patch.status === "applied"
      ? `安全 Patch 已由 ${data.runtime} 自动应用`
      : `PiAgent 已提出 ${data.patch.operations.length} 项变更，等待你确认`);
    await load(selected.id);
  };

  const decidePatch = async (patchId: string, approved: boolean) => {
    if (!selected || busy) return;
    setBusy(true);
    const result = await invoke("campaign:patch_decide", {
      id: selected.id,
      patch_id: patchId,
      approved,
    });
    setBusy(false);
    if (!result.ok) return toast(result.error ?? "Patch 处理失败");
    toast(approved ? "工作流 Patch 已应用" : "工作流 Patch 已拒绝");
    await load(selected.id);
  };

  const runReady = async () => {
    if (!selected || busy) return;
    setBusy(true);
    toast("Agent Team 执行中——本批最多 2 个任务");
    const result = await invoke("campaign:run_ready", { id: selected.id, max_tasks: 2 });
    setBusy(false);
    if (!result.ok) return toast(result.error ?? "执行失败");
    const batch = (result as unknown as { data: { batch: { attempted: number; succeeded: number; failed: number } } }).data.batch;
    toast(batch.attempted === 0 ? "当前没有可执行的 ready 任务" : `本批完成 ${batch.succeeded}，失败 ${batch.failed}`);
    await load(selected.id);
  };

  const retryTask = async (taskId: string) => {
    if (!selected || busy) return;
    const result = await invoke("campaign:retry_task", { id: selected.id, task_id: taskId });
    if (!result.ok) return toast(result.error ?? "任务重试失败");
    toast("任务已重新排队");
    await load(selected.id);
  };

  const openArtifact = async (artifact: CampaignArtifact) => {
    if (!selected) return;
    const result = await invoke("campaign:artifact_get", { id: selected.id, artifact_id: artifact.id });
    if (!result.ok) return toast(result.error ?? "产物读取失败");
    setArtifactView({
      title: artifact.title,
      markdown: (result as unknown as { data: { markdown: string } }).data.markdown,
    });
  };

  return (
    <div className="campaigns">
      <div className="campaign-head">
        <div>
          <h2 className="serif">增长项目</h2>
          <p className="muted">输入独立站或业务，AutoCrew 组建 Agent Team，并把推广拆成可审批、可追踪的任务。</p>
        </div>
        <button className="primary" onClick={() => setCreating((value) => !value)}>{creating ? "收起" : "＋新建项目"}</button>
      </div>

      {creating && (
        <section className="campaign-create card">
          <label><span className="mono muted">项目名称</span><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="如：Demo SaaS 冷启动" /></label>
          <label><span className="mono muted">运行模式</span><select value={form.mode} onChange={(event) => setForm((current) => ({ ...current, mode: event.target.value as typeof current.mode }))}><option value="managed_growth">客户/业务推广</option><option value="personal">个人自媒体运营</option></select></label>
          <label><span className="mono muted">独立站 URL</span><input value={form.targetUrl} onChange={(event) => setForm((current) => ({ ...current, targetUrl: event.target.value }))} placeholder="https://example.com" /></label>
          <label className="campaign-wide"><span className="mono muted">业务描述</span><textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="卖什么、解决什么问题、当前处于什么阶段" rows={3} /></label>
          <label className="campaign-wide"><span className="mono muted">推广目标（每行一个）</span><textarea value={form.goals} onChange={(event) => setForm((current) => ({ ...current, goals: event.target.value }))} placeholder={"30 天获得 100 个注册\n验证中文市场需求"} rows={3} /></label>
          <label className="campaign-wide"><span className="mono muted">目标受众</span><input value={form.audience} onChange={(event) => setForm((current) => ({ ...current, audience: event.target.value }))} placeholder="如：有产品但不会做增长的独立开发者" /></label>
          <div className="campaign-wide"><span className="mono muted">首轮渠道</span><div className="channel-picks">{CHANNELS.map(([id, label]) => <button key={id} className={form.channels.includes(id) ? "chip-pub" : ""} onClick={() => toggleChannel(id)}>{label}</button>)}</div></div>
          <div className="campaign-wide campaign-create-actions"><button className="primary" disabled={busy} onClick={() => void create()}>{busy ? "建立中…" : "建立推广项目"}</button></div>
        </section>
      )}

      <div className="campaign-layout">
        <aside className="campaign-list">
          {campaigns.length === 0 ? <p className="muted card">还没有推广项目。</p> : campaigns.map((campaign) => (
            <button key={campaign.id} className={"campaign-item" + (campaign.id === selectedId ? " campaign-item-on" : "")} onClick={() => setSelectedId(campaign.id)}>
              <strong>{campaign.name}</strong>
              <span className="mono muted">{campaign.mode === "personal" ? "个人运营" : "业务推广"} · {STATUS_LABEL[campaign.status] ?? campaign.status}</span>
            </button>
          ))}
        </aside>

        <section className="campaign-detail">
          {!selected ? <div className="card muted">选择一个项目查看团队与任务。</div> : <>
            <div className="card campaign-summary">
              <div className="card-head"><span className="card-title">{selected.name}</span><span className="chip">{STATUS_LABEL[selected.status] ?? selected.status} · r{selected.workflow.revision}</span></div>
              {selected.brief.targetUrl && <a href={selected.brief.targetUrl} target="_blank" rel="noreferrer">{selected.brief.targetUrl}</a>}
              {selected.brief.businessDescription && <p>{selected.brief.businessDescription}</p>}
              <p className="muted">目标：{selected.brief.goals.join(" · ")}</p>
              <div className="acard-chips">{selected.brief.channels.map((channel) => <span key={channel} className="chip">{CHANNELS.find(([id]) => id === channel)?.[1] ?? channel}</span>)}</div>
              <label>
                <span className="mono muted">工作流自治</span>
                <select
                  value={selected.workflow.autonomy}
                  disabled={busy}
                  onChange={(event) => void setAutonomy(event.target.value as AutonomyMode)}
                >
                  <option value="manual">手动控制——每步由我启动</option>
                  <option value="supervised">监督托管——安全任务自动，计划需确认</option>
                  <option value="managed">全托管——安全任务与安全计划自动</option>
                </select>
              </label>
              <p className="muted">
                {selected.workflow.autonomy === "manual" && "你决定何时运行和是否应用每个工作流变更。"}
                {selected.workflow.autonomy === "supervised" && "后台可执行安全任务；所有动态计划仍进入待审。"}
                {selected.workflow.autonomy === "managed" && "安全 Patch 可自动应用；发布、发消息、改站和付费仍需审批。"}
              </p>
              <label>
                <span className="mono muted">后台托管周期</span>
                <select
                  value={selected.workflow.schedule.intervalMinutes}
                  disabled={busy}
                  onChange={(event) => void setHostingInterval(Number(event.target.value))}
                >
                  <option value={60}>每小时</option>
                  <option value={360}>每 6 小时</option>
                  <option value={1440}>每天</option>
                </select>
              </label>
              {selected.workflow.autonomy !== "manual" && (
                <p className="muted">
                  AutoCrew 本地服务在线时自动托管
                  {selected.workflow.schedule.nextRunAt
                    ? ` · 下次检查 ${new Date(selected.workflow.schedule.nextRunAt).toLocaleString()}`
                    : ""}
                  {selected.workflow.schedule.lastCycleSummary
                    ? ` · 上次：${selected.workflow.schedule.lastCycleSummary}`
                    : ""}
                </p>
              )}
              <div className="campaign-actions">
                {["draft", "planning", "ready"].includes(selected.status) && <button disabled={busy} onClick={() => void plan()}>{selected.team ? "重新组队" : "组建 Agent Team"}</button>}
                {selected.status === "ready" && <button className="primary" disabled={busy} onClick={() => void transition("active")}>启动执行</button>}
                {selected.status === "active" && <><button className="primary" disabled={busy} onClick={() => void runReady()}>{busy ? "执行中…" : "执行下一批"}</button><button disabled={busy} onClick={() => void transition("paused")}>暂停</button><button disabled={busy} onClick={() => void transition("completed")}>完成</button></>}
                {selected.status === "paused" && <button className="primary" disabled={busy} onClick={() => void transition("active")}>恢复执行</button>}
                {selected.team && ["ready", "active", "paused"].includes(selected.status) && <button disabled={busy} onClick={() => void replan()}>{busy ? "规划中…" : "PiAgent 动态重规划"}</button>}
              </div>
            </div>

            <h3 className="serif campaign-section-title">Agent Team</h3>
            {!selected.team ? <p className="muted card">尚未组队。系统会根据站点、目标与渠道选择最小必要团队。</p> : <div className="agent-grid">{selected.team.agents.map((agent) => (
              <div key={agent.id} className="card"><span className="mono muted">{ROLE_LABEL[agent.role] ?? agent.role}</span><strong>{agent.name}</strong><p className="muted">{agent.mission}</p></div>
            ))}</div>}

            {selected.workflow.patches.some((patch) => patch.status === "proposed") && <>
              <h3 className="serif campaign-section-title">待审 Workflow Patch</h3>
              {selected.workflow.patches.filter((patch) => patch.status === "proposed").map((patch) => (
                <div key={patch.id} className="campaign-task card">
                  <span className="mono pri">{patch.operations.length} changes</span>
                  <div>
                    <strong>{patch.reason}</strong>
                    <p className="muted">来自 {patch.proposedBy} · 基于 r{patch.baseRevision} · {patch.operations.map((operation) => operation.op).join(" / ")}</p>
                    <div className="campaign-actions">
                      <button className="primary" disabled={busy} onClick={() => void decidePatch(patch.id, true)}>批准并应用</button>
                      <button disabled={busy} onClick={() => void decidePatch(patch.id, false)}>拒绝</button>
                    </div>
                  </div>
                </div>
              ))}
            </>}

            <h3 className="serif campaign-section-title">Dynamic Workflow 任务图</h3>
            {selected.tasks.length === 0 ? <p className="muted card">组队后生成任务依赖图。</p> : selected.tasks.map((task) => (
              <div key={task.id} className="campaign-task card">
                <span className="mono pri">{task.status}</span>
                <div><strong>{task.title}</strong><p className="muted">{ROLE_LABEL[task.assigneeRole] ?? task.assigneeRole}{task.dependsOn.length ? ` · 依赖 ${task.dependsOn.length} 项` : " · 可立即开始"}{task.requiredApproval ? ` · 执行前需审批 ${task.requiredApproval}` : ""}</p>{task.status === "failed" && <button onClick={() => void retryTask(task.id)}>修复后重试</button>}</div>
              </div>
            ))}

            <h3 className="serif campaign-section-title">运行与产物</h3>
            {selected.runs.length === 0 ? <p className="muted card">尚无 Agent Run。</p> : <div className="campaign-run-grid">
              {[...selected.runs].reverse().slice(0, 12).map((run) => {
                const task = selected.tasks.find((item) => item.id === run.taskId);
                const artifact = selected.artifacts.find((item) => item.runId === run.id);
                return <div key={run.id} className="card"><span className="mono pri">{run.status}</span><strong>{task?.title ?? run.taskId}</strong><p className="muted">第 {run.attempt} 次{run.runtime ? ` · ${run.runtime}` : ""}{run.agentSessionId ? ` · session ${run.agentSessionId.slice(0, 8)}` : ""}{artifact ? ` · 产物：${artifact.title}` : ""}{run.error ? ` · ${run.error}` : ""}</p>{artifact && <button onClick={() => void openArtifact(artifact)}>查看产物</button>}</div>;
              })}
            </div>}
            {artifactView && <div className="campaign-artifact card"><div className="card-head"><span className="card-title">{artifactView.title}</span><button onClick={() => setArtifactView(null)}>关闭</button></div><pre>{artifactView.markdown}</pre></div>}

            {selected.workflow.events.length > 0 && <>
              <h3 className="serif campaign-section-title">Workflow Timeline</h3>
              <div className="campaign-run-grid">
                {[...selected.workflow.events].reverse().slice(0, 12).map((event) => (
                  <div key={event.seq} className="card">
                    <span className="mono pri">{event.type}</span>
                    <strong>{event.summary}</strong>
                    <p className="muted">{new Date(event.at).toLocaleString()}</p>
                  </div>
                ))}
              </div>
            </>}
          </>}
        </section>
      </div>
    </div>
  );
}
