/** 卡片面板顶上的「下一步」一行（1b 验收）：一句话 + 需要你拍板时的按钮 */
import { toast } from "../ui";
import type { CardPanelData } from "./board-api";
import { nextStep } from "./card-next";
import { decideItem } from "./review/review-api";

type Act = (action: string, params: Record<string, unknown>, done: string) => Promise<unknown>;

export function CardNext(p: { d: CardPanelData; busy: boolean; act: Act; openEditor: () => void; refresh: () => Promise<void>; goInbox?: (types?: string[]) => void;
  /** 稿件页有没保存的修改：认稿要等存盘（和顶栏同一条规则），否则认的是旧一版 */
  approveBlocked?: string | null }) {
  const n = nextStep(p.d);
  if (!n) return null;
  const approve = async () => {
    // 走「等你拍板」的单一入口，带卡片载入时那一版稿的代次：别的会话改过正文就拒（整分支审 4 P1）
    if (p.approveBlocked) return toast(p.approveBlocked);
    if (!p.d.draft_item) { toast("稿子刚改过，重新看一眼"); return void (await p.refresh()); }
    const r = await decideItem({ content_id: p.d.id, item_id: p.d.draft_item.item_id, gen: p.d.draft_item.gen, action: "approve_script" });
    // 被拒（多半是稿子刚改过）：重读拿新代次，不让人对着旧代次一直点
    if (!r.ok) { toast(r.error); return void (await p.refresh()); }
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
      <button className="primary" disabled={p.busy || (n.action === "approve_script" && Boolean(p.approveBlocked))} onClick={run}>{n.label}</button>
      {n.action === "approve_script" && p.approveBlocked ? <span className="card-panel-note">{p.approveBlocked}</span> : n.note && <span className="card-panel-note">{n.note}</span>}
    </div>}
  </section>;
}
