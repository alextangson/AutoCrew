/**
 * 稿件页标题下的一行（1b 验收）：这条在哪一步 + 下一步，和看板卡片面板读同一份 explain() 数据。
 * 创始人在稿件里也要一眼看到「已经在制作了」，并能回看板那张卡。只对按本体走的视频稿显示。
 */
import { useEffect, useState } from "react";
import { loadCard, type CardPanelData } from "./board-api";
import { nextStep } from "./card-next";
import { routeHash } from "../routes";

export function ProductionBanner(p: { contentId: string; refreshKey: string }) {
  const [d, setD] = useState<CardPanelData | null>(null);
  useEffect(() => {
    let live = true;
    void loadCard(p.contentId).then((r) => { if (live && r.ok) setD(r.data); });
    return () => { live = false; };
  }, [p.contentId, p.refreshKey]);
  if (!d?.active) return null;
  const n = nextStep(d);
  return <div className="ed-production-banner" role="status">
    <strong>{d.stage ?? d.column}</strong>
    {n && <span> · 下一步：{n.text}{n.label ? `（${n.label}）` : ""}</span>}
    {" "}<a href={routeHash({ view: "board", card: p.contentId })}>回看板看这张卡</a>
  </div>;
}
