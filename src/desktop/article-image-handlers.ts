/** 正文配图 IPC：生成是分钟级后台任务，读取/移除同步返回。 */
import {
  attachUploadedArticleImage,
  generateArticleImages,
  getArticleImageReview,
  removeArticleImage,
} from "../modules/publish/article-images.js";
import { emitEngineEvent } from "./event-hub.js";
import { isContentId } from "../storage/entity-id.js";
import { getContent, updateContent } from "../storage/local-store.js";
import { suggestImagePositions } from "../modules/writing/suggest-images.js";
import { addImageMarker, removeImageMarker } from "../modules/writing/image-markers.js";

type Payload = Record<string, unknown>;
type HandlerResult = Record<string, unknown>;

function valid(payload: Payload): { ok: true; contentId: string; dataDir?: string } | { ok: false; error: string } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const contentId = typeof payload.content_id === "string" ? payload.content_id : "";
  if (!isContentId(contentId)) return { ok: false, error: "需要合法 content_id" };
  return { ok: true, contentId, dataDir: (payload._dataDir as string) || undefined };
}

export async function articleImagesGetHandler(payload: Payload): Promise<HandlerResult> {
  const checked = valid(payload);
  if (!checked.ok) return checked;
  try {
    const review = await getArticleImageReview(checked.contentId, checked.dataDir);
    return { ok: true, data: review };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function startGenerate(payload: Payload, single: boolean): Promise<HandlerResult> {
  const checked = valid(payload);
  if (!checked.ok) return checked;
  const index = single ? Number(payload.index) : undefined;
  if (single && (!Number.isInteger(index) || (index as number) < 0)) {
    return { ok: false, error: "需要合法 index" };
  }
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : undefined;
  if (single && !prompt) return { ok: false, error: "重做正文配图需要非空 prompt" };

  const runId = `run-article-images-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const emit = (kind: "work" | "run_done" | "run_failed", label: string) =>
    void emitEngineEvent({ role: "publisher", kind, label, contentId: checked.contentId, runId }, checked.dataDir).catch(() => {});
  emit("work", single ? `正在重做正文配图 ${(index as number) + 1}…` : "正在生成缺失的正文配图…");

  void (async () => {
    try {
      const result = await generateArticleImages({
        contentId: checked.contentId,
        ...(single ? { index, prompt } : {}),
      }, checked.dataDir);
      if (result.failed > 0) {
        emit(
          result.generated > 0 ? "run_done" : "run_failed",
          result.generated > 0
            ? `正文配图部分完成：${result.generated} 张成功、${result.failed} 张失败——已保留成功图片`
            : `正文配图生成失败：${result.errors?.[0]?.slice(0, 100) ?? "生图服务未返回图片"}`,
        );
      } else {
        emit("run_done", result.generated > 0 ? `正文配图已完成：新生成 ${result.generated} 张` : "正文配图已全部准备好");
      }
      // 降级单独播一条:图出来了不代表主生图通道是好的,别让故障被成功消息盖过去
      if (result.degraded?.length) {
        emit("work", `⚠️ ${result.degraded[0].slice(0, 160)}`);
      }
    } catch (err) {
      emit("run_failed", `正文配图失败：${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
    }
  })();
  return { ok: true, pending: true, runId };
}

export async function articleImagesGenerateHandler(payload: Payload): Promise<HandlerResult> {
  return startGenerate(payload, false);
}

export async function articleImagesRegenerateHandler(payload: Payload): Promise<HandlerResult> {
  return startGenerate(payload, true);
}

export async function articleImagesRemoveHandler(payload: Payload): Promise<HandlerResult> {
  const checked = valid(payload);
  if (!checked.ok) return checked;
  const index = Number(payload.index);
  if (!Number.isInteger(index) || index < 0) return { ok: false, error: "需要合法 index" };
  try {
    const review = await removeArticleImage(checked.contentId, index, checked.dataDir);
    return { ok: true, data: review };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** #3 AI 选位：读正文、插入 [IMAGE:] 标记、存新版本(阻塞至模型返回,前端转圈)。 */
export async function articleImagesSuggestHandler(payload: Payload): Promise<HandlerResult> {
  const checked = valid(payload);
  if (!checked.ok) return checked;
  try {
    const { added } = await suggestImagePositions(checked.contentId, checked.dataDir);
    void emitEngineEvent(
      {
        role: "writer",
        kind: "run_done",
        label: added > 0 ? `AI 选好插图位置：新增 ${added} 处` : "AI 判断本文无需新增插图位置",
        contentId: checked.contentId,
      },
      checked.dataDir,
    ).catch(() => {});
    return { ok: true, data: { added } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** #4 加位：正文末尾追加一个插图位标记。 */
export async function articleImagesAddSlotHandler(payload: Payload): Promise<HandlerResult> {
  const checked = valid(payload);
  if (!checked.ok) return checked;
  try {
    const current = await getContent(checked.contentId, checked.dataDir);
    if (!current) return { ok: false, error: `稿件不存在：${checked.contentId}` };
    const prompt = typeof payload.prompt === "string" ? payload.prompt : undefined;
    const updated = await updateContent(
      checked.contentId,
      { body: addImageMarker(current.body, prompt), _versionNote: "手动加一个插图位" },
      checked.dataDir,
    );
    if (!updated) return { ok: false, error: "保存失败" };
    void emitEngineEvent({ role: "writer", kind: "work", label: "新增一个插图位", contentId: checked.contentId }, checked.dataDir).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** #5 上传：用户自有图片顶进一个插图位（字节走 data_base64，同步返回新 review）。 */
export async function articleImagesUploadHandler(payload: Payload): Promise<HandlerResult> {
  const checked = valid(payload);
  if (!checked.ok) return checked;
  const index = Number(payload.index);
  if (!Number.isInteger(index) || index < 0) return { ok: false, error: "需要合法 index" };
  const raw = typeof payload.data_base64 === "string" ? payload.data_base64 : "";
  const b64 = raw.replace(/^data:[^;]*;base64,/, "");
  if (!b64) return { ok: false, error: "需要 data_base64 图片内容" };
  try {
    const review = await attachUploadedArticleImage(checked.contentId, index, Buffer.from(b64, "base64"), checked.dataDir);
    void emitEngineEvent(
      { role: "publisher", kind: "work", label: `配图 ${index + 1} 已换成用户上传的图`, contentId: checked.contentId },
      checked.dataDir,
    ).catch(() => {});
    return { ok: true, data: review };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** #4 删位：删除第 index 个插图位标记。 */
export async function articleImagesRemoveSlotHandler(payload: Payload): Promise<HandlerResult> {
  const checked = valid(payload);
  if (!checked.ok) return checked;
  const index = Number(payload.index);
  if (!Number.isInteger(index) || index < 0) return { ok: false, error: "需要合法 index" };
  try {
    const current = await getContent(checked.contentId, checked.dataDir);
    if (!current) return { ok: false, error: `稿件不存在：${checked.contentId}` };
    const body = removeImageMarker(current.body, index);
    if (body === current.body) return { ok: false, error: "没有找到该插图位" };
    const updated = await updateContent(checked.contentId, { body, _versionNote: "删除一个插图位" }, checked.dataDir);
    if (!updated) return { ok: false, error: "保存失败" };
    void emitEngineEvent({ role: "writer", kind: "work", label: "删除一个插图位", contentId: checked.contentId }, checked.dataDir).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
