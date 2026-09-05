/**
 * 封面面板(V5.6 封面设计师转正):生成 3 候选 → 看图+大字+设计理由 → 选用/提意见重做
 * → 平台比例(公众号 2.35:1;16:9/4:3 Pro)。生成是分钟级后台任务:立即拿 runId,
 * 此处轮询 cover:get 到结果(任务动态卡同时有 SSE 进度)。
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke, subscribeEvents } from "../transport";
import { toast } from "../ui";
import { coverRatiosForPlatform, COVER_RATIO_LABEL } from "../lib";
import { IdentityLibraryPanel } from "./IdentityLibraryPanel";

interface CoverVariant {
  label: string;
  style?: string;
  creativeConcept?: string;
  visualMedium?: string;
  palette?: string;
  titleText?: string;
  designReason?: string;
  imagePaths: Record<string, string | undefined>;
  revision?: number;
  hasPersonalIP?: boolean;
}

interface MaskRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CoverReview {
  status: string;
  designSource?: "designer" | "hybrid" | "rules";
  variants: CoverVariant[];
  expectedVariantCount?: number;
  generationErrors?: string[];
  approvedLabel?: string;
  updatedAt?: string;
  /** 候选主比例(生成入口选定);缺省 3:4 */
  primaryRatio?: string;
}

const assetUrl = (contentId: string, filePath?: string): string => {
  if (!filePath) return "";
  const name = filePath.split("/").pop() ?? "";
  return `/api/asset?content_id=${encodeURIComponent(contentId)}&name=${encodeURIComponent(name)}`;
};

export function CoverPanel(props: { contentId: string; platform: string }) {
  const ratioOptions = coverRatiosForPlatform(props.platform);
  const [review, setReview] = useState<CoverReview | null>(null);
  const [generating, setGenerating] = useState(false);
  const [ratio, setRatio] = useState(ratioOptions[0]);
  const [customTitle, setCustomTitle] = useState("");
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [ratioBusy, setRatioBusy] = useState(false);
  const [identityReady, setIdentityReady] = useState(false);
  const [localMode, setLocalMode] = useState<Record<string, boolean>>({});
  const [maskRegions, setMaskRegions] = useState<Record<string, MaskRegion | undefined>>({});
  const pollRef = useRef<number | null>(null);
  const activeRunRef = useRef<string | null>(null);
  const dragRef = useRef<{ label: string; startX: number; startY: number; pointerId: number } | null>(null);

  const load = async () => {
    const r = await invoke("cover:get", { content_id: props.contentId });
    setReview(r.ok ? (r as unknown as { review: CoverReview }).review : null);
  };
  useEffect(() => {
    void load();
    return () => stopPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.contentId]);

  // 生图耗时会随中转排队波动，不能依赖固定 4 分钟轮询窗口。
  // 后台任务的终态事件到达时直接取最新 review；轮询只做断线兜底。
  useEffect(() => {
    const off = subscribeEvents((event) => {
      if (event.kind !== "engine" || event.data.contentId !== props.contentId) return;
      const eventRunId = typeof event.data.runId === "string" ? event.data.runId : "";
      if (activeRunRef.current ? eventRunId !== activeRunRef.current : !eventRunId.startsWith("run-cover-")) return;
      if (event.data.kind !== "run_done" && event.data.kind !== "run_failed") return;
      activeRunRef.current = null;
      setGenerating(false);
      stopPoll();
      void load();
      const label = typeof event.data.label === "string" ? event.data.label : "";
      toast(label || (event.data.kind === "run_done" ? "封面已更新" : "封面任务失败"));
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.contentId]);

  // 切换到别平台的稿件:主比例重置为该平台默认(公众号→2.35:1,小红书→3:4…)
  useEffect(() => {
    setRatio(coverRatiosForPlatform(props.platform)[0]);
  }, [props.platform]);

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
      if (changed || ticks > 225) {
        // 225×4s=15 分钟断线兜底；正常完成由 SSE 事件即时刷新。
        if (rv) setReview(rv);
        setGenerating(false);
        stopPoll();
        if (changed) toast("封面已更新——挑一张或继续提意见");
        else toast("封面仍未返回——可去任务动态查看排队或失败原因");
      }
    }, 4000);
  };

  const create = async () => {
    if (!identityReady) return toast("先上传至少 1 张真实照片，封面才不会把你变成另一个人");
    const payload: Record<string, unknown> = { content_id: props.contentId, ratio };
    if (customTitle.trim()) payload.custom_title = customTitle.trim();
    const r = await invoke("cover:create", payload);
    if (!r.ok) {
      const hint = (r as { hint?: string }).hint;
      return toast((r.error ?? "生成失败") + (hint ? `——${hint}` : ""));
    }
    setGenerating(true);
    activeRunRef.current = typeof r.runId === "string" ? r.runId : null;
    toast("封面设计师开工——设计方案提交后才会逐张生图,完成自动刷新");
    pollUntilChanged(review?.updatedAt);
  };

  const revise = async (label: string) => {
    const note = (feedback[label] ?? "").trim();
    if (!note) return toast("先写一句意见(如:标题太温,人物再大一点)");
    const region = maskRegions[label];
    const isLocal = Boolean(localMode[label]);
    if (isLocal && !region) return toast("先在封面图上拖动框选要修改的区域");
    const r = await invoke("cover:revise", {
      content_id: props.contentId,
      label,
      feedback: note,
      edit_mode: isLocal ? "local" : "full",
      ...(isLocal && region ? { mask_region: region } : {}),
    });
    if (!r.ok) return toast(r.error ?? "重做失败");
    setGenerating(true);
    activeRunRef.current = typeof r.runId === "string" ? r.runId : null;
    setFeedback((f) => ({ ...f, [label]: "" }));
    if (isLocal) {
      setLocalMode((current) => ({ ...current, [label]: false }));
      setMaskRegions((current) => ({ ...current, [label]: undefined }));
    }
    toast(isLocal ? "只修改框选区域，框外人物与文字保持不动…" : "按你的意见整张重做中…");
    pollUntilChanged(review?.updatedAt);
  };

  const pointInImage = (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const beginMask = (label: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!localMode[label] || generating) return;
    const point = pointInImage(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { label, startX: point.x, startY: point.y, pointerId: event.pointerId };
    setMaskRegions((current) => ({ ...current, [label]: { x: point.x, y: point.y, width: 0, height: 0 } }));
  };

  const moveMask = (label: string, event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.label !== label || drag.pointerId !== event.pointerId) return;
    const point = pointInImage(event);
    setMaskRegions((current) => ({
      ...current,
      [label]: {
        x: Math.min(drag.startX, point.x),
        y: Math.min(drag.startY, point.y),
        width: Math.abs(point.x - drag.startX),
        height: Math.abs(point.y - drag.startY),
      },
    }));
  };

  const endMask = (label: string, event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.label !== label || drag.pointerId !== event.pointerId) return;
    const point = pointInImage(event);
    const region = {
      x: Math.min(drag.startX, point.x),
      y: Math.min(drag.startY, point.y),
      width: Math.abs(point.x - drag.startX),
      height: Math.abs(point.y - drag.startY),
    };
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (region.width < 0.02 || region.height < 0.02) {
      setMaskRegions((current) => ({ ...current, [label]: undefined }));
      toast("框选范围太小，请拖出一个明确区域");
    } else {
      setMaskRegions((current) => ({ ...current, [label]: region }));
    }
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
  const primary = review?.primaryRatio ?? ratioOptions[0];
  const primaryCss = primary.replace(":", " / ");
  // 适配比例 = 该平台其余比例；个人 IP 母版锁住人物和原文字，只 outpaint 新增背景。
  const adaptRatios = ratioOptions.filter((r) => r !== primary);

  return (
    <div className="ed-section" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <IdentityLibraryPanel onReadyChange={setIdentityReady} />
      <div className="cover-create-head">
        <div>
          <div className="mono muted identity-kicker">3. 根据选题生成封面</div>
          <strong>人物、标题和内容隐喻一起设计</strong>
        </div>
      </div>
      <div className="cover-method-strip" aria-label="个人 IP 封面方法">
        <span>真实照锁脸</span>
        <span>AI 图只参考姿态</span>
        <span>局部修订不重画整张</span>
        <span>横版只延展背景</span>
      </div>
      <div className="row-actions" style={{ alignItems: "baseline" }}>
        <span className="mono muted ed-label">封面(设计师)：</span>
        {review && (
          <span className="mono muted">
            {!review.designSource
              ? "旧模板方案"
              : review.designSource === "designer"
                ? "内容驱动创意"
                : review.designSource === "hybrid"
                  ? "内容创意 + 本地补位"
                  : "本地应急创意池"}
          </span>
        )}
        <select value={ratio} disabled={generating} onChange={(e) => setRatio(e.target.value)}>
          {ratioOptions.map((v) => (
            <option key={v} value={v}>{COVER_RATIO_LABEL[v] ?? v}</option>
          ))}
        </select>
        <input
          className="sel-input"
          style={{ maxWidth: 220 }}
          placeholder="指定封面大字(可选,2-9 字)"
          value={customTitle}
          onChange={(e) => setCustomTitle(e.target.value)}
        />
        <button disabled={generating || !identityReady} onClick={() => void create()}>
          {generating
            ? "生成中…(看任务动态)"
            : review
              ? !review.designSource
                ? "用新创意引擎重出 3 张"
                : "重出 3 张新创意"
              : "生成 3 张不同创意"}
        </button>
      </div>

      {review && review.variants.length < (review.expectedVariantCount ?? 3) && (
        <div className="ed-error">
          已保留 {review.variants.length}/{review.expectedVariantCount ?? 3} 张成功封面；失败的候选没有拖累已成功结果。
          {review.generationErrors?.[0] ? ` 原因：${review.generationErrors[0]}` : ""}
        </div>
      )}

      {review && (
        <div className="cover-grid">
          {review.variants.map((v) => (
            <div key={v.label} className={"cover-card" + (review.approvedLabel === v.label ? " cover-card-on" : "")}>
              {v.imagePaths[primary] ? (
                <div
                  className={"cover-image-wrap" + (localMode[v.label] ? " cover-image-wrap-local" : "")}
                  style={{ aspectRatio: primaryCss }}
                  onPointerDown={(event) => beginMask(v.label, event)}
                  onPointerMove={(event) => moveMask(v.label, event)}
                  onPointerUp={(event) => endMask(v.label, event)}
                  onPointerCancel={() => { dragRef.current = null; }}
                >
                  <img
                    className="cover-img"
                    src={assetUrl(props.contentId, v.imagePaths[primary])}
                    alt={v.titleText ?? v.label}
                    draggable={false}
                  />
                  {localMode[v.label] && maskRegions[v.label] && (
                    <div
                      className="cover-mask-selection"
                      style={{
                        left: `${maskRegions[v.label]!.x * 100}%`,
                        top: `${maskRegions[v.label]!.y * 100}%`,
                        width: `${maskRegions[v.label]!.width * 100}%`,
                        height: `${maskRegions[v.label]!.height * 100}%`,
                      }}
                    />
                  )}
                  {localMode[v.label] && !maskRegions[v.label] && (
                    <span className="cover-mask-hint">拖动框选修改区域</span>
                  )}
                </div>
              ) : (
                <div className="cover-img cover-missing muted" style={{ aspectRatio: primaryCss }}>无图</div>
              )}
              <div>
                <b className="serif">{v.titleText ?? ""}</b>{" "}
                <span className="mono muted">
                  {v.label.toUpperCase()}·{v.style ?? ""}
                  {(v.revision ?? 1) > 1 ? `·r${v.revision}` : ""}
                  {v.hasPersonalIP ? "·身份参考" : ""}
                </span>
              </div>
              {v.creativeConcept && <div className="cover-concept"><b>创意：</b>{v.creativeConcept}</div>}
              {(v.visualMedium || v.palette) && (
                <div className="mono muted cover-meta">
                  {[v.visualMedium, v.palette].filter(Boolean).join(" · ")}
                </div>
              )}
              {v.designReason && <div className="muted cover-reason">{v.designReason}</div>}
              <div className="row-actions">
                <button className={review.approvedLabel === v.label ? "chip chip-pub" : ""} onClick={() => void approve(v.label)}>
                  {review.approvedLabel === v.label ? "✓ 已选用" : "选用"}
                </button>
                {v.imagePaths[primary] && (
                  <button
                    className={localMode[v.label] ? "chip chip-pub" : ""}
                    disabled={generating}
                    onClick={() => {
                      setLocalMode((current) => ({ ...current, [v.label]: !current[v.label] }));
                      setMaskRegions((current) => ({ ...current, [v.label]: undefined }));
                    }}
                  >
                    {localMode[v.label] ? "取消局部" : "框选局部"}
                  </button>
                )}
              </div>
              <input
                className="sel-input"
                placeholder={localMode[v.label] ? "描述框内修改→回车" : "提意见→回车整张重做"}
                value={feedback[v.label] ?? ""}
                disabled={generating}
                onChange={(e) => setFeedback((f) => ({ ...f, [v.label]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) void revise(v.label);
                }}
              />
            </div>
          ))}
        </div>
      )}

      {approved && (
        <div className="cover-ratio-strip">
          <span className="mono muted">
            比例适配({approved.hasPersonalIP ? "锁定人物与原文字，只延展新增背景" : "同创意适配"})：
          </span>
          {adaptRatios.map((r) => (
            <button key={r} disabled={ratioBusy} onClick={() => void ratios([r])}>
              {approved.imagePaths[r] ? `重出 ${COVER_RATIO_LABEL[r]}` : `出 ${COVER_RATIO_LABEL[r]}`}
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
                  alt={COVER_RATIO_LABEL[r]}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
