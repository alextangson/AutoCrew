/**
 * 素材库(D 期前迁移,最后一个 vanilla 视图):列表/搜索/文件夹/改名/移动/移除。
 * 导入 = 粘贴绝对路径(每行一个)——浏览器拿不到本地路径,Electron 时代的文件对话框
 * 在 server 模式本来就是坏的("文件选择不可用");本地工具,路径粘贴反而最直接
 * (Finder 里 Option+Cmd+C 复制路径)。引用不复制,原文件不动。
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "../transport";
import { toast, openDialog, confirmDialog } from "../ui";

interface LibAsset {
  id: string;
  name: string;
  type: string;
  size: number;
  path?: string;
  tags?: string[];
  description?: string;
  folderId?: string | null;
  missing?: boolean;
  /** 常备素材池成员(视频线 lifecycle §1):进每条视频的剪辑师目录 */
  reusable?: boolean;
  /** 入库时 ffprobe 探到的时长/画幅 */
  media?: { durationMs: number; width?: number; height?: number };
}

interface LibFolder {
  id: string;
  name: string;
}

const TYPE_ICON: Record<string, string> = { video: "🎬", image: "🖼", audio: "🎵", other: "📄" };

function fmtSize(n: number): string {
  if (!n || n <= 0) return "";
  if (n > 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return Math.round(n / 1024) + " KB";
}

export function Library() {
  const [assets, setAssets] = useState<LibAsset[]>([]);
  const [folders, setFolders] = useState<LibFolder[]>([]);
  const [folderId, setFolderId] = useState<string>("");
  const [q, setQ] = useState("");
  const [paths, setPaths] = useState("");
  const [importing, setImporting] = useState(false);

  const load = async () => {
    const r = await invoke("library:list", folderId ? { folder_id: folderId } : {});
    if (!r.ok) return toast(r.error ?? "素材库加载失败");
    const d = (r as unknown as { data: { assets?: LibAsset[]; folders?: LibFolder[] } }).data;
    setAssets(d.assets ?? []);
    setFolders(d.folders ?? []);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return assets;
    return assets.filter(
      (a) =>
        a.name.toLowerCase().includes(kw) ||
        (a.tags ?? []).some((t) => t.toLowerCase().includes(kw)) ||
        (a.description ?? "").toLowerCase().includes(kw),
    );
  }, [assets, q]);

  const doImport = async () => {
    const list = paths.split("\n").map((p) => p.trim()).filter(Boolean);
    if (list.length === 0) return toast("先粘贴至少一个绝对路径(每行一个)");
    setImporting(true);
    const r = await invoke("library:add", { paths: list, ...(folderId ? { folder_id: folderId } : {}) });
    setImporting(false);
    if (!r.ok) return toast(r.error ?? "导入失败");
    const d = (r as unknown as { data: { added?: unknown[]; skipped?: unknown[] } }).data;
    toast(`已导入 ${(d.added ?? []).length} 条` + ((d.skipped ?? []).length ? `,跳过 ${(d.skipped ?? []).length} 条(重复或不可读)` : ""));
    setPaths("");
    void load();
  };

  return (
    <div className="library">
      <h2 className="serif">素材库</h2>
      <div className="ed-section">
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">全部/根目录</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <input className="sel-input" placeholder="搜名称/标签/描述" value={q} onChange={(e) => setQ(e.target.value)} />
        <button
          onClick={async () => {
            const v = await openDialog({
              title: "新建文件夹",
              fields: [{ key: "name", label: "名称", placeholder: "如:B-roll 素材", required: true }],
              confirmLabel: "创建",
            });
            if (!v) return;
            const r = await invoke("library:folder_create", { name: v.name.trim() });
            toast(r.ok ? "已建文件夹" : (r.error ?? "创建失败"));
            if (r.ok) void load();
          }}
        >
          ＋文件夹
        </button>
        {folderId && (
          <button
            onClick={async () => {
              const yes = await confirmDialog({
                title: `删除文件夹「${folders.find((f) => f.id === folderId)?.name ?? ""}」?`,
                body: "夹内素材回到根目录,原文件不动。",
                confirmLabel: "删除",
                danger: true,
              });
              if (!yes) return;
              const r = await invoke("library:folder_remove", { id: folderId });
              toast(r.ok ? "已删文件夹" : (r.error ?? "删除失败"));
              if (r.ok) setFolderId("");
            }}
          >
            删此文件夹
          </button>
        )}
      </div>

      <div className="pending-edit">
        <div className="mono muted">导入素材——粘贴绝对路径,每行一个(引用不复制,原文件不动)</div>
        <textarea rows={3} style={{ width: "100%" }} value={paths} placeholder={"/Users/you/Movies/broll-01.mp4\n/Users/you/Pictures/cover.png"} onChange={(e) => setPaths(e.target.value)} />
        <div className="row-actions">
          <button className="primary" disabled={importing} onClick={() => void doImport()}>
            {importing ? "导入中…" : "导入"}
          </button>
          <span className="muted mono">Finder 选中文件 Option+Cmd+C 即复制路径</span>
        </div>
      </div>

      {shown.length === 0 && <p className="muted">这里还没有素材{q ? "(换个关键词?)" : "——粘路径导入,或让写手在稿里标 [缺图:] 时再来补"}。</p>}
      {shown.map((a) => (
        <div key={a.id} className={"row" + (a.missing ? " rule-off" : "")}>
          <span>{TYPE_ICON[a.type] ?? "📄"}</span>
          <span className="row-title">
            {a.name}
            {a.missing ? "(源文件丢失)" : ""}
            {a.reusable ? <span className="chip">常备</span> : null}
            {a.description ? <span className="mono muted"> · {a.description}</span> : null}
          </span>
          <span className="muted mono">{fmtSize(a.size)}{(a.tags ?? []).length ? " · " + (a.tags ?? []).join(",") : ""}</span>
          <button
            onClick={async () => {
              const v = await openDialog({
                title: "重命名素材",
                fields: [{ key: "name", label: "名称", initial: a.name, required: true }],
                confirmLabel: "保存",
              });
              if (!v || v.name.trim() === a.name) return;
              const r = await invoke("library:update", { id: a.id, name: v.name.trim() });
              toast(r.ok ? "已改名" : (r.error ?? "改名失败"));
              if (r.ok) void load();
            }}
          >
            改名
          </button>
          {/* 说明编辑此前根本没有入口——常备池的前置是说明非空,没有它开关就是个必然报错的按钮 */}
          <button
            onClick={async () => {
              const v = await openDialog({
                title: `给「${a.name}」写一行说明`,
                body: "说明是剪辑师认识这条素材的唯一依据(文件名它读不懂)。例:屏录 · 后台任务面板跑批的过程",
                fields: [{ key: "description", label: "说明", initial: a.description ?? "", multiline: true }],
                confirmLabel: "保存",
              });
              if (!v) return;
              const r = await invoke("library:update", { id: a.id, description: v.description.trim() });
              toast(r.ok ? "已保存说明" : (r.error ?? "保存失败"));
              if (r.ok) void load();
            }}
          >
            {a.description ? "改说明" : "写说明"}
          </button>
          {/* 常备池只对视频/图片有意义:音频进不了覆盖轨,给个开关只会让人白点一次 */}
          {(a.type === "video" || a.type === "image") && (
            <button
              onClick={async () => {
                const r = await invoke("library:set_reusable", { id: a.id, reusable: !a.reusable });
                const warning = (r as unknown as { data?: { warning?: string } }).data?.warning;
                toast(
                  r.ok
                    ? (a.reusable ? "已移出常备池" : "已纳入常备池 —— 之后每条视频的剪辑师都能用它") +
                        (warning ? ` · ${warning}` : "")
                    : (r.error ?? "操作失败"),
                );
                if (r.ok) void load();
              }}
            >
              {a.reusable ? "移出常备" : "设为常备"}
            </button>
          )}
          <select
            value={a.folderId ?? ""}
            onChange={async (e) => {
              const r = await invoke("library:update", { id: a.id, folder_id: e.target.value || null });
              toast(r.ok ? "已移动" : (r.error ?? "移动失败"));
              if (r.ok) void load();
            }}
          >
            <option value="">根目录</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <button
            onClick={async () => {
              const yes = await confirmDialog({
                title: `移除「${a.name}」?`,
                body: "只移除素材库索引,磁盘上的原文件不动。",
                confirmLabel: "移除",
                danger: true,
              });
              if (!yes) return;
              const r = await invoke("library:remove", { id: a.id });
              toast(r.ok ? "已移除" : (r.error ?? "移除失败"));
              if (r.ok) void load();
            }}
          >
            移除
          </button>
        </div>
      ))}
    </div>
  );
}
