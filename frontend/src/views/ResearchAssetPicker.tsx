/**
 * 「研究素材」选图弹层（深调研 spec §7「放置即导入」）——正文配图槽的第三个来源，
 * 与「AI 生成」「用自己的图」并列。
 *
 * 三条可见性约定：
 * 1. **授权自查是常驻标注,不是脚注**：这些图抓自别人的页面,授权一律未知。
 * 2. **只列真下载下来的**：仅链接的候选在这里没意义(点了也放不进正文),
 *    它们的降级原因在选题卡的调研简报里说清楚,不在这儿重复。
 * 3. **失败照实说**：导入被格式校验拒(webp)、文件丢了,都把后端那句原话弹出来。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";

export interface ResearchAssetView {
  url: string;
  sourcePageUrl: string;
  caption: string;
  assetId?: string;
  downloadError?: string;
  stored: boolean;
  width?: number;
  height?: number;
  fileUrl?: string;
}

export function domainOf(url: string): string {
  const m = url.match(/https?:\/\/([^/\s]+)/);
  return m ? m[1].replace(/^www\./, "") : url.slice(0, 30);
}

/** 拉某选题当前简报里的素材候选；没有简报/读失败都当作「没有」,由调用方决定要不要露入口 */
export async function loadResearchAssets(topicId: string): Promise<ResearchAssetView[]> {
  const r = await invoke("research:list_assets", { topic_id: topicId });
  if (!r.ok) return [];
  return (r as unknown as { data: { assets: ResearchAssetView[] } }).data.assets;
}

export function ResearchAssetPicker(props: {
  topicId: string;
  contentId: string;
  index: number;
  onClose: () => void;
  onImported: () => void;
}) {
  const [assets, setAssets] = useState<ResearchAssetView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadResearchAssets(props.topicId).then((list) => {
      if (alive) setAssets(list.filter((a) => a.stored));
    });
    return () => {
      alive = false;
    };
  }, [props.topicId]);

  const choose = async (asset: ResearchAssetView) => {
    if (!asset.assetId) return;
    setBusy(asset.assetId);
    try {
      const r = await invoke("research:import_asset", {
        topic_id: props.topicId,
        asset_id: asset.assetId,
        content_id: props.contentId,
        index: props.index,
      });
      if (!r.ok) return toast((r as { error?: string }).error ?? "导入失败");
      const deduped = (r as unknown as { data?: { deduped?: boolean } }).data?.deduped;
      toast(deduped ? "这一位已经是这张素材了" : `配图 ${props.index + 1} 已换成研究素材`);
      props.onImported();
      props.onClose();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dlg-overlay" onClick={props.onClose}>
      <div className="dlg ra-dlg" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-title">研究素材 · 放进配图 {props.index + 1}</div>
        <p className="dlg-body muted">
          深调研过程中从真实网页抓到的图。<strong>授权需自查</strong>——用之前先看来源页允不允许转载。
        </p>
        {assets === null && <p className="muted">读取素材…</p>}
        {assets?.length === 0 && (
          <p className="muted">这条选题还没有下载成功的素材。跑一轮深调研，或看选题卡上的降级原因。</p>
        )}
        {assets && assets.length > 0 && (
          <div className="ra-grid">
            {assets.map((a) => (
              <button
                key={a.assetId}
                className="ra-item"
                disabled={busy !== null}
                onClick={() => void choose(a)}
              >
                <img src={a.fileUrl} alt={a.caption} />
                <span className="ra-cap">{busy === a.assetId ? "导入中…" : a.caption}</span>
                <span className="mono muted">
                  {a.width}×{a.height} · {domainOf(a.sourcePageUrl)}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="dlg-actions">
          <button onClick={props.onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
