/** 剪映导出目录（P6 §13.4-F）：成片候选唯一允许在项目外的位置。不猜缺省值，没设就拒收项目外成片。 */
import { useEffect, useState } from "react";
import { toast } from "../ui";
import { videoSettingsGet } from "../lib";
import { sourceOp } from "./board-api";
import { Section } from "./settings-kit";

export function SettingsJianying() {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void videoSettingsGet().then((r) => {
      if (!r.ok) return setError(r.error || "读不了视频设置");
      setSaved(r.data?.jianyingExportDir ?? null);
      setDraft(r.data?.jianyingExportDir ?? "");
    });
  }, []);
  const save = async (value: string | null) => {
    setBusy(true);
    try {
      // 剪映导出目录是可搬入根：只走浏览器会话路由（1b §5，§14-7），不走 invoke
      const r = await sourceOp("set_jianying", { path: value });
      if (!r.ok) return toast(r.error || "保存失败");
      setSaved(value);
      setDraft(value ?? "");
      toast(value ? "剪映导出目录已保存" : "已清空剪映导出目录");
    } finally { setBusy(false); }
  };
  return <Section title="剪映导出目录" on={Boolean(saved)} status={saved ? "已设置" : "未设置"}>
    <p>在剪映里审完、导出的成片会落在这里。Codex 报成片候选时，项目外只认这个文件夹。</p>
    <p className="muted">位置见剪映 → 全局设置 → 导出路径。没设置时，项目外的成片候选会被拒收。</p>
    {error && <p role="alert">{error}</p>}
    <label>完整路径<input value={draft} disabled={busy} placeholder="/Users/你/Movies/JianyingPro/导出" onChange={(e) => setDraft(e.target.value)} /></label>
    <button disabled={busy || !draft.trim() || draft.trim() === saved} onClick={() => void save(draft.trim())}>{busy ? "保存中…" : "保存"}</button>{" "}
    {saved && <button disabled={busy} onClick={() => void save(null)}>清空</button>}
  </Section>;
}
