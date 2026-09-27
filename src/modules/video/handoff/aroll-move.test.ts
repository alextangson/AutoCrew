/**
 * A-roll 挪进项目与恢复矩阵（P6 §13.4-F，codex 评审 #13 的六种情形）。
 * 跨卷用注入的 rename 抛 EXDEV 模拟；Downloads 用临时目录，绝不碰真 ~/Downloads。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256File } from "./manifest.js";
import { journalFile, moveArollBack, moveArollIn, readJournal, recoverArollMoves, reserveName, setMoveOps, type MoveJournal } from "./aroll-move.js";
import { arollLockOf, putArollLock, writeRecord } from "./pull-store.js";

let dir: string, data: string, downloads: string, project: string, source: string, sha: string;
const exdev = async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
const exists = (f: string) => fs.access(f).then(() => true, () => false);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-move-"));
  [data, downloads, project] = ["data", "Downloads", "project/02-aroll"].map((d) => path.join(dir, d));
  await Promise.all([data, downloads, project].map((d) => fs.mkdir(d, { recursive: true })));
  source = path.join(downloads, "AI 省时三件事.mov");
  await fs.writeFile(source, "原片字节");
  sha = await sha256File(source);
  await putArollLock(data, sha, { content_id: "content-1", generation: 1, at: "x" });
});
afterEach(async () => { setMoveOps(null); await fs.rm(dir, { recursive: true, force: true }); });

const plan = () => ({ content_id: "content-1", generation: 1, source, sha256: sha });

describe("挪入", () => {
  it("同卷 rename：保留原文件名，日志先于移动落盘，源不再存在", async () => {
    const seen: string[] = [];
    setMoveOps({ rename: async (a, b) => { seen.push((await readJournal(data, sha))!.step); await fs.rename(a, b); } });
    const j = await moveArollIn(data, plan(), project);
    expect(seen).toEqual(["planned"]);
    expect(j).toMatchObject({ step: "moved", target: path.join(project, "AI 省时三件事.mov") });
    expect(await exists(source)).toBe(false);
    expect(await sha256File(j.target)).toBe(sha);
  });

  it("同名后缀竞争：两次占位拿到不同的名字，谁也不覆盖谁", async () => {
    const [a, b] = await Promise.all([reserveName(project, "x.mov"), reserveName(project, "x.mov")]);
    expect(new Set([a, b])).toEqual(new Set([path.join(project, "x.mov"), path.join(project, "x (2).mov")]));
  });

  it("跨卷：复制、校验、删源；删源失败不算失败，日志记下原件还在", async () => {
    setMoveOps({ rename: exdev, unlink: async () => { throw new Error("EBUSY"); } });
    const j = await moveArollIn(data, plan(), project);
    expect(j).toMatchObject({ step: "moved", cross_volume: true, source_left: true });
    expect(await exists(source)).toBe(true);
    expect(await sha256File(j.target)).toBe(sha);
  });
});

async function journal(step: MoveJournal["step"], target = path.join(project, "AI 省时三件事.mov")): Promise<MoveJournal> {
  const j: MoveJournal = { ...plan(), target, step, at: "x" };
  await writeRecord(journalFile(data, sha), j);
  return j;
}

describe("恢复矩阵（内容没提交 → 挪回）", () => {
  it("1 跨卷复制中途中断：源是有效副本，删目标残片，释放锁", async () => {
    const j = await journal("copying");
    await fs.writeFile(j.target, "半截");
    const out = await recoverArollMoves(data, downloads);
    expect(out[0].outcome).toBe(`returned:${source}`);
    expect(await exists(j.target)).toBe(false);
    expect(await sha256File(source)).toBe(sha);
    expect(await arollLockOf(data, sha)).toBeNull();
    expect(await readJournal(data, sha)).toBeNull();
  });

  it("2 校验通过后删源失败：两份都在 → 挪回时删项目那份，源留着", async () => {
    const j = await journal("moved");
    await fs.copyFile(source, j.target);
    expect(await moveArollBack(data, { ...j, source_left: true }, downloads)).toBe(source);
    expect(await exists(j.target)).toBe(false);
    expect(await exists(source)).toBe(true);
  });

  it("3 删源之后崩溃：有效副本在项目里，挪回原处并校验后才释放锁", async () => {
    const j = await journal("copied");
    await fs.rename(source, j.target);
    const out = await recoverArollMoves(data, downloads);
    expect(out[0].outcome).toBe(`returned:${source}`);
    expect(await sha256File(source)).toBe(sha);
    expect(await arollLockOf(data, sha)).toBeNull();
  });

  it("4 回滚时原路径被占：放回 Downloads 加后缀", async () => {
    const j = await journal("moved");
    await fs.rename(source, j.target);
    await fs.writeFile(source, "别的文件占了原名");
    const where = await moveArollBack(data, j, downloads);
    expect(where).toBe(path.join(downloads, "AI 省时三件事 (2).mov"));
    expect(await sha256File(where)).toBe(sha);
    expect(await fs.readFile(source, "utf8")).toBe("别的文件占了原名");
  });

  it("6 移回时再次跨卷：复制、校验、删项目那份", async () => {
    const j = await journal("moved");
    await fs.rename(source, j.target);
    setMoveOps({ rename: exdev });
    expect(await moveArollBack(data, j, downloads)).toBe(source);
    expect(await sha256File(source)).toBe(sha);
    expect(await exists(j.target)).toBe(false);
  });

  it("两处都找不到完好的原片：不释放锁、不删日志", async () => {
    const j = await journal("moved");
    await fs.rm(source);
    await expect(moveArollBack(data, j, downloads)).rejects.toThrow("找不到完好的原片");
    expect(await arollLockOf(data, sha)).not.toBeNull();
    expect(await readJournal(data, sha)).not.toBeNull();
  });

  it("挪后校验不一致（有人在写）：抛错交给调用方挪回", async () => {
    const real = fs.rename;
    setMoveOps({ rename: async (a, b) => { await real(a, b); await fs.appendFile(b, "又写了一点"); } });
    await expect(moveArollIn(data, plan(), project)).rejects.toThrow("挪后校验不一致");
    vi.restoreAllMocks();
  });
});
