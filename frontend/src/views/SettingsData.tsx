/**
 * 设置 · 数据回流（数据页规格 §G.42）：导入创作者中心 CSV、从公众号后台拉取、三平台自动回流开关。
 * 从数据页挪过来——数据页只留一行状态，入口在这里。三条通道同源幂等，重复导入数字不会翻倍。
 */
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { Section } from "./settings-kit";
import { PullStatusPanel } from "./PullStatusPanel";

interface ImportReport { imported: number; matched: number; historical: number; needsReview?: unknown[]; rejected?: unknown[] }

function ImportSection() {
  const [platform, setPlatform] = useState("douyin");
  const [importing, setImporting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    const r = await invoke("flywheel:import_csv", { platform, csv_text: await file.text() });
    setImporting(false);
    if (!r.ok) return setLast(`导入失败：${r.error ?? "原因不明"}`);
    const rep = (r as unknown as { data: ImportReport }).data;
    const msg = `导入 ${rep.imported} 条：匹配稿件 ${rep.matched} · 历史 ${rep.historical} · 待复核 ${rep.needsReview?.length ?? 0}${rep.rejected?.length ? ` · 拒绝 ${rep.rejected.length}` : ""}`;
    setLast(msg);
    toast(msg);
  };

  const pullWechat = async () => {
    setPulling(true);
    const r = await invoke("flywheel:wechat_pull", {});
    setPulling(false);
    if (!r.ok) return setLast(`公众号拉取失败：${r.error ?? "原因不明"}`);
    const { data: rep, note } = r as unknown as { data: ImportReport; note?: string };
    setLast(`公众号回填：入账 ${rep.imported} 条（匹配稿件 ${rep.matched} · 历史 ${rep.historical}）${note ?? ""}`);
  };

  return (
    <Section title="手动导入" status="">
      <p className="muted">创作者中心导出的 CSV 直接导入；公众号可以从后台一键拉。和自动回流同源——同一批数据重复导入无害。</p>
      <div className="row row-static">
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="CSV 来自哪个平台">
          <option value="douyin">抖音</option>
          <option value="wechat_video">视频号</option>
          <option value="xiaohongshu">小红书</option>
          <option value="wechat_mp">公众号</option>
        </select>
        <label className={"chip-file" + (importing ? " is-busy" : "")}>
          {importing ? "导入中…" : "导入创作者中心 CSV"}
          <input type="file" accept=".csv,text/csv" hidden disabled={importing}
            onChange={(e) => { void importCsv(e.target.files?.[0]); e.currentTarget.value = ""; }} />
        </label>
        <button disabled={pulling} onClick={() => void pullWechat()}>{pulling ? "拉取中…" : "从公众号后台拉取"}</button>
      </div>
      {last && <p className={last.includes("失败") ? "pull-banner" : "muted pull-note"}>{last}</p>}
    </Section>
  );
}

export function SettingsData() {
  return (
    <>
      <PullStatusPanel onImported={() => {}} />
      <ImportSection />
    </>
  );
}
