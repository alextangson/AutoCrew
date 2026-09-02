/**
 * 隔离 dataDir（P0 实验红线：生产 ~/.autocrew 只读、一个字节都不许改）。
 *
 * 做法：把管线真正会读的那几样东西**拷**进 runs/<topicId>/_data/，
 * 然后 run-cell 同时用两把锁指向它——显式 dataDir 参数 + AUTOCREW_DATA_DIR 环境变量。
 * 两把一起上是因为 src 里有少数路径走 getDataDir() 无参重载（如 resolveEngineConfigPath
 * 算 workspaces 前缀），只锁参数不锁环境变量就会漏。
 *
 * 拷贝清单刻意是白名单而不是整目录同步：contents/ 里那 40 多篇真稿子不该进实验，
 * 它们会通过 recentContrastPairs 之外的路径污染不了 prompt，但会让「跑一格」变成拷几百兆。
 */
import fs from "node:fs/promises";
import path from "node:path";

/** 生产数据目录（**只读**）；必须在 run-cell 改写 AUTOCREW_DATA_DIR 之前调用 */
export function sourceDataDir(): string {
  if (process.env.AUTOCREW_DATA_DIR) return process.env.AUTOCREW_DATA_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 拷一份（不存在就跳过并记一笔——缺 knowledge/ 是正常空态，不是故障） */
async function copyIfPresent(src: string, dest: string, missing: string[], label: string): Promise<void> {
  if (!(await exists(src))) {
    missing.push(label);
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
}

export interface IsolationResult {
  dataDir: string;
  /** 源目录里没有、因而没拷进来的条目（人话留痕：知道这稿少了哪块材料） */
  missing: string[];
  /** 本次是新建还是复用已有隔离目录 */
  rebuilt: boolean;
}

/**
 * 造/复用 runs/<topicId>/_data。
 * 复用是默认：同一选题 15 格跑下来共用一份材料，才谈得上「只有格子在变」。
 * refresh=true 时整个删了重拷（改过生产画像/简报后用）。
 */
export interface IsolationOptions {
  /** true = 整个删了重拷（改过生产画像/简报后用） */
  refresh?: boolean;
  /** 目录后缀：不同调研档各一份隔离目录，因为它们拷的东西不一样 */
  variant?: string;
  /**
   * 是否拷 jobs.jsonl（简报指针）。false = 管线读不到指针 → 不追加 2800 字块，
   * 调研只剩调用方经 research 字段给的那份。这是 full 档的关键。
   */
  includeBriefPointer?: boolean;
}

export async function buildIsolatedDataDir(
  topicId: string,
  runsRoot: string,
  options: IsolationOptions = {},
): Promise<IsolationResult> {
  const { refresh = false, variant, includeBriefPointer = true } = options;
  const src = sourceDataDir();
  const dataDir = path.join(runsRoot, topicId, variant ? `_data-${variant}` : "_data");
  const stamp = path.join(dataDir, ".isolated");

  if (await exists(stamp)) {
    if (!refresh) return { dataDir, missing: [], rebuilt: false };
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  await fs.mkdir(dataDir, { recursive: true });
  const missing: string[] = [];

  // 引擎凭证与路由：没有它整条链跑不起来，所以缺失直接报错而不是记一笔
  await copyIfPresent(path.join(src, "engine.json"), path.join(dataDir, "engine.json"), missing, "engine.json");
  if (missing.includes("engine.json")) {
    throw new Error(`生产数据目录里没有 engine.json（${src}）：先在 AutoCrew 设置页配好模型端点再跑实验`);
  }

  await copyIfPresent(
    path.join(src, "creator-profile.json"),
    path.join(dataDir, "creator-profile.json"),
    missing,
    "creator-profile.json（声音内核）",
  );
  await copyIfPresent(
    path.join(src, "topics", `${topicId}.json`),
    path.join(dataDir, "topics", `${topicId}.json`),
    missing,
    `topics/${topicId}.json`,
  );
  if (missing.some((m) => m.startsWith("topics/"))) {
    throw new Error(`选题 ${topicId} 不在生产库里（${src}/topics）：选题 id 抄错了，或这条选题已被删`);
  }

  // 简报：只拷本选题的所有版本；jobs.jsonl 整份拷（getJob 顺序扫，切不开）
  const briefsSrc = path.join(src, "research", "briefs");
  if (await exists(briefsSrc)) {
    const versions = (await fs.readdir(briefsSrc)).filter((f) => f.startsWith(`${topicId}.v`) && f.endsWith(".json"));
    if (versions.length === 0) missing.push(`research/briefs/${topicId}.v*.json（这条选题没跑过深调研）`);
    await fs.mkdir(path.join(dataDir, "research", "briefs"), { recursive: true });
    for (const f of versions) {
      await fs.copyFile(path.join(briefsSrc, f), path.join(dataDir, "research", "briefs", f));
    }
  } else {
    missing.push("research/briefs/");
  }
  if (includeBriefPointer) {
    await copyIfPresent(
      path.join(src, "research", "jobs.jsonl"),
      path.join(dataDir, "research", "jobs.jsonl"),
      missing,
      "research/jobs.jsonl（无它 = 无简报指针 = 管线裸写）",
    );
  }

  await copyIfPresent(path.join(src, "patterns"), path.join(dataDir, "patterns"), missing, "patterns/（对标拆解卡）");
  await copyIfPresent(path.join(src, "knowledge"), path.join(dataDir, "knowledge"), missing, "knowledge/（知识库）");
  await copyIfPresent(
    path.join(src, "sensitive-words"),
    path.join(dataDir, "sensitive-words"),
    missing,
    "sensitive-words/",
  );
  // 改稿对比对进 system prompt（「越用越像你」那一块），不拷 = 管线格子少一块声音材料
  await copyIfPresent(path.join(src, "learnings"), path.join(dataDir, "learnings"), missing, "learnings/（改稿对比对）");

  await fs.writeFile(stamp, `copied from ${src} at ${new Date().toISOString()}\n`, "utf-8");
  return { dataDir, missing, rebuilt: true };
}
