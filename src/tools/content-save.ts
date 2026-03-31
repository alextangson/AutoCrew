import { Type } from "@sinclair/typebox";
import { saveContent, listContents, getContent, updateContent } from "../storage/local-store.js";

export const contentSaveSchema = Type.Object({
  action: Type.Unsafe<"save" | "list" | "get" | "update">({
    type: "string",
    enum: ["save", "list", "get", "update"],
    description: "Action: 'save' new content, 'list' all, 'get' by id, 'update' existing.",
  }),
  id: Type.Optional(Type.String({ description: "Content id (for get/update)" })),
  title: Type.Optional(Type.String({ description: "Content title" })),
  body: Type.Optional(Type.String({ description: "Content body (markdown)" })),
  platform: Type.Optional(Type.String({ description: "Target platform: xiaohongshu, douyin, wechat_video, wechat_mp" })),
  topicId: Type.Optional(Type.String({ description: "Related topic id" })),
  status: Type.Optional(Type.Unsafe<"draft" | "review" | "approved" | "published">({
    type: "string",
    enum: ["draft", "review", "approved", "published"],
  })),
  tags: Type.Optional(Type.Array(Type.String())),
});

export async function executeContentSave(params: Record<string, unknown>) {
  const action = (params.action as string) || "save";
  const dataDir = (params._dataDir as string) || undefined;

  if (action === "list") {
    const contents = await listContents(dataDir);
    return { ok: true, contents };
  }

  if (action === "get") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for get" };
    const content = await getContent(id, dataDir);
    if (!content) return { ok: false, error: `Content ${id} not found` };
    return { ok: true, content };
  }

  if (action === "update") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for update" };
    const updated = await updateContent(id, {
      title: params.title as string | undefined,
      body: params.body as string | undefined,
      platform: params.platform as string | undefined,
      status: params.status as any,
      tags: params.tags as string[] | undefined,
    }, dataDir);
    if (!updated) return { ok: false, error: `Content ${id} not found` };
    return { ok: true, content: updated };
  }

  // save
  const title = params.title as string;
  const body = params.body as string;
  if (!title || !body) {
    return { ok: false, error: "title and body are required for save" };
  }

  const content = await saveContent({
    title,
    body,
    platform: (params.platform as string) || undefined,
    topicId: (params.topicId as string) || undefined,
    status: (params.status as any) || "draft",
    tags: (params.tags as string[]) || [],
  }, dataDir);

  return { ok: true, content };
}
