/**
 * 多工作区注册表（IA v4.2 工程线:一人多 IP——Muse 与新号各自独立的编辑部）。
 *
 * 注册表存默认工作区 <default>/workspaces.json;子工作区目录固定在
 * <default>/workspaces/<slug>/,dataDir 永远由 server 端从注册表解析——
 * 前端只传 workspace id,绝不传路径(任意路径读写是安全红线)。
 * 每个工作区 = 独立的 profile/topics/contents/conversations;engine.json(key)
 * 缺省回退默认工作区(config.ts 的 fallback),同一个人不用配两遍。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

export interface Workspace {
  id: string;
  name: string;
  /** 相对默认工作区的解析结果;default 工作区恒为 getDataDir() 本身 */
  dataDir: string;
}

interface Registry {
  version: 1;
  active: string;
  workspaces: Array<{ id: string; name: string }>;
}

const REGISTRY_FILE = "workspaces.json";
const DEFAULT_ID = "default";

function registryPath(): string {
  return path.join(getDataDir(), REGISTRY_FILE);
}

function workspaceDataDir(id: string): string {
  return id === DEFAULT_ID ? getDataDir() : path.join(getDataDir(), "workspaces", id);
}

async function readRegistry(): Promise<Registry> {
  try {
    const raw = JSON.parse(await fs.readFile(registryPath(), "utf-8")) as Registry;
    if (Array.isArray(raw.workspaces) && raw.workspaces.some((w) => w.id === DEFAULT_ID)) return raw;
  } catch { /* 首次:落默认 */ }
  return { version: 1, active: DEFAULT_ID, workspaces: [{ id: DEFAULT_ID, name: "默认工作区" }] };
}

async function writeRegistry(reg: Registry): Promise<void> {
  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(registryPath(), JSON.stringify(reg, null, 2) + "\n", "utf-8");
}

export async function listWorkspaces(): Promise<{ active: string; workspaces: Workspace[] }> {
  const reg = await readRegistry();
  return {
    active: reg.active,
    workspaces: reg.workspaces.map((w) => ({ ...w, dataDir: workspaceDataDir(w.id) })),
  };
}

/** active 工作区的 dataDir;default 返回 undefined(走默认解析链,与单工作区时代完全一致) */
export async function activeWorkspaceDataDir(): Promise<string | undefined> {
  const reg = await readRegistry();
  return reg.active === DEFAULT_ID ? undefined : workspaceDataDir(reg.active);
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const clean = name.trim();
  if (!clean) throw new Error("工作区名称不能为空");
  const reg = await readRegistry();
  if (reg.workspaces.some((w) => w.name === clean)) throw new Error(`已有同名工作区「${clean}」`);
  // slug:中文名不可靠,用时间戳 id;name 承载人类可读性
  const id = `ws-${Date.now().toString(36)}`;
  const dir = workspaceDataDir(id);
  await fs.mkdir(dir, { recursive: true });
  reg.workspaces.push({ id, name: clean });
  reg.active = id; // 新建即切换——建它就是为了用它
  await writeRegistry(reg);
  return { id, name: clean, dataDir: dir };
}

export async function switchWorkspace(id: string): Promise<Workspace> {
  const reg = await readRegistry();
  const target = reg.workspaces.find((w) => w.id === id);
  if (!target) throw new Error(`工作区不存在:${id}`);
  reg.active = id;
  await writeRegistry(reg);
  return { ...target, dataDir: workspaceDataDir(id) };
}
