import { useEffect, useRef, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { confirmDialog, toast } from "../ui";

interface ArticleImageEntry {
  id: string;
  index: number;
  sourcePrompt: string;
  prompt: string;
  section?: string;
  status: "missing" | "generating" | "ready" | "error";
  revision: number;
  imagePath?: string;
  error?: string;
  origin?: "generated" | "uploaded";
}

interface ArticleImageReview {
  contentId: string;
  entries: ArticleImageEntry[];
  updatedAt: string;
}

const imageUrl = (contentId: string, filePath?: string): string => {
  if (!filePath) return "";
  const name = filePath.split("/").pop() ?? "";
  return `/api/asset?kind=article&content_id=${encodeURIComponent(contentId)}&name=${encodeURIComponent(name)}`;
};

const STATUS_LABEL: Record<ArticleImageEntry["status"], string> = {
  missing: "待生成",
  generating: "生成中",
  ready: "已生成",
  error: "失败",
};

export function ArticleImagesPanel(props: { contentId: string; dirty: boolean; body: string; platform?: string }) {
  const [review, setReview] = useState<ArticleImageReview | null>(null);
  const [prompts, setPrompts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const activeRunRef = useRef<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const startedStampRef = useRef<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadIndexRef = useRef(0);

  const stopPoll = () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const load = async (): Promise<ArticleImageReview | null> => {
    const result = await invoke("article_images:get", { content_id: props.contentId });
    if (!result.ok) {
      toast(result.error ?? "正文配图加载失败");
      return null;
    }
    const next = (result as unknown as { data: ArticleImageReview }).data;
    setReview(next);
    setPrompts(Object.fromEntries(next.entries.map((entry) => [entry.index, entry.prompt])));
    return next;
  };

  useEffect(() => {
    void load();
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.contentId]);

  useEffect(() => {
    const off = subscribeEvents((event) => {
      if (event.kind !== "engine" || event.data.contentId !== props.contentId) return;
      if (!activeRunRef.current || event.data.runId !== activeRunRef.current) return;
      if (event.data.kind !== "run_done" && event.data.kind !== "run_failed") return;
      setBusy(false);
      activeRunRef.current = null;
      stopPoll();
      void load();
      toast(typeof event.data.label === "string" ? event.data.label : "正文配图任务已结束");
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.contentId]);

  const startPoll = () => {
    stopPoll();
    let ticks = 0;
    pollRef.current = window.setInterval(async () => {
      ticks += 1;
      const next = await load();
      const changed = next && next.updatedAt !== startedStampRef.current;
      const settled = next && next.entries.every((entry) => entry.status !== "generating");
      if ((changed && settled) || ticks > 225) {
        setBusy(false);
        activeRunRef.current = null;
        stopPoll();
        if (ticks > 225) toast("正文配图仍未返回——请到任务动态查看排队状态");
      }
    }, 4000);
  };

  const begin = async (index?: number) => {
    if (props.dirty) return toast("正文有未保存改动——先保存，再按最新稿件生成配图");
    const channel = index === undefined ? "article_images:generate" : "article_images:regenerate";
    const payload: Record<string, unknown> = { content_id: props.contentId };
    if (index !== undefined) {
      const prompt = (prompts[index] ?? "").trim();
      if (!prompt) return toast("配图提示词不能为空");
      payload.index = index;
      payload.prompt = prompt;
    }
    const result = await invoke(channel, payload);
    if (!result.ok) return toast(result.error ?? "正文配图任务启动失败");
    setBusy(true);
    activeRunRef.current = typeof result.runId === "string" ? result.runId : null;
    startedStampRef.current = review?.updatedAt;
    toast(index === undefined ? "开始生成缺失配图——完成后会自动出现" : `开始重做配图 ${index + 1}`);
    startPoll();
  };

  const suggest = async () => {
    if (props.dirty) return toast("正文有未保存改动——先保存,再让 AI 选位");
    setBusy(true);
    const result = await invoke("article_images:suggest", { content_id: props.contentId });
    setBusy(false);
    if (!result.ok) return toast((result as { error?: string }).error ?? "AI 选位失败");
    const added = (result as { data?: { added?: number } }).data?.added ?? 0;
    toast(added > 0 ? `AI 选好 ${added} 处插图位置——已存为新版本` : "AI 判断本文无需新增插图位置——正文未改动");
    void load();
  };

  const addSlot = async () => {
    if (props.dirty) return toast("正文有未保存改动——先保存,再加位");
    const result = await invoke("article_images:add_slot", { content_id: props.contentId });
    if (!result.ok) return toast((result as { error?: string }).error ?? "加位失败");
    toast("已在正文末尾加一个插图位——可在正文里把标记移到合适段落");
    void load();
  };

  const upload = async (index: number, file: File) => {
    if (file.size > 5 * 1024 * 1024) return toast("图片超过 5MB 上限，请压缩后再传");
    if (props.platform === "wechat_mp" && file.size > 1024 * 1024) {
      toast("提醒：公众号正文图限 1MB，这张较大，推送时可能被拒——建议先压缩");
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
      reader.readAsDataURL(file);
    }).catch(() => "");
    if (!dataUrl) return toast("读取文件失败，请重试");
    const result = await invoke("article_images:upload", {
      content_id: props.contentId,
      index,
      data_base64: dataUrl.replace(/^data:[^;]*;base64,/, ""),
    });
    if (!result.ok) return toast((result as { error?: string }).error ?? "上传失败");
    toast(`配图 ${index + 1} 已换成你上传的图`);
    void load();
  };

  const removeSlot = async (index: number) => {
    if (props.dirty) return toast("正文有未保存改动——先保存,再删位");
    const yes = await confirmDialog({
      title: `删除插图位 ${index + 1}?`,
      body: "从正文里移除这个 [IMAGE:] 标记(以及已生成的图),存为新版本。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!yes) return;
    const result = await invoke("article_images:remove_slot", { content_id: props.contentId, index });
    if (!result.ok) return toast((result as { error?: string }).error ?? "删位失败");
    toast("已删除该插图位");
    void load();
  };

  if (!review) return <p className="muted">正在读取正文插图位置…</p>;
  if (review.entries.length === 0) {
    return (
      <div className="article-images-empty">
        <p>正文里还没有插图位置。</p>
        <div className="row-actions">
          <button className="primary" disabled={busy || props.dirty} onClick={() => void suggest()}>
            {busy ? "AI 选位中…" : "让 AI 选插图位置"}
          </button>
          <button disabled={busy || props.dirty} onClick={() => void addSlot()}>＋手动加一个位置</button>
        </div>
        <p className="mono muted">或在正文里插入：[IMAGE: 具体场景、主体、构图、光线、色彩；不要文字和水印]</p>
      </div>
    );
  }

  const ready = review.entries.filter((entry) => entry.status === "ready").length;
  const missing = review.entries.some((entry) => entry.status !== "ready");

  // 位置提示:第 index 个 [IMAGE:] 标记前面那段正文的结尾,让你一眼看到这张插在哪
  const markers = [...props.body.matchAll(/\[IMAGE:\s*(.+?)\]/g)];
  const posHint = (index: number): string => {
    const m = markers[index];
    if (!m || m.index === undefined) return "";
    const before = props.body.slice(0, m.index).replace(/\[IMAGE:[^\]]*\]/g, "").replace(/[\s#>*\-—·]+$/g, "");
    return before.slice(-22).trim();
  };

  return (
    <div className="article-images-panel">
      <div className="article-images-head">
        <span className="mono muted">已准备 {ready}/{review.entries.length} · 发布时按正文顺序插入</span>
        <div className="row-actions">
          <button disabled={busy || props.dirty} onClick={() => void suggest()}>{busy ? "AI 选位中…" : "让 AI 选插图位置"}</button>
          <button disabled={busy || props.dirty} onClick={() => void addSlot()}>＋加位</button>
          <button className="primary" disabled={busy || props.dirty || !missing} onClick={() => void begin()}>
            {busy ? "生成中…" : missing ? "生成全部缺失配图" : "✓ 配图已齐"}
          </button>
        </div>
      </div>
      {props.dirty && <div className="ed-error">正文有未保存改动。请先保存，配图位置和发布稿才不会错位。</div>}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(uploadIndexRef.current, file);
        }}
      />

      <div className="article-images-grid">
        {review.entries.map((entry) => (
          <article key={entry.id} className="article-image-card">
            <div className="article-image-card-head">
              <strong>配图 {entry.index + 1}</strong>
              {posHint(entry.index) || entry.section ? (
                <span className="muted">接在「…{posHint(entry.index) || entry.section}」后面</span>
              ) : (
                <span className="muted">正文里没找到对应标记</span>
              )}
              <span className={`chip article-image-status-${entry.status}`}>
                {entry.origin === "uploaded" && entry.status === "ready" ? "自己上传" : STATUS_LABEL[entry.status]}
              </span>
            </div>
            {entry.imagePath ? (
              <img src={imageUrl(props.contentId, entry.imagePath)} alt={`正文配图 ${entry.index + 1}`} />
            ) : (
              <div className="article-image-placeholder muted">
                {entry.status === "generating" ? "正在生成图片…" : "尚无图片"}
              </div>
            )}
            <label>
              <span className="mono muted">画面提示词（可改后单张重做）</span>
              <textarea
                value={prompts[entry.index] ?? entry.prompt}
                disabled={busy || props.dirty}
                onChange={(event) => setPrompts((current) => ({ ...current, [entry.index]: event.target.value }))}
              />
            </label>
            {entry.error && <div className="acard-err">{entry.error}</div>}
            <div className="row-actions">
              <button disabled={busy || props.dirty} onClick={() => void begin(entry.index)}>
                {entry.status === "ready" ? "按此提示重做" : "生成这一张"}
              </button>
              <button
                disabled={busy || entry.status === "generating"}
                onClick={() => {
                  uploadIndexRef.current = entry.index;
                  fileInputRef.current?.click();
                }}
              >
                用自己的图
              </button>
              {entry.imagePath && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    const yes = await confirmDialog({
                      title: `移除正文配图 ${entry.index + 1}?`,
                      body: "只移除这张生成图，正文插图位置和提示词会保留，可随时重做。",
                      confirmLabel: "移除",
                      danger: true,
                    });
                    if (!yes) return;
                    const result = await invoke("article_images:remove", { content_id: props.contentId, index: entry.index });
                    toast(result.ok ? "已移除，插图位置仍保留" : (result.error ?? "移除失败"));
                    if (result.ok) void load();
                  }}
                >
                  移除图片
                </button>
              )}
              <button disabled={busy || props.dirty} onClick={() => void removeSlot(entry.index)}>删除此位置</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
