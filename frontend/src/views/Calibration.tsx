/**
 * 校准中心(C 期迁移):定位/席位/受众画像/写作规则(看-改-停用)/从编辑中学习/爆款吸收。
 * 规则是"越用越像你"的可视面——每条都能溯源(来源+置信度)、能关掉。
 */
import { useEffect, useState } from "react";
import { authedFetch, invoke } from "../transport";
import { toast, openDialog } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import { PLATFORM_CATALOG } from "../lib";
import { dateLabel } from "../time-format";

type RuleStatus = "pending" | "active" | "rejected" | "disabled";
interface Rule {
  id: string;
  revision: number;
  status?: RuleStatus;
  evidence?: string[];
  promotes?: string;
  rule: string;
  source: string;
  confidence: number;
  scope?: string;
  disabled?: boolean;
}

interface Tier {
  name: string;
  age?: string;
  job?: string;
  coreAnxiety?: string;
  painPoints?: string[];
  scrollStopTriggers?: string[];
}

interface Persona {
  core: Tier;
  adjacent?: Tier;
  surprise?: Tier;
  calibratedAt?: string;
}

const STATUS_LABEL: Record<RuleStatus, string> = { active: "生效", pending: "待批", disabled: "停用", rejected: "已丢弃" };
/** 与服务端 ruleStatus 同口径：缺 status 的存量规则按 disabled 判 */
function ruleStatusOf(r: Rule): RuleStatus {
  return r.status ?? (r.disabled ? "disabled" : "active");
}

const SOURCE_LABEL: Record<string, string> = {
  auto_distilled: "改稿学的",
  user_explicit: "你说的",
  calibrated: "代表作蒸馏",
};

/** 「AI、Agent、FDE」→ ["AI","Agent","FDE"];逗号/顿号/换行都当分隔符 */
function parseKeywords(raw: string): string[] {
  return [...new Set(raw.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean))];
}

export function Calibration() {
  const [industry, setIndustry] = useState("");
  const [focusKeywords, setFocusKeywords] = useState("");
  const [seats, setSeats] = useState<string[]>([]);
  const [persona, setPersona] = useState<{ summary: string; calibrated: boolean; tiers: Persona | null }>({ summary: "", calibrated: false, tiers: null });
  const [proposal, setProposal] = useState<Persona | null>(null);
  const [basis, setBasis] = useState("");
  const [personaBusy, setPersonaBusy] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [busyRule, setBusyRule] = useState<string | null>(null);
  const pendingCount = rules.filter((r) => ruleStatusOf(r) === "pending").length;
  const [samples, setSamples] = useState("");
  const [busy, setBusy] = useState(false);
  const send = useChatSend();

  const load = async () => {
    const [sr, ob] = await Promise.all([invoke("style:rules"), invoke("onboarding:status")]);
    if (sr.ok) {
      const d = (sr as unknown as { data: { rules: Rule[]; persona?: typeof persona } }).data;
      setRules(d.rules ?? []);
      if (d.persona) setPersona(d.persona);
    }
    const o = ob as unknown as {
      industry?: string; platforms?: string[]; focusKeywords?: string[];
      data?: { industry?: string; platforms?: string[]; focusKeywords?: string[] };
    };
    setIndustry(o.industry ?? o.data?.industry ?? "");
    setSeats(o.platforms ?? o.data?.platforms ?? []);
    const kws = o.focusKeywords ?? o.data?.focusKeywords ?? [];
    setFocusKeywords(kws.join("、"));
    return kws;
  };
  useEffect(() => {
    void load();
  }, []);

  const saveIndustry = async () => {
    if (!industry.trim()) return toast("定位不能为空");
    const r = await invoke("profile:update", { industry: industry.trim() });
    toast(r.ok ? "定位已更新——雷达/侦查过滤即刻生效" : (r.error ?? "保存失败"));
  };

  const saveFocusKeywords = async () => {
    const list = parseKeywords(focusKeywords);
    const r = await invoke("profile:update", { focusKeywords: list });
    if (!r.ok) return toast(r.error ?? "保存失败");
    // 回读引擎实际落库的值:保存成功不等于存进去了,不回读就可能对着用户假装保存过
    const saved = await load();
    if (saved.length !== list.length || saved.some((k, i) => k !== list[i])) return toast("保存未生效——引擎没接收雷达关键词");
    toast(list.length ? `雷达关键词已更新(${list.length} 个)——下一轮粗筛按它匹配` : "已清空——粗筛回落到定位派生");
  };

  const toggleSeat = async (id: string) => {
    const next = seats.includes(id) ? seats.filter((x) => x !== id) : [...seats, id];
    if (next.length === 0) return toast("至少保留一个平台席位");
    const r = await invoke("profile:update", { platforms: next });
    if (!r.ok) return toast(r.error ?? "保存失败");
    setSeats(next);
    toast("席位已更新——写稿矩阵即刻生效");
  };

  const generatePersona = async () => {
    setPersonaBusy(true);
    const r = await invoke("persona:generate");
    setPersonaBusy(false);
    if (!r.ok) return toast(r.error ?? "画像生成失败");
    const d = (r as unknown as { data: { proposal: Persona; basis?: string } }).data;
    setProposal(d.proposal);
    setBasis(d.basis ?? "");
  };

  const savePersona = async () => {
    if (!proposal) return;
    const r = await invoke("persona:save", { persona: proposal });
    if (!r.ok) return toast(r.error ?? "保存失败");
    toast("画像已确认——审稿、写作、选题即刻按它对齐");
    setProposal(null);
    void load();
  };

  const updateRule = async (rule: Rule, updates: { rule?: string; disabled?: boolean }) => {
    setBusyRule(rule.id);
    const r = await invoke("style:update_rule", { rule_id: rule.id, revision: rule.revision, ...updates });
    setBusyRule(null);
    if (!r.ok) return toast(r.error ?? "更新失败");
    void load();
  };

  /** 批准/停用/丢弃只走工作台会话路由；eventId 让网络重试不重复落两次决定 */
  const decideRule = async (rule: Rule, decision: "active" | "rejected" | "disabled") => {
    if (decision === "rejected") {
      const ok = await openDialog({ title: "丢弃这条规则？", body: "丢弃后以后再提炼出同一条会被直接挡掉，不能撤回。", fields: [], confirmLabel: "丢弃" });
      if (!ok) return;
    }
    setBusyRule(rule.id);
    try {
      const response = await authedFetch("/api/rules/decision", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId: rule.id, revision: rule.revision, decision, eventId: crypto.randomUUID() }),
      });
      const result = (await response.json().catch(() => ({ ok: false, error: `审批失败（HTTP ${response.status}）` }))) as { ok: boolean; error?: string };
      if (!result.ok) return toast(result.error ?? "审批失败");
      toast(decision === "active" ? "已批准生效；已领的写作包需要重新领取才会用上" : decision === "disabled" ? "已停用" : "已丢弃");
    } catch (e) {
      toast(`审批失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyRule(null);
      void load();
    }
  };

  const distill = async () => {
    setBusy(true);
    const r = await invoke("style:distill");
    setBusy(false);
    const d = (r as unknown as { data?: { summary?: string } }).data;
    toast(r.ok ? (d?.summary ?? "已从编辑记录蒸馏") : (r.error ?? "蒸馏失败"));
    if (r.ok) void load();
  };

  const absorb = async () => {
    const list = samples.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
    if (list.length === 0) return toast("先贴 1-5 篇代表作(空行分隔)");
    setBusy(true);
    const r = await invoke("style:absorb", { samples: list });
    setBusy(false);
    const d = (r as unknown as { data?: { summary?: string } }).data;
    toast(r.ok ? (d?.summary ?? "已吸收进声音内核") : (r.error ?? "吸收失败"));
    if (r.ok) {
      setSamples("");
      void load();
    }
  };

  return (
    <div className="calib">
      <h2 className="serif">校准中心 · 声音内核</h2>

      <div className="ed-section">
        <span className="mono muted">定位：</span>
        <textarea
          className="sel-input calib-industry"
          rows={2}
          value={industry}
          placeholder="如：AI 技术,FDE 部署工程师——写全你的内容线,雷达筛选与画像都以它为锚"
          onChange={(e) => setIndustry(e.target.value)}
        />
        <button onClick={() => void saveIndustry()}>保存</button>
      </div>

      <div className="ed-section">
        <span className="mono muted">雷达关键词：</span>
        <input
          className="sel-input"
          value={focusKeywords}
          placeholder="如：AI、Agent、FDE、部署——逗号或顿号分隔"
          onChange={(e) => setFocusKeywords(e.target.value)}
        />
        <button onClick={() => void saveFocusKeywords()}>保存</button>
      </div>
      <p className="muted">雷达粗筛按这些词匹配候选(标题/摘要命中就加分),留空则从定位里派生——定位是散文,派生出的长词常常一条都命中不了。</p>

      <div className="ed-section">
        <span className="mono muted">席位：</span>
        {PLATFORM_CATALOG.map((c) => (
          <button key={c.id} className={"chip" + (seats.includes(c.id) ? " chip-pub" : "")} onClick={() => void toggleSeat(c.id)}>
            {seats.includes(c.id) ? "✓ " : ""}
            {c.label}
          </button>
        ))}
      </div>

      <h3 className="serif calib-h3">受众画像（审稿标准）</h3>
      {persona.tiers ? (
        <div className="persona-card">
          <div className="mono muted">
            {persona.calibrated ? "✓ 已校准" : "提案态,待确认"}
            {persona.tiers.calibratedAt ? ` · ${dateLabel(persona.tiers.calibratedAt)}` : ""}
          </div>
          <TierView label="核心受众" tier={persona.tiers.core} />
          <TierView label="邻近受众" tier={persona.tiers.adjacent} />
          <TierView label="意外受众" tier={persona.tiers.surprise} />
        </div>
      ) : (
        <p className="muted">未建立——生成三层画像并确认一次,之后审稿、写作、选题都按它来。</p>
      )}
      <div className="row-actions row-actions-spaced">
        <button disabled={personaBusy} onClick={() => void generatePersona()}>
          {personaBusy ? "研究员生成中…(约半分钟)" : persona.tiers ? "重新生成提案" : "生成画像提案"}
        </button>
        <button onClick={() => void send("校准受众画像").then((receipt) => {
          toast(receipt.ok ? "已受理——看右侧对话逐层确认" : (receipt.error ?? "派活失败"));
        })}>在对话里校准</button>
      </div>
      {proposal && (
        <div className="persona-card persona-proposal">
          <div className="mono muted">新提案——可直接修改,「确认落库」后才成为审稿标准</div>
          {basis && <p className="muted">生成依据:{basis}</p>}
          <TierEditor label="核心受众" tier={proposal.core} onChange={(t) => setProposal({ ...proposal, core: t })} />
          <TierEditor label="邻近受众" tier={proposal.adjacent} onChange={(t) => setProposal({ ...proposal, adjacent: t })} />
          <TierEditor label="意外受众" tier={proposal.surprise} onChange={(t) => setProposal({ ...proposal, surprise: t })} />
          <div className="row-actions">
            <button className="primary" onClick={() => void savePersona()}>确认落库</button>
            <button onClick={() => setProposal(null)}>放弃提案</button>
          </div>
        </div>
      )}

      <h3 className="serif calib-h3">写作规则（{rules.filter((r) => ruleStatusOf(r) === "active").length} 条生效{pendingCount ? `，${pendingCount} 条待批` : ""}）</h3>
      {rules.length === 0 && <p className="muted">还没有规则——贴代表作吸收,或在编辑器里改稿让它自己学。</p>}
      {pendingCount > 0 && <p className="muted">自动提炼、对话里记下的规则都先待批，只有你在这里点「批准生效」才进写作要求；批准后已领的写作包需要重新领取。</p>}
      {[...rules].filter((r) => ruleStatusOf(r) !== "rejected").sort((a, b) => Number(ruleStatusOf(b) === "pending") - Number(ruleStatusOf(a) === "pending")).map((r) => {
        const st = ruleStatusOf(r);
        const promoted = r.promotes ? rules.find((x) => x.id === r.promotes) : undefined;
        return (
          <div key={r.id} className={"row" + (st !== "active" ? " rule-off" : "")}>
            <span className="mono pri">{SOURCE_LABEL[r.source] ?? r.source}</span>
            <span className="row-title">
              {r.rule}
              <small> · {STATUS_LABEL[st]}{promoted ? `（提案：把平台规则升级为全局，批准后原平台规则停用）` : ""}</small>
              {r.evidence?.map((e, n) => <details key={n}><summary>来源证据 {n + 1}</summary><pre>{e}</pre></details>)}
            </span>
            <span className="muted mono">{r.scope && r.scope !== "voice_core" ? r.scope.replace("platform:", "") : "内核"}</span>
            <button
              disabled={busyRule === r.id}
              onClick={async () => {
                const v = await openDialog({
                  title: "修改写作规则",
                  body: "修改后这条规则回到待批，你批准后才生效。",
                  fields: [{ key: "rule", label: "规则内容", initial: r.rule, required: true, multiline: true }],
                  confirmLabel: "保存",
                });
                if (v && v.rule.trim() !== r.rule) void updateRule(r, { rule: v.rule.trim() });
              }}
            >
              改
            </button>
            {st === "active"
              ? <button disabled={busyRule === r.id} onClick={() => void decideRule(r, "disabled")}>停用</button>
              : <button disabled={busyRule === r.id} className={st === "pending" ? "primary" : ""} onClick={() => void decideRule(r, "active")}>批准生效</button>}
            {st === "pending" && <button disabled={busyRule === r.id} onClick={() => void decideRule(r, "rejected")}>丢弃</button>}
          </div>
        );
      })}

      <h3 className="serif calib-h3">从编辑中学习</h3>
      <p className="muted">把你在编辑器里的改动(含"为什么改")蒸馏成规则——攒够 3 条新改动才有产出。</p>
      <button disabled={busy} onClick={() => void distill()}>
        {busy ? "工作中…" : "现在蒸馏一次"}
      </button>

      <h3 className="serif calib-h3">爆款吸收</h3>
      <p className="muted">贴 1-5 篇你最满意的作品(空行分隔),蒸馏你的声音内核——完成后「已校准」点亮。</p>
      <textarea rows={6} className="full-width" value={samples} onChange={(e) => setSamples(e.target.value)} placeholder="第一篇…&#10;&#10;第二篇…" />
      <div className="row-actions row-actions-spaced">
        <button className="primary" disabled={busy} onClick={() => void absorb()}>
          {busy ? "吸收中…" : "吸收进声音内核"}
        </button>
      </div>
    </div>
  );
}

function TierView(props: { label: string; tier?: Tier }) {
  const t = props.tier;
  if (!t) return null;
  return (
    <div className="persona-tier">
      <span className="mono pri">{props.label}</span> <b>{t.name}</b>{" "}
      <span className="muted">{[t.age, t.job].filter(Boolean).join(" · ")}</span>
      {t.coreAnxiety && <div>「{t.coreAnxiety}」</div>}
      {(t.painPoints ?? []).length > 0 && <div className="muted">痛点:{(t.painPoints ?? []).join("、")}</div>}
      {(t.scrollStopTriggers ?? []).length > 0 && <div className="muted">停留触发:{(t.scrollStopTriggers ?? []).join("、")}</div>}
    </div>
  );
}

function TierEditor(props: { label: string; tier?: Tier; onChange: (t: Tier) => void }) {
  const t = props.tier;
  if (!t) return null;
  const set = (k: "name" | "age" | "job" | "coreAnxiety", v: string) => props.onChange({ ...t, [k]: v });
  const setList = (k: "painPoints" | "scrollStopTriggers", v: string) =>
    props.onChange({ ...t, [k]: v.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) });
  return (
    <div className="persona-tier">
      <div className="mono muted">{props.label}</div>
      <div className="pt-grid">
        <input value={t.name} placeholder="名字" onChange={(e) => set("name", e.target.value)} />
        <input value={t.age ?? ""} placeholder="年龄" onChange={(e) => set("age", e.target.value)} />
        <input value={t.job ?? ""} placeholder="职业/身份" onChange={(e) => set("job", e.target.value)} />
      </div>
      <input className="pt-wide" value={t.coreAnxiety ?? ""} placeholder="核心焦虑(TA 深夜会想的那句话)" onChange={(e) => set("coreAnxiety", e.target.value)} />
      <input className="pt-wide" value={(t.painPoints ?? []).join("、")} placeholder="痛点短语,顿号分隔" onChange={(e) => setList("painPoints", e.target.value)} />
      <input className="pt-wide" value={(t.scrollStopTriggers ?? []).join("、")} placeholder="停留触发,顿号分隔" onChange={(e) => setList("scrollStopTriggers", e.target.value)} />
    </div>
  );
}
