/**
 * 编辑页右侧抽屉：采纳裁决 / 发布分发 / 素材附件 / 版本记录。
 * 从 Editor.tsx 抽出来——写作画布要独占整屏，这些是「需要时才滑出」的控制面，
 * 不该常驻挤占版心，也不该让 Editor.tsx 继续膨胀。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast, confirmDialog } from "../ui";
import { VIDEO_PLATFORMS, isHttpUrl, needsPublishUrlBackfill, publishUrlPlatformWarning, type Content } from "../lib";
import { compareVersions, isGenericVersionNote, type VersionLike } from "../version-diff";

/** 能点「我已发布,确认」的状态:clipboard / 推草稿箱 / 视频发布件三条路殊途同归 */
const CONFIRMABLE_STATUSES = new Set(["approved", "publish_ready", "publishing"]);

/** 已经进了发布流程(或已退场)的状态:成片就绪的 CTA 到此为止 */
const PUBLISH_TRACK_STATUSES = new Set(["approved", "publish_ready", "publishing", "published", "archived"]);

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

  const submitAdoption = async (verdict: string, reason?: string, reasonNote?: string) => {
    const payload: Record<string, unknown> = { id: contentId, verdict };
    if (reason) payload.reason = reason;
    if (reasonNote) payload.reason_note = reasonNote;
    const r = await invoke("content:adoption", payload);
    if (!r.ok) return toast(r.error ?? "记录失败");
    const stats = (r as { stats?: { rate: number | null; judged: number; adopted: number; lightEdit: number } }).stats;
    toast(
      "反馈已记录——团队会据此学习你的标准" +
        (stats && stats.rate !== null && stats.judged > 0
          ? ` · 可用率 ${Math.round(stats.rate * 100)}%（${stats.adopted + stats.lightEdit}/${stats.judged}）`
          : ""),
    );
    void reload();
  };

  const doClipboard = async () => {
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
    toast(r.ok ? "已标记为已发布——记得 T+1 回数据" : (r.error ?? "确认失败"));
    if (r.ok) { setClip(null); setPublishUrlDraft(""); void reload(); }
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

  // 成片就绪 → 发布线的唯一入口:跑发布前检查,全过由后端自动流转「待发布」,不新造状态路径
  const runPreCheck = async () => {
    setCheckBusy(true);
    try {
      const r = await invoke("publish:pre_check", { content_id: contentId });
      if (!r.ok) return toast(r.error ?? "发布前检查没跑起来");
      const d = r as unknown as { allPassed?: boolean; checks?: Array<{ name: string; status: string; detail: string }> };
      if (d.allPassed) {
        toast("检查全过——这篇已进「待发布」,发完回来点确认");
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
      <details className="ed-tools" open>
        <summary>这篇稿子好不好用？{c.adoption?.verdict ? ` · ${ADOPT.find(([v]) => v === c.adoption?.verdict)?.[1] ?? "已反馈"}` : ""}</summary>
        <p className="muted adoption-guide">
          成稿后选一次：它只会告诉编辑部这版是否达到你的标准，用来改进后续写作；不会自动改正文，也不会发布。
        </p>
        <div className="ed-section">
          {ADOPT.map(([v, label]) => (
            <AdoptButton key={v} verdict={v} label={label} current={c.adoption?.verdict} submit={submitAdoption} />
          ))}
        </div>
      </details>

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
      </details>

      {c.videoReadyAt && !PUBLISH_TRACK_STATUSES.has(c.status) && (
        <div className="pending-edit">
          <div className="mono muted">成片已就绪 · 还没进发布流程</div>
          <p className="muted">片子渲染并审过了。跑一遍发布前检查,全过就进「待发布」,再去平台发。</p>
          <div className="row-actions">
            <button className="primary" disabled={checkBusy} onClick={() => void runPreCheck()}>
              {checkBusy ? "检查中…" : "进入发布检查"}
            </button>
          </div>
        </div>
      )}

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

      <details className="ed-tools">
        <summary>素材附件</summary>
        <AssetsSection
          contentId={contentId}
          assets={(c as unknown as { assets?: Array<{ filename: string; type: string; description?: string }> }).assets ?? []}
          reload={reload}
        />
      </details>

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

function AdoptButton(props: {
  verdict: string;
  label: string;
  current?: string;
  submit: (verdict: string, reason?: string, reasonNote?: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [noteText, setNoteText] = useState("");
  const isCurrent = props.current === props.verdict;
  if (props.verdict !== "rewritten") {
    return (
      <button className={isCurrent ? "chip chip-pub" : ""} onClick={() => void props.submit(props.verdict)}>
        {isCurrent ? "✓ " : ""}{props.label}
      </button>
    );
  }
  return (
    <span className="adopt-rw">
      <button className={isCurrent ? "chip chip-pub" : ""} onClick={() => setAsking((a) => !a)}>
        {isCurrent ? "✓ " : ""}{props.label}
      </button>
      {asking && (
        <span className="adopt-reasons">
          {([["style_mismatch", "风格不像"], ["factual_error", "有事实错误"], ["structure_bad", "结构不好"]] as const).map(([v, txt]) => (
            <button key={v} onClick={() => { setAsking(false); void props.submit("rewritten", v); }}>{txt}</button>
          ))}
          <input
            className="sel-input"
            placeholder="或写一句主要问题，回车记录"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && noteText.trim()) {
                setAsking(false);
                void props.submit("rewritten", undefined, noteText.trim());
              }
            }}
          />
          <button onClick={() => { setAsking(false); void props.submit("rewritten"); }}>只记录结果</button>
        </span>
      )}
    </span>
  );
}

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

type LibraryPick = { id: string; name: string; type: string; tags?: string[]; description?: string; missing?: boolean };

function AssetsSection(props: {
  contentId: string;
  assets: Array<{ filename: string; type: string; description?: string; role?: string }>;
  reload: () => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const [lib, setLib] = useState<LibraryPick[]>([]);
  const [chosen, setChosen] = useState<LibraryPick | null>(null);
  const [role, setRole] = useState("other");
  const [note, setNote] = useState("");

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
