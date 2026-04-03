import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  saveContent,
  listContents,
  getContent,
  updateContent,
  transitionStatus,
  createPlatformVariant,
  listSiblings,
  getAllowedTransitions,
  normalizeLegacyStatus,
} from "../storage/local-store.js";
import type { ContentStatus } from "../storage/local-store.js";
import {
  slugify,
  stagePath,
  initPipeline,
  type ProjectMeta,
} from "../storage/pipeline-store.js";

const ALL_STATUSES = [
  "topic_saved", "drafting", "draft_ready", "reviewing", "revision",
  "approved", "cover_pending", "publish_ready", "publishing", "published", "archived",
  // Legacy compat
  "draft", "review",
] as const;

export const contentSaveSchema = Type.Object({
  action: Type.Unsafe<"save" | "list" | "get" | "update" | "transition" | "create_variant" | "siblings" | "allowed_transitions">({
    type: "string",
    enum: ["save", "list", "get", "update", "transition", "create_variant", "siblings", "allowed_transitions"],
    description:
      "Action: 'save' new content, 'list' all, 'get' by id, 'update' existing, " +
      "'transition' change status via state machine, 'create_variant' create platform variant from topic, " +
      "'siblings' list sibling content, 'allowed_transitions' show valid next statuses.",
  }),
  id: Type.Optional(Type.String({ description: "Content id (for get/update/transition/siblings/allowed_transitions)" })),
  title: Type.Optional(Type.String({ description: "Content title" })),
  body: Type.Optional(Type.String({ description: "Content body (markdown)" })),
  platform: Type.Optional(Type.String({ description: "Target platform: xhs, douyin, wechat_video, wechat_mp, bilibili" })),
  topicId: Type.Optional(Type.String({ description: "Related topic id (for save/create_variant)" })),
  status: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ALL_STATUSES as unknown as string[],
    description: "Content status (for save/update). Use 'transition' action for validated state changes.",
  })),
  target_status: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ALL_STATUSES as unknown as string[],
    description: "Target status for 'transition' action.",
  })),
  tags: Type.Optional(Type.Array(Type.String())),
  hashtags: Type.Optional(Type.Array(Type.String(), { description: "Platform-specific hashtags" })),
  siblings: Type.Optional(Type.Array(Type.String(), { description: "Sibling content IDs" })),
  publish_url: Type.Optional(Type.String({ description: "Published URL on target platform" })),
  performance_data: Type.Optional(Type.Record(Type.String(), Type.Number(), { description: "Performance metrics: views, likes, comments, shares, etc." })),
  force: Type.Optional(Type.Boolean({ description: "Force transition even if not in allowed transitions" })),
  diff_note: Type.Optional(Type.String({ description: "Note for revision diff tracking" })),
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
      status: params.status ? normalizeLegacyStatus(params.status as string) : undefined,
      tags: params.tags as string[] | undefined,
      hashtags: params.hashtags as string[] | undefined,
      siblings: params.siblings as string[] | undefined,
      publishUrl: params.publish_url as string | undefined,
      performanceData: params.performance_data as Record<string, number> | undefined,
    }, dataDir);
    if (!updated) return { ok: false, error: `Content ${id} not found` };
    return { ok: true, content: updated };
  }

  if (action === "transition") {
    const id = params.id as string;
    const targetStatus = params.target_status as string;
    if (!id) return { ok: false, error: "id is required for transition" };
    if (!targetStatus) return { ok: false, error: "target_status is required for transition" };
    const result = await transitionStatus(
      id,
      normalizeLegacyStatus(targetStatus),
      { force: params.force as boolean, diffNote: params.diff_note as string },
      dataDir,
    );
    return result;
  }

  if (action === "create_variant") {
    const topicId = params.topicId as string;
    const platform = params.platform as string;
    if (!topicId) return { ok: false, error: "topicId is required for create_variant" };
    if (!platform) return { ok: false, error: "platform is required for create_variant" };
    const result = await createPlatformVariant(
      topicId,
      platform,
      { title: params.title as string, body: params.body as string },
      dataDir,
    );
    return result;
  }

  if (action === "siblings") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for siblings" };
    const sibs = await listSiblings(id, dataDir);
    return { ok: true, siblings: sibs };
  }

  if (action === "allowed_transitions") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for allowed_transitions" };
    const content = await getContent(id, dataDir);
    if (!content) return { ok: false, error: `Content ${id} not found` };
    const currentStatus = normalizeLegacyStatus(content.status);
    const allowed = getAllowedTransitions(currentStatus);
    return { ok: true, currentStatus, allowedTransitions: allowed };
  }

  // save
  const title = params.title as string;
  const body = params.body as string;
  if (!title || !body) {
    return { ok: false, error: "title and body are required for save" };
  }

  const rawStatus = (params.status as string) || "draft_ready";
  const platform = (params.platform as string) || undefined;

  // 1. Save to old contents/ system (backward compat)
  const content = await saveContent({
    title,
    body,
    platform,
    topicId: (params.topicId as string) || undefined,
    status: normalizeLegacyStatus(rawStatus),
    tags: (params.tags as string[]) || [],
    hashtags: (params.hashtags as string[]) || [],
  }, dataDir);

  // 2. Also create project in new pipeline/drafting/ structure
  const effectiveDataDir = dataDir || path.join(process.env.HOME ?? "~", ".autocrew");
  await initPipeline(effectiveDataDir);

  const projectName = slugify(title);
  const draftingDir = stagePath("drafting", effectiveDataDir);
  const projectDir = path.join(draftingDir, projectName);
  await fs.mkdir(path.join(projectDir, "references"), { recursive: true });

  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    title,
    domain: "",
    format: platform || "article",
    createdAt: now,
    sourceTopic: "",
    intelRefs: [],
    versions: [{ file: "draft-v1.md", createdAt: now, note: "initial draft" }],
    current: "draft-v1.md",
    history: [{ stage: "drafting", entered: now }],
    platforms: platform ? [{ format: platform, status: "drafting" }] : [],
  };

  await fs.writeFile(
    path.join(projectDir, "meta.yaml"),
    yaml.dump(meta, { lineWidth: -1 }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(projectDir, "draft-v1.md"),
    body,
    "utf-8",
  );
  await fs.writeFile(
    path.join(projectDir, "draft.md"),
    `# ${title}\n\n${body}\n`,
    "utf-8",
  );

  return {
    ok: true,
    content,
    filePath: `${projectDir}/draft.md`,
    projectDir,
    pipelinePath: projectDir,
    legacyDir: `${effectiveDataDir}/contents/${content.id}`,
    openCommand: `open "${projectDir}"`,
    message: [
      `📄 内容已保存到 pipeline：`,
      `   草稿：${projectDir}/draft.md`,
      `   元数据：${projectDir}/meta.yaml`,
      `   版本：${projectDir}/draft-v1.md`,
      ``,
      `打开文件夹：open "${projectDir}"`,
      `查看草稿：cat "${projectDir}/draft.md"`,
    ].join("\n"),
  };
}
