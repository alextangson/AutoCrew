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
  addDraftVersion,
  type ProjectMeta,
} from "../storage/pipeline-store.js";
import { executeHumanize } from "./humanize.js";

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
  hypothesis: Type.Optional(Type.String({ description: "Traffic hypothesis: what this content tests and expected outcome" })),
  experiment_type: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ["title_test", "hook_test", "format_test", "angle_test"],
    description: "Type of experiment this content represents",
  })),
  control_ref: Type.Optional(Type.String({ description: "Content ID this is being A/B tested against" })),
  content_pillar: Type.Optional(Type.String({ description: "Which content pillar this belongs to" })),
  comment_triggers: Type.Optional(Type.Array(
    Type.Object({
      type: Type.Unsafe<string>({ type: "string", enum: ["controversy", "unanswered_question", "quote_hook"] }),
      position: Type.String(),
    }),
    { description: "Comment engineering trigger points" },
  )),
});

export async function executeContentSave(params: Record<string, unknown>) {
  const action = (params.action as string) || "save";
  const dataDir = (params._dataDir as string) || undefined;

  if (action === "list") {
    const contents = await listContents(dataDir);

    // Also list pipeline drafting projects (these may not exist in legacy contents/)
    const pipelineProjects: Array<{ slug: string; title: string; stage: string; current: string }> = [];
    try {
      const { listProjects, getProjectMeta, stagePath } = await import("../storage/pipeline-store.js");
      for (const stage of ["drafting", "production", "published"] as const) {
        const slugs = await listProjects(stage, dataDir);
        for (const slug of slugs) {
          const meta = await getProjectMeta(slug, dataDir);
          if (meta) {
            pipelineProjects.push({
              slug,
              title: meta.title,
              stage,
              current: meta.current,
            });
          }
        }
      }
    } catch {
      // Pipeline store may not be initialized
    }

    return { ok: true, contents, pipelineProjects };
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

    // Also version in pipeline storage if body changed
    if (params.body && updated.title) {
      try {
        const projectName = slugify(updated.title);
        await addDraftVersion(
          projectName,
          params.body as string,
          (params.diff_note as string) || "Edit via update",
          dataDir ? path.join(dataDir, "data") : undefined,
        );
      } catch {
        // Pipeline project may not exist for legacy content — that's OK
      }
    }

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

  // ─── Methodology compliance gate ────────────────────────────────────
  // Enforce HAMLETDEER.md principles at the code level.
  // LLM skill instructions are advisory; this gate is mandatory.
  const complianceWarnings: string[] = [];

  // Check 1: Body must be substantial (not a stub)
  if (body.trim().length < 200) {
    complianceWarnings.push("草稿过短（< 200字），可能缺少完整论述");
  }

  // Check 2: Anti-pattern detection (HAMLETDEER.md forbidden patterns)
  const antiPatterns = [
    { pattern: /总而言之|综上所述|值得一提的是/, label: "essay transitions" },
    { pattern: /首先[，,].{0,50}其次[，,].{0,50}最后/, label: "首先其次最后 structure" },
    { pattern: /一方面[，,].{0,100}另一方面/, label: "balanced hedging" },
  ];
  for (const { pattern, label } of antiPatterns) {
    if (pattern.test(body)) {
      complianceWarnings.push(`检测到 HAMLETDEER 禁用模式: ${label}`);
    }
  }

  // Check 3: Hypothesis must be provided (HAMLETDEER.md requirement)
  if (!params.hypothesis) {
    complianceWarnings.push("缺少流量假说（hypothesis）— HAMLETDEER.md 要求每篇内容必须有假说");
  }

  // Check 4: Comment triggers should exist
  if (!params.comment_triggers || (params.comment_triggers as unknown[]).length === 0) {
    complianceWarnings.push("缺少评论触发点（comment_triggers）— 建议至少设置 1 个");
  }

  // Don't block save, but return warnings prominently so the LLM self-corrects
  // ─── End methodology compliance gate ────────────────────────────────

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
  // Semantics: draft.md = live current working file (always latest),
  // draft-v{N}.md = immutable snapshots of content that has been REPLACED by a revision.
  // On initial save there are no snapshots yet — only draft.md exists.
  const meta: ProjectMeta = {
    title,
    domain: "",
    format: platform || "article",
    createdAt: now,
    sourceTopic: "",
    intelRefs: [],
    versions: [],
    current: "draft.md",
    history: [{ stage: "drafting", entered: now }],
    platforms: platform ? [{ format: platform, status: "drafting" }] : [],
    hypothesis: (params.hypothesis as string) || undefined,
    experimentType: (params.experiment_type as ProjectMeta["experimentType"]) || undefined,
    controlRef: (params.control_ref as string) || undefined,
    contentPillar: (params.content_pillar as string) || undefined,
    commentTriggers: (params.comment_triggers as ProjectMeta["commentTriggers"]) || undefined,
  };

  await fs.writeFile(
    path.join(projectDir, "meta.yaml"),
    yaml.dump(meta, { lineWidth: -1 }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(projectDir, "draft.md"),
    body,
    "utf-8",
  );

  // Auto-humanize (tool-level enforcement — LLM cannot skip this)
  let humanizeResult: Record<string, unknown> | null = null;
  try {
    humanizeResult = await executeHumanize({
      action: "humanize_zh",
      content_id: content.id,
      save_back: true,
      _dataDir: dataDir,
    }) as Record<string, unknown>;
  } catch {
    // Humanize failure should not block save
  }

  // Verify pipeline integrity — both draft.md and meta.yaml must exist
  let pipelineVerified = false;
  try {
    await fs.access(path.join(projectDir, "draft.md"));
    await fs.access(path.join(projectDir, "meta.yaml"));
    pipelineVerified = true;
  } catch {
    pipelineVerified = false;
  }

  return {
    ok: true,
    content,
    humanized: humanizeResult?.ok ?? false,
    humanizeChanges: (humanizeResult as any)?.changeCount ?? 0,
    filePath: `${projectDir}/draft.md`,
    projectDir,
    pipelinePath: projectDir,
    pipelineVerified,
    complianceWarnings: complianceWarnings.length > 0 ? complianceWarnings : undefined,
    methodologyCompliant: complianceWarnings.length === 0,
    legacyDir: `${effectiveDataDir}/contents/${content.id}`,
    openCommand: `open "${projectDir}"`,
    message: [
      `📄 内容已保存到 pipeline：`,
      `   草稿：${projectDir}/draft.md (当前活动文件)`,
      `   元数据：${projectDir}/meta.yaml`,
      `   Pipeline 完整性：${pipelineVerified ? "✅ 已验证" : "❌ 异常 — meta.yaml 或 draft.md 缺失"}`,
      `   方法论合规：${complianceWarnings.length === 0 ? "✅ 通过" : `⚠️ ${complianceWarnings.length} 个问题`}`,
      ...(complianceWarnings.length > 0
        ? [`   ⚠️ HAMLETDEER 合规问题（建议修改后重新保存）：`, ...complianceWarnings.map((w) => `      - ${w}`)]
        : []),
      `   历史快照：修改后会在 ${projectDir}/draft-v{N}.md 生成`,
      `   自动去AI味：${humanizeResult?.ok ? "✅ 已处理" : "⚠️ 跳过"}`,
      ``,
      `打开文件夹：open "${projectDir}"`,
      `查看草稿：cat "${projectDir}/draft.md"`,
    ].join("\n"),
  };
}
