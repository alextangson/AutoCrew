/**
 * 封面面板(V5.6 封面设计师转正):生成 3 候选 → 看图+大字+设计理由 → 选用/提意见重做
 * → 平台比例(公众号 2.35:1;16:9/4:3 Pro)。生成是分钟级后台任务:立即拿 runId,
 * 此处轮询 cover:get 到结果(任务动态卡同时有 SSE 进度)。
 */
import { useEffect, useRef, useState } from "react";
import { invoke, getConfig } from "../transport";
import { toast } from "../ui";

interface CoverVariant {
  label: string;
  style?: string;
  titleText?: string;
  designReason?: string;
  imagePaths: Record<string, string | undefined>;
  revision?: number;
}

interface CoverReview {
  status: string;
  variants: CoverVariant[];
  approvedLabel?: string;
  updatedAt?: string;
  /** 候选主比例(生成入口选定);缺省 3:4 */
  primaryRatio?: string;
}

const PRIMARY_OPTIONS: Array<[string, string]> = [
  ["3:4", "3:4 竖屏(小红书/视频号/抖音)"],
  ["16:9", "16:9 横屏(B站/抖音PC)"],
  ["4:3", "4:3 横屏"],
];

const RATIO_LABEL: Record<string, string> = {
  "2.35:1": "公众号横版 2.35:1",
  "16:9": "16:9 横屏",
  "4:3": "4:3 横屏",
  "3:4": "3:4 竖屏",
};

const assetUrl = (contentId: string, filePath?: string): string => {
  if (!filePath) return "";
  const name = filePath.split("/").pop() ?? "";
  return `/api/asset?content_id=${encodeURIComponent(contentId)}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(getConfig().token)}`;
};

export function CoverPanel(props: { contentId: string; platform: string }) {
  const [review, setReview] = useState<CoverReview | null>(null);
  const [generating, setGenerating] = useState(false);
  const [ratio, setRatio] = useState("3:4");
  const [customTitle, setCustomTitle] = useState("");
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [ratioBusy, setRatioBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = async () => {
    const r = await invoke("cover:get", { content_id: props.contentId });
    setReview(r.ok ? (r as unknown as { review: CoverReview }).review : null);
  };
  useEffect(() => {
    void load();
    return () => stopPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.contentId]);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollUntilChanged = (prevStamp?: string) => {
    stopPoll();
    let ticks = 0;
    pollRef.current = window.setInterval(async () => {
      ticks += 1;
      const r = await invoke("cover:get", { content_id: props.contentId });
      const rv = r.ok ? (r as unknown as { review: CoverReview }).review : null;
      const changed = Boolean(rv && rv.updatedAt !== prevStamp);
      if (changed || ticks > 60) {
        // 60×4s=4 分钟兜底(3 张生图约 1-2 分钟)
        if (rv) setReview(rv);
        setGenerating(false);
        stopPoll();
        if (changed) toast("封面已更新——挑一张或继续提意见");
        else toast("封面还没出结果——看任务动态里有没有失败记录");
      }
    }, 4000);
  };

  const create = async () => {
    const payload: Record<string, unknown> = { content_id: props.contentId, ratio };
    if (customTitle.trim()) payload.custom_title = customTitle.trim();
    const r = await invoke("cover:create", payload);
    if (!r.ok) {
      const hint = (r as { hint?: string }).hint;
      return toast((r.error ?? "生成失败") + (hint ? `——${hint}` : ""));
    }
    setGenerating(true);
    toast("封面设计师开工——约 1-2 分钟,完成自动刷新");
    pollUntilChanged(review?.updatedAt);
  };

  const revise = async (label: string) => {
    const note = (feedback[label] ?? "").trim();
    if (!note) return toast("先写一句意见(如:标题太温,人物再大一点)");
    const r = await invoke("cover:revise", { content_id: props.contentId, label, feedback: note });
    if (!r.ok) return toast(r.error ?? "重做失败");
    setGenerating(true);
    setFeedback((f) => ({ ...f, [label]: "" }));
    toast("按你的意见重做中…");
    pollUntilChanged(review?.updatedAt);
  };

  const approve = async (label: string) => {
    const r = await invoke("cover:approve", { content_id: props.contentId, label });
    if (!r.ok) return toast(r.error ?? "选用失败");
    toast(`已选用方案 ${label.toUpperCase()}`);
    void load();
  };

  const ratios = async (list: string[]) => {
    setRatioBusy(true);
    toast("比例适配生成中…(约 1 分钟)");
    const r = await invoke("cover:ratios", { content_id: props.contentId, ratios: list });
    setRatioBusy(false);
    if (!r.ok) {
      const hint = (r as { upgradeHint?: string }).upgradeHint;
      return toast(hint ?? r.error ?? "比例生成失败");
    }
    const d = r as unknown as { warnings?: string[] };
    toast("平台比例已生成" + (d.warnings?.length ? `(${d.warnings[0]})` : ""));
    void load();
  };

  const approved = review?.variants.find((v) => v.label === review.approvedLabel);
  const primary = review?.primaryRatio ?? "3:4";
  const primaryCss = primary.replace(":", " / ");
  // 适配比例 = 主比例之外的(同方案重渲染保风格统一);2.35:1 只对公众号露出
  const adaptRatios = ["2.35:1", "16:9", "4:3", "3:4"].filter(
    (r) => r !== primary && (r !== "2.35:1" || props.platform === "wechat_mp"),
  );

  return (
    <div className="ed-section" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div className="row-actions" style={{ alignItems: "baseline" }}>
        <span className="mono muted">封面(设计师)：</span>
        <select value={ratio} disabled={generating} onChange={(e) => setRatio(e.target.value)}>
          {PRIMARY_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <input
          className="sel-input"
          style={{ maxWidth: 220 }}
          placeholder="指定封面大字(可选,2-8 字)"
          value={customTitle}
          onChange={(e) => setCustomTitle(e.target.value)}
        />
        <button disabled={generating} onClick={() => void create()}>
          {generating ? "生成中…(看任务动态)" : review ? "重出 3 张候选" : "生成封面候选(3 张)"}
        </button>
      </div>

      {review && (
        <div className="cover-grid">
          {review.variants.map((v) => (
            <div key={v.label} className={"cover-card" + (review.approvedLabel === v.label ? " cover-card-on" : "")}>
              {v.imagePaths[primary] ? (
                <img
                  className="cover-img"
                  style={{ aspectRatio: primaryCss }}
                  src={assetUrl(props.contentId, v.imagePaths[primary])}
                  alt={v.titleText ?? v.label}
                />
              ) : (
                <div className="cover-img cover-missing muted" style={{ aspectRatio: primaryCss }}>无图</div>
              )}
              <div>
                <b className="serif">{v.titleText ?? ""}</b>{" "}
                <span className="mono muted">
                  {v.label.toUpperCase()}·{v.style ?? ""}
                  {(v.revision ?? 1) > 1 ? `·r${v.revision}` : ""}
                </span>
              </div>
              {v.designReason && <div className="muted cover-reason">{v.designReason}</div>}
              <div className="row-actions">
                <button className={review.approvedLabel === v.label ? "chip chip-pub" : ""} onClick={() => void approve(v.label)}>
                  {review.approvedLabel === v.label ? "✓ 已选用" : "选用"}
                </button>
              </div>
              <input
                className="sel-input"
                placeholder="提意见→回车重做这张"
                value={feedback[v.label] ?? ""}
                disabled={generating}
                onChange={(e) => setFeedback((f) => ({ ...f, [v.label]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void revise(v.label);
                }}
              />
            </div>
          ))}
        </div>
      )}

      {approved && (
        <div className="cover-ratio-strip">
          <span className="mono muted">比例适配(同方案重渲染,风格统一)：</span>
          {adaptRatios.map((r) => (
            <button key={r} disabled={ratioBusy} onClick={() => void ratios([r])}>
              {approved.imagePaths[r] ? `重出 ${RATIO_LABEL[r]}` : `出 ${RATIO_LABEL[r]}`}
            </button>
          ))}
          {ratioBusy && <span className="muted">生成中…</span>}
          <div className="cover-adapt-thumbs">
            {adaptRatios
              .filter((r) => approved.imagePaths[r])
              .map((r) => (
                <img
                  key={r}
                  className="cover-thumb"
                  style={{ aspectRatio: r.replace(":", " / ") }}
                  src={assetUrl(props.contentId, approved.imagePaths[r])}
                  alt={RATIO_LABEL[r]}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
