import path from "node:path";
import fs from "node:fs/promises";

export interface Topic {
  id: string;
  title: string;
  description: string;
  tags: string[];
  source?: string;
  createdAt: string;
}

export interface Asset {
  filename: string;
  type: "cover" | "broll" | "image" | "video" | "audio" | "subtitle" | "other";
  description?: string;
  addedAt: string;
}

export interface ContentVersion {
  version: number;
  body: string;
  note?: string;
  savedAt: string;
}

export type ContentStatus =
  | "topic_saved"
  | "drafting"
  | "draft_ready"
  | "reviewing"
  | "revision"
  | "approved"
  | "cover_pending"
  | "publish_ready"
  | "publishing"
  | "published"
  | "archived";

/** Legacy status values for backward compatibility */
export type LegacyContentStatus = "draft" | "review";

/** All accepted status values (new + legacy) */
export type AnyContentStatus = ContentStatus | LegacyContentStatus;

/** Map legacy status to new status */
export function normalizeLegacyStatus(s: string): ContentStatus {
  if (s === "draft") return "draft_ready";
  if (s === "review") return "reviewing";
  return s as ContentStatus;
}

export interface Content {
  id: string;
  title: string;
  body: string;
  platform?: string;
  topicId?: string;
  status: ContentStatus;
  tags: string[];
  /** IDs of sibling content (same topic, different platforms) */
  siblings: string[];
  /** Platform-specific hashtags */
  hashtags: string[];
  /** ISO timestamp when published */
  publishedAt: string | null;
  /** URL on the target platform after publishing */
  publishUrl: string | null;
  /** Platform performance metrics (views, likes, comments, shares, etc.) */
  performanceData: Record<string, number>;
  assets: Asset[];
  versions: ContentVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface CoverVariant {
  label: "a" | "b" | "c";
  /** Full image generation prompt used */
  imagePrompt?: string;
  /** Visual style: cinematic, minimalist, bold-impact */
  style?: string;
  /** Chinese title text on the cover (2-8 chars) */
  titleText?: string;
  /** Generated image paths by aspect ratio */
  imagePaths: {
    "3:4"?: string;
    "16:9"?: string;
    "4:3"?: string;
  };
  /** Model used for generation */
  model?: string;
  /** Whether personal IP reference photos were used */
  hasPersonalIP?: boolean;
  /** Layout description */
  layoutHint?: string;
  /** Design reasoning (for display) */
  designReason?: string;
  // Legacy fields (kept for backward compat)
  titleMain?: string;
  titleSub?: string;
  titleLayout?: string;
  stopTrigger?: string;
  keyMoment?: string;
  hookText?: string;
  renderPrompt?: string;
  seedreamPrompt?: string;
  prototypeId?: string;
  prototypeName?: string;
  sourceCategory?: string;
  imagePath?: string;
}

export interface CoverReview {
  platform: string;
  status: "review_pending" | "approved" | "publish_ready";
  stopReason?: string;
  coverHook?: string;
  variants: CoverVariant[];
  approvedLabel?: "a" | "b" | "c";
  approvedImagePath?: string;
  approvedAt?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// --- Topics ---

async function topicsDir(dataDir?: string): Promise<string> {
  const dir = path.join(getDataDir(dataDir), "topics");
  await ensureDir(dir);
  return dir;
}

export async function saveTopic(topic: Omit<Topic, "id" | "createdAt">, dataDir?: string): Promise<Topic> {
  const dir = await topicsDir(dataDir);
  const id = `topic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full: Topic = {
    ...topic,
    id,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(full, null, 2), "utf-8");
  return full;
}

export async function listTopics(dataDir?: string): Promise<Topic[]> {
  const dir = await topicsDir(dataDir);
  const files = await fs.readdir(dir);
  const topics: Topic[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf-8");
    topics.push(JSON.parse(raw));
  }
  return topics.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTopic(id: string, dataDir?: string): Promise<Topic | null> {
  const dir = await topicsDir(dataDir);
  try {
    const raw = await fs.readFile(path.join(dir, `${id}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- Contents ---

async function contentsDir(dataDir?: string): Promise<string> {
  const dir = path.join(getDataDir(dataDir), "contents");
  await ensureDir(dir);
  return dir;
}

/**
 * Each content is stored as a project directory:
 *   contents/{id}/
 *     meta.json       — metadata (title, status, tags, assets, versions index)
 *     draft.md        — current body as readable markdown
 *     assets/         — media files (covers, broll, images, videos)
 *     versions/       — version history (v1.md, v2.md, ...)
 */
async function contentProjectDir(id: string, dataDir?: string): Promise<string> {
  const dir = path.join(getDataDir(dataDir), "contents", id);
  await ensureDir(dir);
  await ensureDir(path.join(dir, "assets"));
  await ensureDir(path.join(dir, "versions"));
  return dir;
}

export async function saveContent(
  content: Omit<Content, "id" | "createdAt" | "updatedAt" | "assets" | "versions" | "siblings" | "hashtags" | "publishedAt" | "publishUrl" | "performanceData"> & Partial<Pick<Content, "siblings" | "hashtags" | "publishedAt" | "publishUrl" | "performanceData">>,
  dataDir?: string,
): Promise<Content> {
  const id = `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const projDir = await contentProjectDir(id, dataDir);

  const full: Content = {
    ...content,
    id,
    siblings: content.siblings ?? [],
    hashtags: content.hashtags ?? [],
    publishedAt: content.publishedAt ?? null,
    publishUrl: content.publishUrl ?? null,
    performanceData: content.performanceData ?? {},
    assets: [],
    versions: [{ version: 1, body: content.body, note: "Initial draft", savedAt: now }],
    createdAt: now,
    updatedAt: now,
  };

  // Write meta.json
  await fs.writeFile(path.join(projDir, "meta.json"), JSON.stringify(full, null, 2), "utf-8");
  // Write readable draft.md
  await fs.writeFile(path.join(projDir, "draft.md"), `# ${content.title}\n\n${content.body}\n`, "utf-8");
  // Write version snapshot
  await fs.writeFile(path.join(projDir, "versions", "v1.md"), content.body, "utf-8");

  return full;
}

export async function listContents(dataDir?: string): Promise<Content[]> {
  const dir = path.join(getDataDir(dataDir), "contents");
  await ensureDir(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const contents: Content[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, "meta.json");
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      contents.push(JSON.parse(raw));
    } catch {
      // Legacy flat JSON file support
      if (entry.name.endsWith(".json")) {
        try {
          const raw = await fs.readFile(path.join(dir, entry.name), "utf-8");
          contents.push(JSON.parse(raw));
        } catch { /* skip */ }
      }
    }
  }
  // Also read any legacy flat .json files at the contents/ level
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), "utf-8");
      const parsed = JSON.parse(raw);
      if (!contents.find(c => c.id === parsed.id)) {
        contents.push(parsed);
      }
    } catch { /* skip */ }
  }
  return contents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getContent(id: string, dataDir?: string): Promise<Content | null> {
  const projDir = path.join(getDataDir(dataDir), "contents", id);
  try {
    const raw = await fs.readFile(path.join(projDir, "meta.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    // Legacy flat file fallback
    const legacyPath = path.join(getDataDir(dataDir), "contents", `${id}.json`);
    try {
      const raw = await fs.readFile(legacyPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

export async function updateContent(id: string, updates: Partial<Content>, dataDir?: string): Promise<Content | null> {
  const projDir = path.join(getDataDir(dataDir), "contents", id);
  const metaPath = path.join(projDir, "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const existing: Content = JSON.parse(raw);
    const now = new Date().toISOString();

    // If body changed, create a new version
    if (updates.body && updates.body !== existing.body) {
      const nextVersion = (existing.versions?.length || 0) + 1;
      const versionEntry: ContentVersion = {
        version: nextVersion,
        body: updates.body,
        note: (updates as any)._versionNote || `Edit v${nextVersion}`,
        savedAt: now,
      };
      existing.versions = [...(existing.versions || []), versionEntry];
      // Write version snapshot
      await fs.writeFile(
        path.join(projDir, "versions", `v${nextVersion}.md`),
        updates.body,
        "utf-8",
      );
    }

    // Strip undefined values so they don't overwrite existing fields via spread
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined),
    );

    const updated: Content = {
      ...existing,
      ...cleanUpdates,
      id: existing.id,
      assets: updates.assets || existing.assets || [],
      versions: existing.versions,
      siblings: updates.siblings || existing.siblings || [],
      hashtags: updates.hashtags || existing.hashtags || [],
      publishedAt: updates.publishedAt !== undefined ? updates.publishedAt : existing.publishedAt ?? null,
      publishUrl: updates.publishUrl !== undefined ? updates.publishUrl : existing.publishUrl ?? null,
      performanceData: updates.performanceData || existing.performanceData || {},
      createdAt: existing.createdAt,
      updatedAt: now,
    };

    await fs.writeFile(metaPath, JSON.stringify(updated, null, 2), "utf-8");
    // Update readable draft
    await fs.writeFile(
      path.join(projDir, "draft.md"),
      `# ${updated.title}\n\n${updated.body}\n`,
      "utf-8",
    );

    return updated;
  } catch {
    return null;
  }
}

// --- Assets ---

export async function addAsset(
  contentId: string,
  asset: { filename: string; type: Asset["type"]; description?: string; sourcePath?: string },
  dataDir?: string,
): Promise<{ ok: boolean; asset?: Asset; error?: string }> {
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  const metaPath = path.join(projDir, "meta.json");

  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const content: Content = JSON.parse(raw);
    const now = new Date().toISOString();

    // Copy source file into assets/ if provided
    if (asset.sourcePath) {
      const destPath = path.join(projDir, "assets", asset.filename);
      await fs.copyFile(asset.sourcePath, destPath);
    }

    const newAsset: Asset = {
      filename: asset.filename,
      type: asset.type,
      description: asset.description,
      addedAt: now,
    };

    content.assets = [...(content.assets || []), newAsset];
    content.updatedAt = now;
    await fs.writeFile(metaPath, JSON.stringify(content, null, 2), "utf-8");

    return { ok: true, asset: newAsset };
  } catch {
    return { ok: false, error: `Content ${contentId} not found` };
  }
}

export async function listAssets(contentId: string, dataDir?: string): Promise<Asset[]> {
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  try {
    const raw = await fs.readFile(path.join(projDir, "meta.json"), "utf-8");
    const content: Content = JSON.parse(raw);
    return content.assets || [];
  } catch {
    return [];
  }
}

export async function removeAsset(contentId: string, filename: string, dataDir?: string): Promise<boolean> {
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  const metaPath = path.join(projDir, "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const content: Content = JSON.parse(raw);
    content.assets = (content.assets || []).filter(a => a.filename !== filename);
    content.updatedAt = new Date().toISOString();
    await fs.writeFile(metaPath, JSON.stringify(content, null, 2), "utf-8");
    // Also delete the file
    try { await fs.unlink(path.join(projDir, "assets", filename)); } catch { /* ok */ }
    return true;
  } catch {
    return false;
  }
}

// --- Versions ---

export async function listVersions(contentId: string, dataDir?: string): Promise<ContentVersion[]> {
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  try {
    const raw = await fs.readFile(path.join(projDir, "meta.json"), "utf-8");
    const content: Content = JSON.parse(raw);
    return content.versions || [];
  } catch {
    return [];
  }
}

export async function getVersion(contentId: string, version: number, dataDir?: string): Promise<string | null> {
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  try {
    return await fs.readFile(path.join(projDir, "versions", `v${version}.md`), "utf-8");
  } catch {
    return null;
  }
}

export async function revertToVersion(contentId: string, version: number, dataDir?: string): Promise<Content | null> {
  const body = await getVersion(contentId, version, dataDir);
  if (!body) return null;
  return updateContent(contentId, { body, _versionNote: `Reverted to v${version}` } as any, dataDir);
}

// --- Cover review ---

export async function saveCoverReview(
  contentId: string,
  review: Omit<CoverReview, "createdAt" | "updatedAt">,
  dataDir?: string,
): Promise<CoverReview | null> {
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  const metaPath = path.join(projDir, "meta.json");
  const reviewPath = path.join(projDir, "cover-review.json");

  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const content: Content = JSON.parse(raw);
    const now = new Date().toISOString();
    const full: CoverReview = {
      ...review,
      createdAt: now,
      updatedAt: now,
    };

    await fs.writeFile(reviewPath, JSON.stringify(full, null, 2), "utf-8");
    content.updatedAt = now;
    await fs.writeFile(metaPath, JSON.stringify(content, null, 2), "utf-8");
    return full;
  } catch {
    return null;
  }
}

export async function getCoverReview(contentId: string, dataDir?: string): Promise<CoverReview | null> {
  const reviewPath = path.join(getDataDir(dataDir), "contents", contentId, "cover-review.json");
  try {
    const raw = await fs.readFile(reviewPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function approveCoverVariant(
  contentId: string,
  label: "a" | "b" | "c",
  dataDir?: string,
): Promise<CoverReview | null> {
  const projDir = path.join(getDataDir(dataDir), "contents", contentId);
  const reviewPath = path.join(projDir, "cover-review.json");
  const metaPath = path.join(projDir, "meta.json");

  try {
    const [reviewRaw, metaRaw] = await Promise.all([
      fs.readFile(reviewPath, "utf-8"),
      fs.readFile(metaPath, "utf-8"),
    ]);
    const review: CoverReview = JSON.parse(reviewRaw);
    const content: Content = JSON.parse(metaRaw);
    const selected = review.variants.find((variant) => variant.label === label);
    if (!selected) {
      return null;
    }

    const now = new Date().toISOString();
    review.status = "publish_ready";
    review.approvedLabel = label;
    review.approvedImagePath = selected.imagePath;
    review.approvedAt = now;
    review.updatedAt = now;
    content.status = "approved";
    content.updatedAt = now;

    await Promise.all([
      fs.writeFile(reviewPath, JSON.stringify(review, null, 2), "utf-8"),
      fs.writeFile(metaPath, JSON.stringify(content, null, 2), "utf-8"),
    ]);
    return review;
  } catch {
    return null;
  }
}

// --- Content Status Machine ---

/** Valid state transitions: from → allowed targets */
const STATE_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  topic_saved: ["drafting"],
  drafting: ["draft_ready"],
  draft_ready: ["reviewing"],
  reviewing: ["revision", "approved"],
  revision: ["reviewing", "approved", "draft_ready"],
  approved: ["cover_pending", "publish_ready"],
  cover_pending: ["publish_ready"],
  publish_ready: ["publishing"],
  publishing: ["published"],
  published: ["archived"],
  archived: [],
};

export interface TransitionResult {
  ok: boolean;
  content?: Content;
  error?: string;
  /** If an auto-trigger fired, describes what happened */
  autoTriggered?: string;
}

/**
 * Transition a content item to a new status with validation.
 * Enforces the state machine defined in PRD §13.
 *
 * Auto-trigger rules:
 * - draft_ready → reviewing: fires automatically (caller should run content-review)
 * - revision: records diff to learnings directory
 */
export async function transitionStatus(
  contentId: string,
  targetStatus: ContentStatus,
  opts?: { force?: boolean; diffNote?: string },
  dataDir?: string,
): Promise<TransitionResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `Content ${contentId} not found` };

  const currentStatus = normalizeLegacyStatus(content.status);

  // Validate transition
  if (!opts?.force) {
    const allowed = STATE_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      return {
        ok: false,
        error: `Invalid transition: ${currentStatus} → ${targetStatus}. Allowed: ${(allowed || []).join(", ") || "none"}`,
      };
    }
  }

  const now = new Date().toISOString();
  const updates: Partial<Content> = { status: targetStatus };

  // Auto-trigger: revision → record diff to learnings
  let autoTriggered: string | undefined;
  if (targetStatus === "revision") {
    const learningsDir = path.join(getDataDir(dataDir), "learnings", "edits");
    await ensureDir(learningsDir);
    const diffEntry = {
      contentId,
      fromStatus: currentStatus,
      timestamp: now,
      note: opts?.diffNote || "User entered revision",
      bodySnapshot: content.body?.slice(0, 500),
    };
    const diffFile = `${contentId}-${Date.now()}.json`;
    await fs.writeFile(
      path.join(learningsDir, diffFile),
      JSON.stringify(diffEntry, null, 2),
      "utf-8",
    );
    autoTriggered = `Diff recorded to learnings/edits/${diffFile}`;
  }

  // Auto-trigger: draft_ready → reviewing (signal to caller)
  if (targetStatus === "draft_ready") {
    autoTriggered = "draft_ready reached — auto-transition to reviewing recommended (run content-review)";
  }

  // Set publishedAt when transitioning to published
  if (targetStatus === "published" && !content.publishedAt) {
    updates.publishedAt = now;
  }

  const updated = await updateContent(contentId, updates, dataDir);
  if (!updated) return { ok: false, error: "Failed to update content" };

  return { ok: true, content: updated, autoTriggered };
}

/**
 * Get allowed next statuses for a content item.
 */
export function getAllowedTransitions(status: ContentStatus): ContentStatus[] {
  return STATE_TRANSITIONS[status] || [];
}

// --- Multi-platform distribution ---

/**
 * Create a platform-specific variant from a topic.
 * Automatically sets up sibling relationships.
 */
export async function createPlatformVariant(
  topicId: string,
  platform: string,
  opts?: { title?: string; body?: string },
  dataDir?: string,
): Promise<{ ok: boolean; content?: Content; error?: string }> {
  const topic = await getTopic(topicId, dataDir);
  if (!topic) return { ok: false, error: `Topic ${topicId} not found` };

  // Find existing siblings for this topic
  const allContents = await listContents(dataDir);
  const existingSiblings = allContents.filter(
    (c) => c.topicId === topicId,
  );

  // Check if this platform already has a variant
  const existing = existingSiblings.find((c) => c.platform === platform);
  if (existing) {
    return { ok: false, error: `Platform variant already exists: ${existing.id}` };
  }

  // Create the new content
  const content = await saveContent(
    {
      title: opts?.title || `${topic.title} (${platform})`,
      body: opts?.body || `<!-- Generated from topic: ${topicId} -->\n\n${topic.description}`,
      platform,
      topicId,
      status: "topic_saved",
      tags: [...topic.tags],
    },
    dataDir,
  );

  // Update all siblings to reference each other
  const allSiblingIds = [...existingSiblings.map((c) => c.id), content.id];
  for (const sib of existingSiblings) {
    const siblingIds = allSiblingIds.filter((id) => id !== sib.id);
    await updateContent(sib.id, { siblings: siblingIds }, dataDir);
  }
  // Update the new content's siblings
  const newSiblingIds = allSiblingIds.filter((id) => id !== content.id);
  if (newSiblingIds.length > 0) {
    await updateContent(content.id, { siblings: newSiblingIds }, dataDir);
  }

  // Re-read to get the updated version
  const final = await getContent(content.id, dataDir);
  return { ok: true, content: final || content };
}

/**
 * List all sibling content items (same topic, different platforms).
 */
export async function listSiblings(
  contentId: string,
  dataDir?: string,
): Promise<Content[]> {
  const content = await getContent(contentId, dataDir);
  if (!content) return [];

  const siblingIds = content.siblings || [];
  if (siblingIds.length === 0 && content.topicId) {
    // Fallback: find by topicId
    const all = await listContents(dataDir);
    return all.filter((c) => c.topicId === content.topicId && c.id !== contentId);
  }

  const siblings: Content[] = [];
  for (const id of siblingIds) {
    const sib = await getContent(id, dataDir);
    if (sib) siblings.push(sib);
  }
  return siblings;
}
