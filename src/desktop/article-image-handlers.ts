/** 正文配图 IPC：生成是分钟级后台任务，读取/移除同步返回。 */
import {
  generateArticleImages,
  getArticleImageReview,
  removeArticleImage,
} from "../modules/publish/article-images.js";
import { emitEngineEvent } from "./event-hub.js";
import { isContentId } from "../storage/entity-id.js";

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
