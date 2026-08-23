import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { confirmDialog, toast } from "../ui";

interface IdentityAsset {
  filename: string;
  kind: "source" | "generated";
  label: string;
  createdAt: string;
  primary: boolean;
  selected: boolean;
}

interface IdentityLibrary {
  sources: IdentityAsset[];
  generated: IdentityAsset[];
  recommendedSourceCount: number;
  maxSelectedGenerated: number;
}

const identityAssetUrl = (asset: IdentityAsset): string =>
  `/api/cover-identity-asset?kind=${encodeURIComponent(asset.kind)}&name=${encodeURIComponent(asset.filename)}`;

async function resizedDataUrl(file: File): Promise<string> {
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const maxDimension = 1800;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理图片");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function IdentityLibraryPanel(props: { onReadyChange?: (ready: boolean) => void }) {
  const [library, setLibrary] = useState<IdentityLibrary | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRunRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const result = await invoke("cover:identity", { action: "get" });
    if (!result.ok) return toast(result.error ?? "个人形象库读取失败");
    const next = (result as unknown as { data: IdentityLibrary }).data;
    setLibrary(next);
    props.onReadyChange?.(next.sources.length > 0);
  }, [props.onReadyChange]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      subscribeEvents((event) => {
        if (event.kind !== "engine" || event.data.contentId !== "cover-identity") return;
        const runId = typeof event.data.runId === "string" ? event.data.runId : "";
        if (activeRunRef.current && activeRunRef.current !== runId) return;
        if (event.data.kind !== "run_done" && event.data.kind !== "run_failed") return;
        activeRunRef.current = null;
        setGenerating(false);
        void load();
        toast(typeof event.data.label === "string" ? event.data.label : "个人形象备选已更新");
      }),
    [load],
  );

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files).slice(0, 5)) {
        let dataBase64: string;
        try {
          dataBase64 = await resizedDataUrl(file);
        } catch {
          toast(`${file.name} 无法读取；请换成 JPG、PNG 或 WebP`);
          continue;
        }
        const result = await invoke("cover:identity", { action: "upload", data_base64: dataBase64 });
        if (!result.ok) return toast(result.error ?? `${file.name} 上传失败`);
      }
      await load();
      toast("真实参考照已保存到本机");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const mutate = async (payload: Record<string, unknown>, success: string) => {
    setBusy(true);
    try {
      const result = await invoke("cover:identity", payload);
      if (!result.ok) return toast(result.error ?? "操作失败");
      setLibrary((result as unknown as { data: IdentityLibrary }).data);
      toast(success);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (asset: IdentityAsset) => {
    const yes = await confirmDialog({
      title: "移除这张照片？",
      body:
        asset.kind === "source"
          ? "它将不再用于锁定你的面部身份。原文件不会被修改。"
          : "这张 AI 备选会从本地形象库删除。",
      confirmLabel: "移除",
    });
    if (yes) await mutate({ action: "remove", kind: asset.kind, filename: asset.filename }, "已移除");
  };

  const generate = async () => {
    if (!library?.sources.length) return toast("先上传至少 1 张真实照片，建议 3–5 张");
    const result = await invoke("cover:identity", { action: "generate" });
    if (!result.ok) return toast(result.error ?? "生成任务启动失败");
    activeRunRef.current = typeof result.runId === "string" ? result.runId : null;
    setGenerating(true);
    toast("正在生成 3 种表情与姿态；完成后会自动出现");
  };

  if (!library) return <div className="identity-panel muted">读取个人形象库…</div>;
  const recommended = library.sources.length >= library.recommendedSourceCount;
  const selectedCount = library.generated.filter((asset) => asset.selected).length;

  return (
    <section className="identity-panel">
      <div className="identity-head">
        <div>
          <div className="mono muted identity-kicker">个人形象建档 · 本地保存</div>
          <strong>先让封面认识你，再让 AI 设计你</strong>
          <p className="muted">真实照片锁定长相；AI 备选只补充表情、姿态和构图，不会替代主身份照。</p>
        </div>
        <span className={`chip ${recommended ? "chip-pub" : ""}`}>
          真实照片 {library.sources.length}/{library.recommendedSourceCount}
          {recommended ? " ✓" : "（建议）"}
        </span>
      </div>

      <div className="identity-stage">
        <div className="identity-stage-head">
          <div>
            <b>1. 上传 3–5 张本人照片</b>
            <span className="muted">正脸、侧脸、戴眼镜和不同表情都放一张</span>
          </div>
          <button disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "处理中…" : "＋ 添加照片"}
          </button>
          <input
            ref={inputRef}
            hidden
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={(event) => void upload(event.target.files)}
          />
        </div>
        {library.sources.length > 0 ? (
          <div className="identity-grid">
            {library.sources.map((asset) => (
              <figure key={asset.filename} className={`identity-card ${asset.primary ? "identity-card-primary" : ""}`}>
                <img src={identityAssetUrl(asset)} alt="本人真实参考照" />
                <figcaption>
                  <span>{asset.primary ? "主身份照" : "辅助角度"}</span>
                  <div className="identity-actions">
                    {!asset.primary && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void mutate({ action: "set_primary", filename: asset.filename }, "已设为主身份照")
                        }
                      >
                        设为主图
                      </button>
                    )}
                    <button disabled={busy} onClick={() => void remove(asset)}>
                      移除
                    </button>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="identity-empty">还没有身份照片。先放一张最近、最像你的生活照，封面才不会生成成另一个人。</div>
        )}
      </div>

      <div className="identity-stage">
        <div className="identity-stage-head">
          <div>
            <b>2. 生成个人形象备选</b>
            <span className="muted">克制帅气、审视感、夸张表达三种方向</span>
          </div>
          <button
            className="primary"
            disabled={generating || library.sources.length === 0}
            onClick={() => void generate()}
          >
            {generating ? "生成中…" : library.generated.length ? "重新生成 3 张" : "生成 3 张备选"}
          </button>
        </div>
        {library.generated.length > 0 && (
          <>
            <div className="identity-grid identity-generated-grid">
              {library.generated.map((asset) => (
                <figure
                  key={asset.filename}
                  className={`identity-card ${asset.selected ? "identity-card-selected" : ""}`}
                >
                  <img src={identityAssetUrl(asset)} alt={asset.label} />
                  <figcaption>
                    <span>{asset.label}</span>
                    <div className="identity-actions">
                      <button
                        className={asset.selected ? "chip chip-pub" : ""}
                        disabled={busy || (!asset.selected && selectedCount >= library.maxSelectedGenerated)}
                        onClick={() =>
                          void mutate(
                            { action: "select_generated", filename: asset.filename, selected: !asset.selected },
                            asset.selected ? "已取消用于封面" : "已加入封面参考",
                          )
                        }
                      >
                        {asset.selected ? "✓ 用于封面" : "选用"}
                      </button>
                      <button disabled={busy} onClick={() => void remove(asset)}>
                        移除
                      </button>
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
            <p className="mono muted identity-note">
              最多选 {library.maxSelectedGenerated} 张 AI 备选；真实主身份照始终排在第一参考位。
            </p>
          </>
        )}
      </div>
    </section>
  );
}
