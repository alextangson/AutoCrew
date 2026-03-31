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

export interface Content {
  id: string;
  title: string;
  body: string;
  platform?: string;
  topicId?: string;
  status: "draft" | "review" | "approved" | "published";
  tags: string[];
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

export async function saveContent(content: Omit<Content, "id" | "createdAt" | "updatedAt">, dataDir?: string): Promise<Content> {
  const dir = await contentsDir(dataDir);
  const id = `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const full: Content = {
    ...content,
    id,
    createdAt: now,
    updatedAt: now,
  };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(full, null, 2), "utf-8");
  return full;
}

export async function listContents(dataDir?: string): Promise<Content[]> {
  const dir = await contentsDir(dataDir);
  const files = await fs.readdir(dir);
  const contents: Content[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf-8");
    contents.push(JSON.parse(raw));
  }
  return contents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getContent(id: string, dataDir?: string): Promise<Content | null> {
  const dir = await contentsDir(dataDir);
  try {
    const raw = await fs.readFile(path.join(dir, `${id}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function updateContent(id: string, updates: Partial<Content>, dataDir?: string): Promise<Content | null> {
  const dir = await contentsDir(dataDir);
  const filePath = path.join(dir, `${id}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const existing: Content = JSON.parse(raw);
    const updated: Content = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");
    return updated;
  } catch {
    return null;
  }
}
