import { Type } from "@sinclair/typebox";
import { getContent, updateContent } from "../storage/local-store.js";
import { humanizeZh } from "../modules/humanizer/zh.js";

export const humanizeSchema = Type.Object({
  action: Type.Unsafe<"humanize_zh">({
    type: "string",
    enum: ["humanize_zh"],
    description: "Action. Currently supports 'humanize_zh'.",
  }),
  content_id: Type.Optional(Type.String({ description: "AutoCrew content id to humanize and optionally save back." })),
  text: Type.Optional(Type.String({ description: "Raw text to humanize directly." })),
  save_back: Type.Optional(Type.Boolean({ description: "When content_id is provided, save the humanized text back into the draft." })),
});

export async function executeHumanize(params: Record<string, unknown>) {
  const action = params.action as string;
  if (action !== "humanize_zh") {
    return { ok: false, error: `Unknown action: ${action}` };
  }

  const dataDir = (params._dataDir as string) || undefined;
  let title = "";
  let text = (params.text as string) || "";
  const contentId = params.content_id as string | undefined;

  if (!text && contentId) {
    const content = await getContent(contentId, dataDir);
    if (!content) {
      return { ok: false, error: `Content ${contentId} not found` };
    }
    title = content.title;
    text = content.body;
  }

  if (!text) {
    return { ok: false, error: "text or content_id is required" };
  }

  const result = humanizeZh({ text });
  if (contentId && params.save_back) {
    const updated = await updateContent(
      contentId,
      {
        title: title || undefined,
        body: result.humanizedText,
      },
      dataDir,
    );
    return { ...result, content: updated };
  }

  return result;
}
