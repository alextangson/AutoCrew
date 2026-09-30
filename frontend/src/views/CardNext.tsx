/** 卡片面板顶上的「下一步」一行（1b 验收）：一句话 + 需要你拍板时的按钮 */
import { invoke } from "../transport";
import { toast } from "../ui";
import type { CardPanelData } from "./board-api";
import { nextStep } from "./card-next";

type Act = (action: string, params: Record<string, unknown>, done: string) => Promise<unknown>;

export function CardNext(p: { d: CardPanelData; busy: boolean; act: Act; openEditor: () => void; refresh: () => Promise<void>; goInbox?: (types?: string[]) => void }) {
  const n = nextStep(p.d);
  if (!n) return null;
  const approve = async () => {
    // 与看板把卡从「写稿中」拖到「待录制」同一条认稿路径（浏览器会话）
    const r = await invoke("content:transition", { id: p.d.id, from_status: p.d.status, target_status: "approved", force: true });
    if (!r.ok) return toast(r.error ?? "没改成，刷新一下再试");
    toast((p.d.arolls ?? []).length ? "已进剪辑中" : "已进待录制");
    await p.refresh();
  };
  const run = () => {
    if (n.action === "approve_script") return void approve();
    // 看成片 / 挑封面在「等你拍板」里（review-inbox §10）；没接列表的地方照旧去工作台
    if (n.action === "open_cut" || n.action === "open_cover") return p.goInbox ? p.goInbox(n.action === "open_cut" ? ["cut_review", "sliver"] : ["cover_pick"]) : p.openEditor();
    if (n.action === "i_published") return void p.act("i_published", { platform: p.d.platform ?? "" }, "已记为发出去了");
  };
  return <section className="card-panel-next" aria-label="下一步">
    <p><strong>下一步：</strong>{n.text}</p>
    {n.action && <div className="card-panel-row">
      <button className="primary" disabled={p.busy} onClick={run}>{n.label}</button>
      {n.note && <span className="card-panel-note">{n.note}</span>}
    </div>}
  </section>;
}
