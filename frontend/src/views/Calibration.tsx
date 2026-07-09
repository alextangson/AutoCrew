/**
 * 校准中心(C 期迁移):定位/席位/受众画像/写作规则(看-改-停用)/从编辑中学习/爆款吸收。
 * 规则是"越用越像你"的可视面——每条都能溯源(来源+置信度)、能关掉。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast, openDialog } from "../ui";
import { useChatSend } from "../chat/ChatDock";
import { PLATFORM_CATALOG } from "../lib";

interface Rule {
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

const SOURCE_LABEL: Record<string, string> = {
  auto_distilled: "改稿学的",
  user_explicit: "你说的",
  calibrated: "代表作蒸馏",
};

export function Calibration() {
  const [industry, setIndustry] = useState("");
  const [seats, setSeats] = useState<string[]>([]);
  const [persona, setPersona] = useState<{ summary: string; calibrated: boolean; tiers: Persona | null }>({ summary: "", calibrated: false, tiers: null });
  const [proposal, setProposal] = useState<Persona | null>(null);
  const [basis, setBasis] = useState("");
  const [personaBusy, setPersonaBusy] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
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
    const o = ob as unknown as { industry?: string; platforms?: string[]; data?: { industry?: string; platforms?: string[] } };
    setIndustry(o.industry ?? o.data?.industry ?? "");
    setSeats(o.platforms ?? o.data?.platforms ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  const saveIndustry = async () => {
    if (!industry.trim()) return toast("定位不能为空");
    const r = await invoke("profile:update", { industry: industry.trim() });
    toast(r.ok ? "定位已更新——雷达/侦查过滤即刻生效" : (r.error ?? "保存失败"));
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

  const updateRule = async (index: number, updates: { rule?: string; disabled?: boolean }) => {
    const r = await invoke("style:update_rule", { index, ...updates });
    if (!r.ok) return toast(r.error ?? "更新失败");
    void load();
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
            {persona.tiers.calibratedAt ? ` · ${persona.tiers.calibratedAt.slice(0, 10)}` : ""}
          </div>
          <TierView label="核心受众" tier={persona.tiers.core} />
          <TierView label="邻近受众" tier={persona.tiers.adjacent} />
          <TierView label="意外受众" tier={persona.tiers.surprise} />
        </div>
      ) : (
        <p className="muted">未建立——生成三层画像并确认一次,之后审稿、写作、选题都按它来。</p>
      )}
      <div className="row-actions" style={{ margin: "6px 0" }}>
        <button disabled={personaBusy} onClick={() => void generatePersona()}>
          {personaBusy ? "研究员生成中…(约半分钟)" : persona.tiers ? "重新生成提案" : "生成画像提案"}
        </button>
        <button onClick={() => { send("校准受众画像"); toast("看右侧对话——逐层确认或修正"); }}>在对话里校准</button>
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

      <h3 className="serif calib-h3">写作规则（{rules.filter((r) => !r.disabled).length} 条生效）</h3>
      {rules.length === 0 && <p className="muted">还没有规则——贴代表作吸收,或在编辑器里改稿让它自己学。</p>}
      {rules.map((r, i) => (
        <div key={i} className={"row" + (r.disabled ? " rule-off" : "")}>
          <span className="mono pri">{SOURCE_LABEL[r.source] ?? r.source}</span>
          <span className="row-title">{r.rule}</span>
          <span className="muted mono">{r.scope && r.scope !== "voice_core" ? r.scope.replace("platform:", "") : "内核"}</span>
          <button
            onClick={async () => {
              const v = await openDialog({
                title: "修改写作规则",
                body: "改完立即生效——之后的写稿和审稿都按新规则执行。",
                fields: [{ key: "rule", label: "规则内容", initial: r.rule, required: true, multiline: true }],
                confirmLabel: "保存",
              });
              if (v && v.rule.trim() !== r.rule) void updateRule(i, { rule: v.rule.trim() });
            }}
          >
            改
          </button>
          <button onClick={() => void updateRule(i, { disabled: !r.disabled })}>{r.disabled ? "启用" : "停用"}</button>
        </div>
      ))}

      <h3 className="serif calib-h3">从编辑中学习</h3>
      <p className="muted">把你在编辑器里的改动(含"为什么改")蒸馏成规则——攒够 3 条新改动才有产出。</p>
      <button disabled={busy} onClick={() => void distill()}>
        {busy ? "工作中…" : "现在蒸馏一次"}
      </button>

      <h3 className="serif calib-h3">爆款吸收</h3>
      <p className="muted">贴 1-5 篇你最满意的作品(空行分隔),蒸馏你的声音内核——完成后「已校准」点亮。</p>
      <textarea rows={6} style={{ width: "100%" }} value={samples} onChange={(e) => setSamples(e.target.value)} placeholder="第一篇…&#10;&#10;第二篇…" />
      <div className="row-actions" style={{ marginTop: 6 }}>
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
