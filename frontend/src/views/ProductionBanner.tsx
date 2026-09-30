/**
 * 稿件页标题下的一行（1b 验收）：这条在哪一步 + 下一步，和看板卡片面板读同一份 explain() 数据。
 * 写稿段已经有原片的稿也显示（创始人就卡在这种稿上）；只有普通在写、没什么可说的稿才不显示。
 */
import { useEffect, useState } from "react";
import { loadCard, type CardPanelData } from "./board-api";
import { bannerText } from "./card-next";
import { routeHash } from "../routes";

export function ProductionBanner(p: { contentId: string; refreshKey: string }) {
  const [d, setD] = useState<CardPanelData | null>(null);
  useEffect(() => {
    let live = true;
    void loadCard(p.contentId).then((r) => { if (live && r.ok) setD(r.data); });
    return () => { live = false; };
  }, [p.contentId, p.refreshKey]);
  const text = d ? bannerText(d) : null;
  if (!d || !text) return null;
  const stage = `${d.stage ?? d.column}${d.status === "reviewing" ? "（待审）" : ""}`;
  return <div className="ed-production-banner" role="status">
    <strong>{stage}</strong> · {text}
    {" "}<a href={routeHash({ view: "board", card: p.contentId })}>回看板看这张卡</a>
  </div>;
}
