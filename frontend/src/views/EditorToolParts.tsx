/**
 * 稿件控制面里两处都要用的小件（从 EditorTools 抽出）：采纳判定改判、版本记录、发布前检查。
 * 文案抽屉 / 文字稿发布台用 EditorTools，视频稿发布台的「手动工具」用这里的同一份。
 */
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import type { Content } from "../lib";
import { compareVersions, isGenericVersionNote, type VersionLike } from "../version-diff";

/** 存量版本备注是英文自动串(V5.6.2 起后端已改中文)——显示层兜底汉化 */
function versionNoteLabel(note?: string): string {
  if (!note) return "";
  if (note === "Initial draft") return "初稿";
  const edit = note.match(/^Edit v(\d+)$/);
  if (edit) return `第 ${edit[1]} 版`;
  const revert = note.match(/^Reverted to v(\d+)$/);
  if (revert) return `回滚到 v${revert[1]}`;
  return note;
}

const ADOPT: Array<[string, string]> = [
  ["adopted", "直接能用"],
  ["light_edit", "小改后能用"],
  ["rewritten", "基本要重写"],
];

const ADOPT_LABEL = new Map(ADOPT);

export function adoptionLabel(verdict?: string): string {
  return verdict === "rejected" ? "未采纳" : (verdict && ADOPT_LABEL.get(verdict)) || verdict || "";
}


/** 采纳判定：发布确认时由系统按改动量自动判一次，这里展示 + 改判（整条稿级别，不按平台） */
export function AdoptionBlock({ contentId, content: c, reload }: { contentId: string; content: Content; reload: () => Promise<void> }) {
  const [rejudging, setRejudging] = useState(false);
  // 改判:只发 verdict(reason/reason_note 通道保留给 MCP,界面不再问原因)。
  // recordAdoption 整条覆盖 → 系统推导的 derived 标记自然消失,改判后就是人给的裁决。
  const submitAdoption = async (verdict: string) => {
    const r = await invoke("content:adoption", { id: contentId, verdict });
    if (!r.ok) return toast(r.error ?? "记录失败");
    const stats = (r as { stats?: { rate: number | null; judged: number; adopted: number; lightEdit: number } }).stats;
    toast(
      "已按你的判定更正——团队会据此学习你的标准" +
        (stats && stats.rate !== null && stats.judged > 0
          ? ` · 可用率 ${Math.round(stats.rate * 100)}%（${stats.adopted + stats.lightEdit}/${stats.judged}）`
          : ""),
    );
    setRejudging(false);
    void reload();
  };

  if (!c.adoption) return null;
  return (
        <div className="ed-section adoption-verdict">
          <span className="mono muted">
            采纳判定：{adoptionLabel(c.adoption.verdict)}
            {c.adoption.derived ? "（系统按改动量判定）" : ""}
          </span>
          <button onClick={() => setRejudging((v) => !v)}>{rejudging ? "收起" : "改判"}</button>
          {rejudging &&
            ADOPT.map(([v, label]) => (
              <button
                key={v}
                className={c.adoption?.verdict === v ? "chip chip-pub" : ""}
                onClick={() => void submitAdoption(v)}
              >
                {c.adoption?.verdict === v ? "✓ " : ""}{label}
              </button>
            ))}
        </div>
  );
}

/** 版本记录（整条稿级别）：最近 8 版，看差异 / 恢复这版 */
export function VersionList({ contentId, versions, dirty, reload }: { contentId: string; versions: VersionLike[]; dirty: boolean; reload: () => Promise<void> }) {
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);
  if (!versions.length) return null;
  return (
        <details className="ed-tools ed-version-tools">
          <summary>版本记录 · {versions.length} 版</summary>
          <div className="ed-versions">
            <div className="ed-version-head">
              <span className="mono muted">共 {versions.length} 版 · 每次保存都会记录修改说明</span>
            </div>
            {[...versions].reverse().slice(0, 8).map((v) => {
              const previous = versions.find((item) => item.version === v.version - 1);
              const diff = compareVersions(previous, v);
              const note = isGenericVersionNote(v.note) ? diff.summary : versionNoteLabel(v.note);
              const expanded = expandedVersion === v.version;
              return (
                <div key={v.version} className="ed-version-card">
                  <div className="ed-version-row">
                    <span className="mono ed-version-number">v{v.version}</span>
                    <div className="ed-version-main">
                      <strong>{note}</strong>
                      {!isGenericVersionNote(v.note) && <span className="muted">{diff.summary}</span>}
                      <span className="mono muted">{new Date(v.savedAt).toLocaleString("zh-CN", { hour12: false })}</span>
                    </div>
                    {v.version > 1 && (
                      <button onClick={() => setExpandedVersion(expanded ? null : v.version)}>
                        {expanded ? "收起差异" : "查看差异"}
                      </button>
                    )}
                    {v.version !== versions.length && (
                      <button
                        onClick={async () => {
                          if (dirty) return toast("先保存当前修改，再恢复历史版本");
                          const r = await invoke("content:revert", { id: contentId, version: v.version });
                          toast(r.ok ? `已恢复第 ${v.version} 版内容，并保存为新版本` : (r.error ?? "恢复失败"));
                          if (r.ok) void reload();
                        }}
                      >恢复这版</button>
                    )}
                  </div>
                  {expanded && (
                    <div className="ed-version-diff">
                      {diff.titleChanged && previous?.title && v.title && (
                        <div><span className="diff-del">− {previous.title}</span><span className="diff-add">＋ {v.title}</span></div>
                      )}
                      {diff.removed.slice(0, 6).map((text, index) => <p key={`del-${index}`} className="diff-del">− {text}</p>)}
                      {diff.added.slice(0, 6).map((text, index) => <p key={`add-${index}`} className="diff-add">＋ {text}</p>)}
                      {!diff.titleChanged && diff.removed.length === 0 && diff.added.length === 0 && (
                        <p className="muted">与上一版正文一致。</p>
                      )}
                      {(diff.removed.length > 6 || diff.added.length > 6) && <p className="mono muted">仅展示前 6 处差异。</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </details>
  );
}

/** 发布前检查：全过时后端可能顺手推进阶段；挂在哪一项原样报出来，绝不谎报全过 */
export async function runPreCheck(contentId: string, reload: () => Promise<void>): Promise<void> {
  const r = await invoke("publish:pre_check", { content_id: contentId });
  if (!r.ok) { toast(r.error ?? "发布前检查没跑起来"); return; }
  const d = r as unknown as { allPassed?: boolean; checks?: Array<{ name: string; status: string; detail: string }> };
  if (d.allPassed) { toast("检查全过——可以去平台发了"); void reload(); return; }
  const fails = (d.checks ?? []).filter((x) => x.status === "fail").map((x) => `${x.name}:${x.detail.replace(/\s+/g, " ").trim()}`).join("；");
  toast(fails ? `发布前检查未过——${fails.slice(0, 200)}` : "发布前检查未过");
}
