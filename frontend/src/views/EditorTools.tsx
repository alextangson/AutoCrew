/**
 * 稿件的控制面：采纳判定 / 发布分发 / 素材附件 / 版本记录。
 *
 * 两处用它（阶段制 spec §2）：文案页右侧抽屉（写作画布要独占整屏，这些是「需要时
 * 才滑出」的控制面），以及发布工作台的整页主体。
 *
 * 素材附件只留给文字平台：视频稿的素材挂接是剪辑的第一步，已经搬进剪辑台。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { openInEgo } from "../ego-open";
import { toast, confirmDialog } from "../ui";
import { VIDEO_PLATFORMS, isHttpUrl, needsPublishUrlBackfill, publishUrlPlatformWarning, type Content } from "../lib";
import type { VersionLike } from "../version-diff";
import { AdoptionBlock, VersionList, adoptionLabel, runPreCheck } from "./EditorToolParts";
import { AssetsSection } from "./AssetsSection";

/** 能点「我已发布,确认」的状态:clipboard / 推草稿箱 / 视频发布件三条路殊途同归 */
const CONFIRMABLE_STATUSES = new Set(["approved", "publish_ready", "publishing"]);

export interface EditorToolsProps {
  contentId: string;
  content: Content;
  versions: VersionLike[];
  dirty: boolean;
  reload: () => Promise<void>;
  send: (message: string) => Promise<{ ok: boolean; error?: string }>;
}

export function EditorTools(props: EditorToolsProps) {
  const { contentId, content: c, versions, dirty, reload, send } = props;
  const [clip, setClip] = useState<{ copyText: string; publishUrl: string; fromVideoKit?: boolean } | null>(null);
  const [digestText, setDigestText] = useState(c.digest ?? "");
  const [digestBusy, setDigestBusy] = useState(false);
  const [metrics, setMetrics] = useState({ views: "", likes: "", comments: "" });
  const [themes, setThemes] = useState<Array<{ id: string; name: string }>>([]);
  const [pubTheme, setPubTheme] = useState("");
  const [defaultTheme, setDefaultTheme] = useState<string | null>(null);
  const [preflightSummary, setPreflightSummary] = useState("");
  const [publishUrlDraft, setPublishUrlDraft] = useState("");
  const [checkBusy, setCheckBusy] = useState(false);
  const [urlBusy, setUrlBusy] = useState(false);
  const isVideo = VIDEO_PLATFORMS.has(c.platform);
  const urlWarning = publishUrlPlatformWarning(publishUrlDraft, c.platform);
  const publishedLink = c.publishUrl && isHttpUrl(c.publishUrl) ? c.publishUrl : null;

  useEffect(() => setDigestText(c.digest ?? ""), [c.digest]);
  useEffect(() => {
    // 排版主题列表(推公众号草稿时可按篇选;失败静默——选择器不出现,推送走全局默认)
    void invoke("settings:publish_get", {}).then((r) => {
      if (!r.ok) return;
      const d = (r as unknown as { data?: { themes?: Array<{ id: string; name: string }>; theme?: string | null } }).data;
      setThemes(d?.themes ?? []);
      setDefaultTheme(d?.theme ?? null);
    });
  }, []);

  const doClipboard = async () => {
    if (dirty) return toast("先保存修改，再生成发布文案");
    if (isVideo) {
      const gate = await invoke("publish:preflight", { content_id: contentId });
      const checked = gate as unknown as { ok: boolean; allPassed?: boolean; summary?: string; error?: string };
      setPreflightSummary(checked.summary ?? "");
      if (!checked.ok || !checked.allPassed) {
        return toast(checked.error ?? "发布前检查未通过；先完成封面等必做项");
      }
    }
    const r = await invoke("publish:clipboard", { content_id: contentId });
    if (!r.ok) return toast(r.error ?? "排版失败");
    setClip((r as unknown as { data: typeof clip }).data);
  };

  // 确认已发布:链接选填,非 http(s) 当场拒收(后端也拦一道);不填 = 保留稿件上已有的链接
  const confirmPublished = async () => {
    const url = publishUrlDraft.trim();
    if (url && !isHttpUrl(url)) return toast("平台链接要以 http:// 或 https:// 开头——不填也行,之后再补");
    const r = await invoke("publish:confirm", {
      content_id: contentId,
      ...(url ? { publish_url: url } : {}),
    });
    if (!r.ok) return toast(r.error ?? "确认失败");
    // 发布时刻系统会按改动量判一次采纳——当场告诉创始人判成了什么,免得它是个暗箱
    const verdict = (r as unknown as { data?: { adoption?: { verdict: string } } }).data?.adoption?.verdict;
    toast(
      "已标记为已发布——记得 T+1 回数据" +
        (verdict ? ` · 判定：${adoptionLabel(verdict)}（可在右侧改判）` : ""),
    );
    setClip(null);
    setPublishUrlDraft("");
    void reload();
  };

  // 补记链接:发完才想起来贴链接的路。走同一条 publish:confirm(已幂等——发布时刻只盖一次,
  // 这里只是把链接填上),之后回流数据能按平台作品 id 精确认领,不再赌标题没被改过。
  const backfillPublishUrl = async () => {
    const url = publishUrlDraft.trim();
    if (!isHttpUrl(url)) return toast("平台链接要以 http:// 或 https:// 开头");
    setUrlBusy(true);
    try {
      const r = await invoke("publish:confirm", { content_id: contentId, publish_url: url });
      if (!r.ok) return toast(r.error ?? "补记失败");
      const bound = (r as unknown as { data?: { boundItemId?: string | null } }).data?.boundItemId;
      setPublishUrlDraft("");
      toast(bound ? "链接已补记——回流数据会按平台作品 id 认领" : "链接已补记(这个链接解析不出作品 id,回流仍按标题认领)");
      void reload();
    } finally {
      setUrlBusy(false);
    }
  };

  const doPreCheck = async () => {
    if (dirty) return toast("先保存修改，再做发布前检查");
    setCheckBusy(true);
    try { await runPreCheck(contentId, reload); } finally { setCheckBusy(false); }
  };

  const pushWechat = async () => {
    if (dirty) return toast("先保存修改，再推送到公众号草稿箱");
    const yes = await confirmDialog({
      title: "推送到公众号草稿箱?",
      body: "会复用你在「正文配图」里已经确认的图片并调用发布脚本；只进草稿箱，最后群发仍由你在公众号后台确认。",
      confirmLabel: "推送",
    });
    if (!yes) return;
    const approval = await invoke("publish:request_wechat", { content_id: contentId });
    if (!approval.ok || typeof approval.approvalToken !== "string") {
      return toast(approval.error ?? "发布前检查未通过");
    }
    toast("推送中——正在复用正文配图并排版,完成后看提示");
    const r = await invoke("publish:wechat_draft", {
      content_id: contentId,
      approval_token: approval.approvalToken,
      ...(pubTheme ? { theme: pubTheme } : {}),
    });
    if (!r.ok) return toast(r.error ?? "推送失败");
    toast("已进草稿箱:" + ((r as { nextStep?: string }).nextStep ?? "去公众号后台检查"));
  };

  return (
    <div className="ed-publishing-tools">
      <AdoptionBlock contentId={contentId} content={c} reload={reload} />

      <details className="ed-tools" open>
        <summary>发布准备</summary>
        {dirty && <p className="ed-tool-notice">先保存正文修改，再准备发布材料。</p>}
        <div className="ed-tool-actions">
          <button className="ed-tool-action" disabled={dirty} onClick={() => void doClipboard()}>
            <strong>生成发布文案</strong><span>整理成可复制到平台的发布内容</span>
          </button>
          {isVideo && <button className="ed-tool-action" disabled={dirty} onClick={() => void send(`给稿件 ${contentId} 备视频发布件(平台标题+发布文案+分镜+封面)`).then((receipt) => {
            toast(receipt.ok ? "视频发布包任务已受理，请在总编辑对话中查看" : (receipt.error ?? "派活失败"));
          })}>
            <strong>{c.videoKit ? "重新准备视频发布包" : "准备视频发布包"}</strong>
            <span>包含平台标题、文案、分镜与封面</span>
          </button>}
          <button className="ed-tool-action" disabled={checkBusy || dirty} onClick={() => void doPreCheck()}>
            <strong>{checkBusy ? "检查中…" : "发布前检查"}</strong><span>检查内容、素材与当前发布条件</span>
          </button>
        </div>
        <div className="ed-publish-settings">
          {c.platform === "wechat_mp" && themes.length > 0 && (
            <div className="ed-digest">
              <label htmlFor={`publish-theme-${contentId}`}>公众号排版主题</label>
              <select id={`publish-theme-${contentId}`} className="sel-input" value={pubTheme} onChange={(e) => setPubTheme(e.target.value)}>
                <option value="">跟随全局设置({defaultTheme || "newspaper"})</option>
                {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {c.platform === "wechat_mp" && (
            <div className="ed-digest">
              <label htmlFor={`publish-digest-${contentId}`}>公众号摘要</label>
              <span className="muted">显示在分享卡和文章列表中，建议 20 字以内。</span>
              <input
                id={`publish-digest-${contentId}`}
                className="sel-input"
                maxLength={30}
                value={digestText}
                placeholder="一句话概括这篇内容"
                onChange={(e) => setDigestText(e.target.value)}
              />
              <div className="row-actions">
                <span className="mono muted">{digestText.length}/20</span>
                <button
                  disabled={digestBusy}
                  onClick={async () => {
                    setDigestBusy(true);
                    try {
                      const r = await invoke("publish:digest", { content_id: contentId });
                      if (!r.ok) { toast(r.error ?? "生成摘要失败"); return; }
                      setDigestText(((r as { data?: { digest?: string } }).data?.digest) ?? "");
                      toast("摘要已生成并保存");
                    } finally { setDigestBusy(false); }
                  }}
                >{digestBusy ? "生成中…" : "AI 生成摘要"}</button>
                <button
                  disabled={digestText.trim() === (c.digest ?? "")}
                  onClick={async () => {
                    const r = await invoke("publish:digest", { content_id: contentId, digest: digestText.trim() });
                    toast(r.ok ? "摘要已保存" : (r.error ?? "保存失败"));
                    if (r.ok) void reload();
                  }}
                >保存摘要</button>
              </div>
            </div>
          )}
        </div>
        {c.platform === "wechat_mp" && <div className="ed-publish-delivery">
          <button disabled={dirty} onClick={() => void pushWechat()}>推送到公众号草稿箱</button>
          <span className="muted">推送前会再次确认，最终群发在公众号后台完成。</span>
        </div>}
        {/* 发布前检查明细:由「排版发布文案」触发,结果留在发布区里 */}
        {preflightSummary && <pre className="publish-preflight mono">{preflightSummary}</pre>}
      </details>

      {clip && (
        <div className="pending-edit">
          <div className="mono muted">发布文案{clip.fromVideoKit ? "(来自发布件)" : ""} · 复制后到平台粘贴</div>
          <pre className="ccard-body">{clip.copyText}</pre>
          <div className="row-actions">
            <button
              className="primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(clip.copyText);
                  toast("已复制到剪贴板");
                } catch {
                  toast("剪贴板写入失败,请手动复制");
                }
              }}
            >复制发布文案</button>
            {/* 发布走 ego lite（登录态在那里）：在 ego lite 里开发布页，不开默认浏览器 */}
            <button onClick={() => void openInEgo(c.platform, "publish")}>在 ego lite 打开平台后台</button>
          </div>
        </div>
      )}

      {/* 确认区块不跟着「排版发布文案」走:推草稿箱、视频发布件、直接去平台发,都要能确认 */}
      {/* 视频稿的「发了」收敛到看板卡片的「我发了」（看板规格 §25），这里只留给图文 */}
      {CONFIRMABLE_STATUSES.has(c.status) && !VIDEO_PLATFORMS.has(c.platform) && (
        <div className="pending-edit">
          <div className="mono muted">发完了就回来点确认——回流数据靠它认领</div>
          <div className="ed-digest">
            <span className="mono muted">平台链接(发布后的视频/笔记地址,选填)</span>
            <input
              className="sel-input"
              value={publishUrlDraft}
              placeholder="https://…（不填也可以）"
              onChange={(e) => setPublishUrlDraft(e.target.value)}
            />
            {urlWarning && <span className="muted">{urlWarning}</span>}
          </div>
          <div className="row-actions">
            <button className="primary" onClick={() => void confirmPublished()}>确认已在平台发布</button>
          </div>
        </div>
      )}

      {c.status === "published" && publishedLink && (
        <div className="ed-section">
          <span className="mono muted">平台链接：</span>
          <a href={publishedLink} target="_blank" rel="noreferrer">{publishedLink}</a>
        </div>
      )}

      {/* 已发布但没链接:补记入口。有链接的稿子不出现这块——它的活儿已经干完了 */}
      {needsPublishUrlBackfill(c) && (
        <div className="pending-edit">
          <div className="mono muted">没记链接 · 回流数据只能靠标题+发布时间认领,可能对不准</div>
          <div className="ed-digest">
            <span className="mono muted">补记平台链接(发布后的视频/笔记地址)</span>
            <input
              className="sel-input"
              value={publishUrlDraft}
              placeholder="https://…"
              onChange={(e) => setPublishUrlDraft(e.target.value)}
            />
            {urlWarning && <span className="muted">{urlWarning}</span>}
          </div>
          <div className="row-actions">
            <button
              className="primary"
              disabled={urlBusy || !publishUrlDraft.trim()}
              onClick={() => void backfillPublishUrl()}
            >{urlBusy ? "保存中…" : "补记链接"}</button>
          </div>
        </div>
      )}

      {c.status === "published" && (
        <div className="ed-section">
          <span className="mono muted">回流数据：</span>
          {(["views", "likes", "comments"] as const).map((k) => (
            <input
              key={k}
              className="bf-input"
              type="number"
              placeholder={{ views: "阅读/播放", likes: "点赞", comments: "评论" }[k]}
              value={metrics[k]}
              onChange={(e) => setMetrics((m) => ({ ...m, [k]: e.target.value }))}
            />
          ))}
          <button
            onClick={async () => {
              const m: Record<string, number> = {};
              for (const [k, v] of Object.entries(metrics)) if (v !== "") m[k] = Number(v);
              if (Object.keys(m).length === 0) return toast("至少填一个数字");
              const r = await invoke("flywheel:record", { content_id: contentId, metrics: m });
              toast(r.ok ? "已回填 ✓ 数据分析师归档" : (r.error ?? "回填失败"));
              if (r.ok) void reload();
            }}
          >记录回流</button>
        </div>
      )}

      {/* 视频稿的素材挂接在剪辑台（阶段制 spec §2）；这里只服务文字平台的配图与附件 */}
      {!isVideo && (
        <details className="ed-tools">
          <summary>配图与附件</summary>
          <AssetsSection contentId={contentId} assets={c.assets ?? []} reload={reload} />
        </details>
      )}

      <VersionList contentId={contentId} versions={versions} dirty={dirty} reload={reload} />
    </div>
  );
}
