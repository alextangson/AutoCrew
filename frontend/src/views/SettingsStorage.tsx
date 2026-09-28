import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { Section } from "./settings-kit";

type Plan = { action: string; target: string; files: number; bytes: number; retained: string[]; externalReferences: number };
type Status = { root: string; machineRoot: string; connected: boolean; error?: string; mode: string; pending: Plan | null };
export function SettingsStorage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [action, setAction] = useState("migrate");
  const [target, setTarget] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const r = await invoke("storage:status");
    if (r.ok) setStatus(r.data as Status);
    else toast(r.error || "无法读取资料库位置");
  };
  useEffect(() => { void load(); }, []);
  const preview = async () => {
    setBusy(true);
    try {
      const r = await invoke("storage:preview", { action, target });
      if (!r.ok) { setPlan(null); toast(r.error || "无法使用此路径"); }
      else setPlan(r.data as Plan);
    } finally { setBusy(false); }
  };
  const save = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await invoke("storage:configure", { action: plan.action, target: plan.target });
      if (!r.ok) toast(r.error || "设置失败");
      else { setPlan(null); await load(); toast("已准备好，重启 AutoCrew 后完成切换"); }
    } finally { setBusy(false); }
  };
  return <Section title="用户资料库" on={status?.connected ?? false} status={status?.connected ? "已连接" : "未连接"}>
    <p>账号定位、选题、稿件、素材和运营数据保存在你选择的位置，软件升级不会移动这些资料。</p>
    <p className="wrap-anywhere">当前位置：{status?.root || "读取中…"}</p>
    {status?.error && <p role="alert">{status.error}</p>}
    <p className="muted">密钥、登录凭据和服务日志保留在本机。NAS 同一时间由一台电脑的 AutoCrew 服务写入。</p>
    {status?.pending && <div role="status">
      <p className="wrap-anywhere">待切换到：{status.pending.target}</p>
      <p>重启 AutoCrew 后执行。迁移会先复制、校验，再切换；原资料保留。校验失败则继续保留原位置。</p>
      <button onClick={async () => { const r = await invoke("storage:cancel"); if (r.ok) await load(); else toast(r.error || "取消失败"); }}>取消待切换</button>
    </div>}
    <label>操作 <select value={action} disabled={busy} onChange={(e) => { setAction(e.target.value); setPlan(null); }}>
      <option value="migrate">迁移现有资料</option><option value="create">新建空资料库</option><option value="open">打开已有资料库</option>
    </select></label>
    <label>资料库完整路径<input value={target} disabled={busy} placeholder="本地文件夹或已挂载的 NAS 文件夹" onChange={(e) => { setTarget(e.target.value); setPlan(null); }} /></label>
    <button disabled={busy || !target.trim()} onClick={() => void preview()}>{busy ? "检查中…" : "检查此位置"}</button>
    {plan && <div role="status">
      <p className="wrap-anywhere">目标：{plan.target}</p>
      {plan.action === "migrate" && <p>{plan.files} 个文件，约 {(plan.bytes / 1024 ** 3).toFixed(2)} GB；{plan.externalReferences} 个外部素材引用将纳入资料库。</p>}
      {plan.retained.length > 0 && <p>另有 {plan.retained.length} 项无法自动分类，将保留在原位置并记入迁移报告。</p>}
      <p>目标中已有的其他项目保持原样；遇到同名目录会停止。</p>
      <button disabled={busy} onClick={() => void save()}>保存，重启后切换</button>
    </div>}
  </Section>;
}
