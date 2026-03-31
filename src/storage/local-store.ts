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

export interface Content {
  id: string;
  title: string;
  body: string;
  platform?: string;
  topicId?: string;
  status: "draft" | "review" | "approved" | "published";
  tags: string[];
  assets: Asset[];
  versions: ContentVersion[];
  createdAt: string;
  updatedAt: string;
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

export async function saveContent(content: Omit<Content, "id" | "createdAt" | "updatedAt" | "assets" | "versions">, dataDir?: string): Promise<Content> {
  const id = `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const projDir = await contentProjectDir(id, dataDir);

  const full: Content = {
    ...content,
    id,
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

    const updated: Content = {
      ...existing,
      ...updates,
      id: existing.id,
      assets: updates.assets || existing.assets || [],
      versions: existing.versions,
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
