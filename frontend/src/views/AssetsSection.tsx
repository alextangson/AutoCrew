/**
 * 素材挂接（从 EditorTools 抽出）。两处用它，所以它不能再住在抽屉里：
 * - 文案页抽屉：文字平台的配图/附件仍在那儿；
 * - 剪辑台：视频稿的 A-roll/B-roll/BGM 入口在这儿（阶段制 spec §2）——
 *   挂素材是剪辑的第一步，隔着一个抽屉去挂是上一版 IA 的遗留。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast, confirmDialog } from "../ui";

/** 角色决定这条素材在成片里怎么用：口播底轨只能有一条，BGM 多于一条组装会报错要你选 */
const ASSET_ROLES: Array<[string, string]> = [
  ["aroll", "口播底轨"],
  ["broll", "B-roll(屏录/图版)"],
  ["bgm", "背景音乐"],
  ["other", "其他"],
];

const ROLE_LABEL = new Map(ASSET_ROLES);

/** 与后端 guessAssetRole 同一套默认值；这里只是预填，最终由人确认 */
function guessRole(type: string, assets: Array<{ type: string; filename: string }>): string {
  if (type === "audio") return "bgm";
  if (type === "video") return assets.some((a) => a.type === "video" && !/^final-v\d+\.mp4$/i.test(a.filename)) ? "broll" : "aroll";
  if (type === "image") return "broll";
  return "other";
}

type LibraryPick = { id: string; name: string; type: string; tags?: string[]; description?: string; missing?: boolean; reusable?: boolean };

export interface AssetItem {
  filename: string;
  type: string;
  description?: string;
  role?: string;
}

/** 成片是视频线自己登记的产物，不是人挂的素材——挂接列表里混着它只会让人以为自己挂错了 */
export function isFinalAsset(filename: string): boolean {
  return /^final-v\d+\.mp4$/i.test(filename);
}

export function AssetsSection(props: {
  contentId: string;
  assets: AssetItem[];
  reload: () => Promise<void>;
  /** 剪辑台把常备池数量摆出来：剪辑师能用的不止本稿挂的这几条 */
  showPool?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [lib, setLib] = useState<LibraryPick[]>([]);
  const [chosen, setChosen] = useState<LibraryPick | null>(null);
  const [role, setRole] = useState("other");
  const [note, setNote] = useState("");
  const [poolCount, setPoolCount] = useState<number | null>(null);

  useEffect(() => {
    if (!props.showPool) return;
    void invoke("library:list").then((r) => {
      if (!r.ok) return; // 读不到就不显示这一行,不编数字
      const d = (r as unknown as { data?: { assets?: LibraryPick[] } }).data;
      setPoolCount((d?.assets ?? []).filter((a) => a.reusable && !a.missing).length);
    });
  }, [props.showPool]);

  const openPicker = async () => {
    if (picking) return setPicking(false);
    const r = await invoke("library:list");
    if (!r.ok) return toast(r.error ?? "素材库加载失败");
    const d = (r as unknown as { data: { assets?: LibraryPick[] } }).data;
    setLib((d.assets ?? []).filter((a) => !a.missing));
    setChosen(null);
    setPicking(true);
  };

  // 选中素材时预填角色与说明——不靠创始人记得改文件名(spec §2.6)
  const choose = (a: LibraryPick) => {
    setChosen(a);
    setRole(guessRole(a.type, props.assets));
    setNote(a.description?.trim() || [a.name, (a.tags ?? []).join("、")].filter(Boolean).join(" · "));
  };

  const attach = async () => {
    if (!chosen) return;
    if (!note.trim()) return toast("写一行说明再挂接——没有说明的素材,剪辑师看不见它");
    const r = await invoke("content:asset_add", {
      content_id: props.contentId,
      library_id: chosen.id,
      role,
      description: note.trim(),
    });
    if (!r.ok) return toast(r.error ?? "挂接失败");
    const warning = (r as unknown as { data?: { warning?: string } }).data?.warning;
    toast(warning ? `已挂接「${chosen.name}」·${warning}` : `已挂接「${chosen.name}」`);
    setPicking(false);
    setChosen(null);
    void props.reload();
  };

  return (
    <div className="ed-section" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div>
        <span className="mono muted ed-label">素材（{props.assets.length}）：</span>
        <button onClick={() => void openPicker()}>{picking ? "收起" : "从素材库挂接"}</button>
        <button
          onClick={async () => {
            const r = await invoke("content:open_folder", { id: props.contentId });
            if (!r.ok) return toast((r as { error?: string }).error ?? "打开失败");
            const d = r as { opened?: boolean; path?: string };
            toast(d.opened ? "已在 Finder 打开——文案 draft.md、封面、素材都在里面" : `文件夹:${d.path ?? ""}`);
          }}
        >打开稿件文件夹</button>
      </div>
      {props.showPool && poolCount !== null && (
        <span className="mono muted">
          剪辑师还能用素材库里 {poolCount} 条常备素材（在「素材库」页设为常备，每条片子都能用）。
        </span>
      )}
      {props.assets.map((a) => (
        <div key={a.filename} className="row">
          <span className="row-title">{a.filename}</span>
          <span className="muted mono">
            {a.role ? (ROLE_LABEL.get(a.role) ?? a.role) : a.type}
            {a.description ? " · " + a.description : " · 无说明"}
          </span>
          <button
            onClick={async () => {
              const yes = await confirmDialog({
                title: `移除挂接素材「${a.filename}」?`,
                body: "删除稿件项目内的副本,素材库原件不受影响。",
                confirmLabel: "移除",
                danger: true,
              });
              if (!yes) return;
              const r = await invoke("content:asset_remove", { content_id: props.contentId, filename: a.filename });
              toast(r.ok ? "已移除" : (r.error ?? "移除失败"));
              if (r.ok) void props.reload();
            }}
          >移除</button>
        </div>
      ))}
      {picking && (
        <div className="pending-edit">
          {lib.length === 0 && <p className="muted">素材库暂无可用素材——先到「素材库」粘路径导入。</p>}
          {lib.map((a) => (
            <div key={a.id} className="row">
              <span className="row-title">{a.name}</span>
              {a.reusable && <span className="chip">常备</span>}
              <button className={chosen?.id === a.id ? "chip chip-pub" : ""} onClick={() => choose(a)}>
                {chosen?.id === a.id ? "✓ 已选" : "选它"}
              </button>
            </div>
          ))}
          {chosen && (
            <div className="ed-digest">
              <span className="mono muted">「{chosen.name}」在成片里的角色</span>
              <select className="sel-input" value={role} onChange={(e) => setRole(e.target.value)}>
                {ASSET_ROLES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
              <span className="mono muted">一行说明(剪辑师只看得见有说明的素材)</span>
              <input
                className="sel-input"
                maxLength={80}
                value={note}
                placeholder="例:命令行跑 autocrew 的屏录,含安装到出稿全过程"
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="row-actions">
                <button className="primary" disabled={!note.trim()} onClick={() => void attach()}>挂接</button>
                <button onClick={() => setChosen(null)}>取消</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
