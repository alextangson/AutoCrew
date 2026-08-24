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
import { toast, confirmDialog } from "../ui";
import { VIDEO_PLATFORMS, isHttpUrl, needsPublishUrlBackfill, publishUrlPlatformWarning, type Content } from "../lib";
import { compareVersions, isGenericVersionNote, type VersionLike } from "../version-diff";
import { AssetsSection } from "./AssetsSection";

/** 能点「我已发布,确认」的状态:clipboard / 推草稿箱 / 视频发布件三条路殊途同归 */
const CONFIRMABLE_STATUSES = new Set(["approved", "publish_ready", "publishing"]);

/** 存量版本备注是英文自动串(V5.6.2 起后端已改中文)——显示层兜底汉化 */
function versionNoteLabel(note?: string): string {
  if (!note) return "";
  if (note === "Initial draft") return "初稿";
  const edit = note.match(/^Edit v(\d+)$/);
  if (edit) return `第 ${edit[1]} 版`;
  const revert = note.match(/^Reverted to v(\d+)$/);
  if (revert) return `回滚到 v${revert[1]}`;
  return note;
}

const ADOPT: Array<[string, string]> = [
  ["adopted", "直接能用"],
  ["light_edit", "小改后能用"],
  ["rewritten", "基本要重写"],
];

const ADOPT_LABEL = new Map(ADOPT);

function adoptionLabel(verdict?: string): string {
  return (verdict && ADOPT_LABEL.get(verdict)) || verdict || "";
}

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
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);
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
  const [rejudging, setRejudging] = useState(false);
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

  // 改判:只发 verdict(reason/reason_note 通道保留给 MCP,界面不再问原因)。
  // recordAdoption 整条覆盖 → 系统推导的 derived 标记自然消失,改判后就是人给的裁决。
  const submitAdoption = async (verdict: string) => {
    const r = await invoke("content:adoption", { id: contentId, verdict });
    if (!r.ok) return toast(r.error ?? "记录失败");
    const stats = (r as { stats?: { rate: number | null; judged: number; adopted: number; lightEdit: number } }).stats;
    toast(
      "已按你的判定更正——团队会据此学习你的标准" +
        (stats && stats.rate !== null && stats.judged > 0
          ? ` · 可用率 ${Math.round(stats.rate * 100)}%（${stats.adopted + stats.lightEdit}/${stats.judged}）`
          : ""),
    );
    setRejudging(false);
    void reload();
  };

  const doClipboard = async () => {
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

  // 发布前检查:六项内容检查 + 阶段门。还没到「待发布」的稿子全过会被后端顺手推进去;
  // 被阶段门拦下时结果里有「卡在阶段门」那一条,照样报出来,绝不谎报全过
  const runPreCheck = async () => {
    setCheckBusy(true);
    try {
      const r = await invoke("publish:pre_check", { content_id: contentId });
      if (!r.ok) return toast(r.error ?? "发布前检查没跑起来");
      const d = r as unknown as { allPassed?: boolean; checks?: Array<{ name: string; status: string; detail: string }> };
      if (d.allPassed) {
        toast("检查全过——可以去平台发了,发完回来点确认");
        void reload();
        return;
      }
      // 报出具体挂在哪一项:只说「未通过」用户不知道改什么,发布流程就成死胡同
      const fails = (d.checks ?? [])
        .filter((x) => x.status === "fail")
        .map((x) => `${x.name}:${x.detail.replace(/\s+/g, " ").trim()}`)
        .join("；");
      toast(fails ? `发布前检查未过——${fails.slice(0, 200)}` : "发布前检查未过");
    } finally {
      setCheckBusy(false);
    }
  };

  const pushWechat = async () => {
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
    <>
      {/* 采纳判定:发布确认时由系统按改动量自动判一次,这里只做展示 + 改判入口 */}
      {c.adoption && (
        <div className="ed-section adoption-verdict">
          <span className="mono muted">
            采纳判定：{adoptionLabel(c.adoption.verdict)}
            {c.adoption.derived ? "（系统按改动量判定）" : ""}
          </span>
          <button onClick={() => setRejudging((v) => !v)}>{rejudging ? "收起" : "改判"}</button>
          {rejudging &&
            ADOPT.map(([v, label]) => (
              <button
                key={v}
                className={c.adoption?.verdict === v ? "chip chip-pub" : ""}
                onClick={() => void submitAdoption(v)}
              >
                {c.adoption?.verdict === v ? "✓ " : ""}{label}
              </button>
            ))}
        </div>
      )}

      <details className="ed-tools" open>
        <summary>发布与分发</summary>
        <div className="ed-section">
          <button onClick={() => void doClipboard()}>排版发布文案</button>
          {c.platform === "wechat_mp" && themes.length > 0 && (
            <div className="ed-digest">
              <span className="mono muted">排版主题(推草稿时生效)</span>
              <select className="sel-input" value={pubTheme} onChange={(e) => setPubTheme(e.target.value)}>
                <option value="">跟随全局设置({defaultTheme || "newspaper"})</option>
                {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {c.platform === "wechat_mp" && <button onClick={() => void pushWechat()}>推公众号草稿箱</button>}
          {c.platform === "wechat_mp" && (
            <div className="ed-digest">
              <span className="mono muted">公众号摘要(≤20 字·分享卡/列表标题下显示;留空微信自动截正文前 54 字)</span>
              <input
                className="sel-input"
                maxLength={30}
                value={digestText}
                placeholder="一句钩子,≤20 字"
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
                >{digestBusy ? "生成中…" : "AI 生成"}</button>
                <button
                  disabled={digestText.trim() === (c.digest ?? "")}
                  onClick={async () => {
                    const r = await invoke("publish:digest", { content_id: contentId, digest: digestText.trim() });
                    toast(r.ok ? "摘要已保存" : (r.error ?? "保存失败"));
                    if (r.ok) void reload();
                  }}
                >保存</button>
              </div>
            </div>
          )}
          {isVideo && (
            <button onClick={() => void send(`给稿件 ${contentId} 备视频发布件(平台标题+发布文案+分镜+封面)`).then((receipt) => {
              toast(receipt.ok ? "发布件任务已受理——看总编辑对话" : (receipt.error ?? "派活失败"));
            })}>
              备视频发布件{c.videoKit ? "(已有,重新生成)" : ""}
            </button>
          )}
        </div>
        {/* 发布前检查明细:由「排版发布文案」触发,结果留在发布区里 */}
        {preflightSummary && <pre className="publish-preflight mono">{preflightSummary}</pre>}
      </details>

      {/* 预检是发布台的活:阶段推进归顶栏推进按钮,这里只回答「这篇现在能不能发」 */}
      <div className="ed-section">
        <button disabled={checkBusy} onClick={() => void runPreCheck()}>
          {checkBusy ? "检查中…" : "跑发布前检查"}
        </button>
      </div>

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
            >复制</button>
            <a href={clip.publishUrl} target="_blank" rel="noreferrer"><button>打开平台后台 ↗</button></a>
          </div>
        </div>
      )}

      {/* 确认区块不跟着「排版发布文案」走:推草稿箱、视频发布件、直接去平台发,都要能确认 */}
      {CONFIRMABLE_STATUSES.has(c.status) && (
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
            <button className="primary" onClick={() => void confirmPublished()}>我已发布,确认</button>
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
          <summary>素材附件</summary>
          <AssetsSection contentId={contentId} assets={c.assets ?? []} reload={reload} />
        </details>
      )}

      {versions.length > 0 && (
        <details className="ed-tools ed-version-tools">
          <summary>版本记录 · {versions.length} 版</summary>
          <div className="ed-versions">
            <div className="ed-version-head">
              <span className="mono muted">共 {versions.length} 版 · 每次保存都会记录修改说明</span>
            </div>
            {[...versions].reverse().slice(0, 8).map((v) => {
              const previous = versions.find((item) => item.version === v.version - 1);
              const diff = compareVersions(previous, v);
              const note = isGenericVersionNote(v.note) ? diff.summary : versionNoteLabel(v.note);
              const expanded = expandedVersion === v.version;
              return (
                <div key={v.version} className="ed-version-card">
                  <div className="ed-version-row">
                    <span className="mono ed-version-number">v{v.version}</span>
                    <div className="ed-version-main">
                      <strong>{note}</strong>
                      {!isGenericVersionNote(v.note) && <span className="muted">{diff.summary}</span>}
                      <span className="mono muted">{new Date(v.savedAt).toLocaleString("zh-CN", { hour12: false })}</span>
                    </div>
                    {v.version > 1 && (
                      <button onClick={() => setExpandedVersion(expanded ? null : v.version)}>
                        {expanded ? "收起差异" : "查看差异"}
                      </button>
                    )}
                    {v.version !== versions.length && (
                      <button
                        onClick={async () => {
                          if (dirty) return toast("有未保存的改动——先保存再回滚");
                          const r = await invoke("content:revert", { id: contentId, version: v.version });
                          toast(r.ok ? `已回滚到 v${v.version}(生成新版本快照)` : (r.error ?? "回滚失败"));
                          if (r.ok) void reload();
                        }}
                      >回滚</button>
                    )}
                  </div>
                  {expanded && (
                    <div className="ed-version-diff">
                      {diff.titleChanged && previous?.title && v.title && (
                        <div><span className="diff-del">− {previous.title}</span><span className="diff-add">＋ {v.title}</span></div>
                      )}
                      {diff.removed.slice(0, 6).map((text, index) => <p key={`del-${index}`} className="diff-del">− {text}</p>)}
                      {diff.added.slice(0, 6).map((text, index) => <p key={`add-${index}`} className="diff-add">＋ {text}</p>)}
                      {!diff.titleChanged && diff.removed.length === 0 && diff.added.length === 0 && (
                        <p className="muted">与上一版正文一致。</p>
                      )}
                      {(diff.removed.length > 6 || diff.added.length > 6) && <p className="mono muted">仅展示前 6 处差异。</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}
    </>
  );
}
