import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listWorkspaces, createWorkspace, switchWorkspace, activeWorkspaceDataDir } from "./workspace-store.js";

let tmpHome: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-ws-test-"));
  savedEnv = process.env.AUTOCREW_DATA_DIR;
  process.env.AUTOCREW_DATA_DIR = tmpHome; // 注册表与工作区全部隔离在临时目录
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.AUTOCREW_DATA_DIR;
  else process.env.AUTOCREW_DATA_DIR = savedEnv;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("workspace-store", () => {
  it("first read yields the default workspace, active, dataDir = default dir", async () => {
    const { active, workspaces } = await listWorkspaces();
    expect(active).toBe("default");
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].dataDir).toBe(tmpHome);
    expect(await activeWorkspaceDataDir()).toBeUndefined(); // default → 走默认解析链
  });

  it("create makes the dir under <default>/workspaces/, switches active, resolves dataDir server-side", async () => {
    const ws = await createWorkspace("Muse 公众号");
    expect(ws.dataDir.startsWith(path.join(tmpHome, "workspaces"))).toBe(true);
    await expect(fs.access(ws.dataDir)).resolves.toBeUndefined(); // 目录已建

    const { active, workspaces } = await listWorkspaces();
    expect(active).toBe(ws.id); // 新建即切换
    expect(workspaces).toHaveLength(2);
    expect(await activeWorkspaceDataDir()).toBe(ws.dataDir);
  });

  it("switch back to default; unknown id rejects; duplicate name rejects", async () => {
    const ws = await createWorkspace("Muse");
    await switchWorkspace("default");
    expect((await listWorkspaces()).active).toBe("default");
    await expect(switchWorkspace("nope")).rejects.toThrow(/不存在/);
    await expect(createWorkspace("Muse")).rejects.toThrow(/同名/);
    await switchWorkspace(ws.id);
    expect(await activeWorkspaceDataDir()).toBe(ws.dataDir);
  });
});
