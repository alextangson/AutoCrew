/**
 * 依赖与前端产物的「留一份旧的」（e2e P1-2）：npm ci 一开头就会删掉 node_modules，离线时装不回来、旧版也起不来。
 * 所以装之前先把 node_modules（根目录与 frontend/）原地改名成 `.prev-<时间>`（同一个盘上的 rename 是原子的），
 * 退回时改名回来——不需要网络；健康检查通过之后才删掉旧的。
 * 前端构建进 `frontend/dist.next`，等确认没有任务在跑、马上要重启时才和 `frontend/dist` 对调：
 * 等待期间旧进程照旧服务旧前端（依赖换新的这一段无法避免：npm 只会原地安装；旧进程已加载的模块不受影响，懒加载的会读到新包，
 * 这段从装依赖开始、到重启为止，一般一两分钟）。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";

/** 恢复用的旧目录只认这个名字：`node_modules.prev-<数字>`；垃圾名（.trash-…）不算 */
export const PREV_NAME = (base: string) => new RegExp(`^${base.replace(".", "\\.")}\\.prev-\\d+$`);

/** 先改名成垃圾名（原子），再异步删：原名下的目录要么完整、要么不在；删的时候不卡事件循环 */
export async function discard(dir: string): Promise<void> {
  const trash = `${dir}.trash-${process.pid}-${Date.now()}`;
  try { await fsp.rename(dir, trash); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  await fsp.rm(trash, { recursive: true, force: true });
}
import path from "node:path";

export interface Swap { current: string; prev: string }

export class DepsSwap {
  private swaps: Swap[] = [];
  private distSwap: Swap | null = null;
  constructor(private readonly root: string, private readonly stamp = String(Date.now())) {}

  get nextDist(): string { return path.join(this.root, "frontend", "dist.next"); }

  /** 装依赖前：把现有的 node_modules 改名留着 */
  backupDeps(log: (l: string) => void): void {
    for (const dir of [path.join(this.root, "node_modules"), path.join(this.root, "frontend", "node_modules")]) {
      if (!fs.existsSync(dir)) continue;
      const prev = `${dir}.prev-${this.stamp}`;
      fs.renameSync(dir, prev);
      this.swaps.push({ current: dir, prev });
      log(`旧依赖留在 ${prev}`);
    }
  }

  /** 新前端构建好了、马上要重启：dist 换成 dist.next，旧的改名留着 */
  async activateDist(log: (l: string) => void): Promise<void> {
    const dist = path.join(this.root, "frontend", "dist");
    if (!fs.existsSync(this.nextDist)) throw new Error("新前端没构建出来");
    if (fs.existsSync(dist)) {
      const prev = `${dist}.prev-${this.stamp}`;
      await fsp.rename(dist, prev);
      this.distSwap = { current: dist, prev };
    }
    await fsp.rename(this.nextDist, dist);
    log("新前端已换上");
  }

  /** 有没有可以不靠网络换回去的旧依赖 */
  get hasBackup(): boolean { return this.swaps.length > 0; }

  /**
   * 退回：删掉新装的，把旧的改名回来；dist 同理；没构建完的 dist.next 删掉。全程不碰网络。
   * 删除一律先改名成垃圾名再异步删（e2e 1002 P1-A）：被删的目录要么完整、要么已经不在原名下，
   * 而且删的时候事件循环不被卡住，Ctrl-C 能在安全点被处理。
   */
  async restore(log: (l: string) => void): Promise<void> {
    await discard(this.nextDist);
    for (const s of [...this.swaps, ...(this.distSwap ? [this.distSwap] : [])]) {
      await discard(s.current);
      await fsp.rename(s.prev, s.current);
      log(`已换回旧的 ${path.relative(this.root, s.current)}`);
    }
    this.swaps = [];
    this.distSwap = null;
  }

  /** 健康检查通过之后：删掉留着的旧的（先改名成垃圾名：`.prev-*` 永远要么完整、要么不在） */
  async cleanup(log: (l: string) => void): Promise<void> {
    const all = [...this.swaps, ...(this.distSwap ? [this.distSwap] : [])];
    this.swaps = [];
    this.distSwap = null;
    for (const s of all) await discard(s.prev);
    if (all.length) log("已删掉留着的旧依赖与旧前端");
  }

  /** 手动恢复时换回旧依赖的命令（不需要网络） */
  manualRestore(): string[] {
    return [...this.swaps, ...(this.distSwap ? [this.distSwap] : [])].map((s) =>
      `rm -rf "${path.relative(this.root, s.current)}" && mv "${path.relative(this.root, s.prev)}" "${path.relative(this.root, s.current)}"`);
  }
}
