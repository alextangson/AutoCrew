#!/usr/bin/env npx tsx
/**
 * P0 实验跑格器（spec §6 P0）：2×2 = {direct, pipeline} × {nofacts, facts}，外加消融格 pipeline-noreview。
 *
 *   npx tsx experiments/p0-inputs-vs-structure/run-cell.ts \
 *     --topic <topicId> --cell direct|pipeline|pipeline-noreview --facts <path|none> --rep <n>
 *
 * 红线：**绝不写生产 ~/.autocrew**。跑之前先把管线要读的那几样拷进
 * runs/<topicId>/_data/，然后同时用显式 dataDir 参数与 AUTOCREW_DATA_DIR 环境变量把整个
 * 进程钉在那儿（见 lib/isolate.ts）。
 *
 * 事实包注入口是**现成的** `ScriptRequest.research` 字段（script-prompt.ts:22）：
 * composeResearchSlot 会把简报/知识片段追加在它后面，用户材料永远在最前。不改生产代码。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildIsolatedDataDir, sourceDataDir } from "./lib/isolate.js";
import { createRecorder, type RecordedCall } from "./lib/recorder.js";
import { makeMockRunLoop } from "./lib/mock-loop.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(HERE, "runs");

type Cell = "direct" | "pipeline" | "pipeline-noreview";
const CELLS: Cell[] = ["direct", "pipeline", "pipeline-noreview"];

interface Args {
  topicId: string;
  cell: Cell;
  factsPath: string | null;
  rep: number;
  platform: string;
  mock: boolean;
  refreshData: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const topicId = get("--topic");
  const cell = get("--cell") as Cell | undefined;
  const facts = get("--facts");
  const rep = Number(get("--rep") ?? "1");
  if (!topicId) throw new Error("缺 --topic <topicId>");
  if (!cell || !CELLS.includes(cell)) throw new Error(`--cell 只能是 ${CELLS.join(" | ")}`);
  if (!facts) throw new Error("缺 --facts <事实包路径|none>（显式写 none 才算「无事实包」，不许靠省略）");
  if (!Number.isInteger(rep) || rep < 1) throw new Error("--rep 要是 ≥1 的整数");
  return {
    topicId,
    cell,
    factsPath: facts === "none" ? null : path.resolve(facts),
    rep,
    platform: get("--platform") ?? "wechat_mp",
    mock: argv.includes("--mock"),
    refreshData: argv.includes("--refresh-data"),
  };
}

interface Meta {
  cell: Cell;
  facts: "facts" | "nofacts";
  rep: number;
  topicId: string;
  topicTitle: string;
  platform: string;
  reviewDisabled: boolean;
  mock: boolean;
  startedAt: string;
  durationMs: number;
  resolvedWriterRoute: { baseUrl: string; model: string; protocol: string };
  factPack?: { path: string; sha256: string; chars: number };
  isolatedDataDir: string;
  sourceDataDir: string;
  missingFromIsolation: string[];
  tokensUsed: number;
  /** 直写格才有：loop 的收尾原因 */
  stopReason?: string;
  /** 管线格才有 */
  pipeline?: {
    contentId: string;
    review: unknown;
    gateFailures: string[];
    violations: string[];
    rulesApplied: number;
    wroteWithoutBrief: boolean;
    wroteWithoutAngle: boolean;
  };
  warnings: string[];
  /** 每一轮模型调用的完整 system+user（可审计性要求；不含 apiKey） */
  calls: RecordedCall[];
}

/** 直写格的极简 system prompt：平台 + 用创作者的声音 + 事实包原文。没有赛道包、没有 gate、没有去 AI 味。 */
function directSystemPrompt(platform: string, factPack: string | null): string {
  const parts = [
    `你在为「${platform}」平台写一篇稿子。`,
    "用创作者本人的声音写：第一人称，说人话，不要 AI 腔。",
  ];
  if (factPack) {
    parts.push(
      "",
      "以下是创作者本人口述的第一手材料，请如实使用，不要编造材料之外的事实：",
      "",
      factPack,
    );
  }
  return parts.join("\n");
}

async function readFactPack(p: string | null): Promise<{ text: string; sha: string; chars: number } | null> {
  if (!p) return null;
  const text = (await fs.readFile(p, "utf-8")).trim();
  if (!text) throw new Error(`事实包是空的：${p}——空文件跑出来的「facts 格」是假的对照组`);
  return { text, sha: createHash("sha256").update(text).digest("hex"), chars: text.length };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const src = sourceDataDir(); // 必须在改 AUTOCREW_DATA_DIR 之前读
  const iso = await buildIsolatedDataDir(args.topicId, RUNS_ROOT, args.refreshData);
  // 两把锁：显式参数管住主链路，环境变量兜住少数 getDataDir() 无参调用
  process.env.AUTOCREW_DATA_DIR = iso.dataDir;
  const dataDir = iso.dataDir;

  // 动态导入必须在锁上环境变量**之后**——模块顶层没有读盘，但保持这个顺序是纪律
  const { loadEngineConfig, resolveEngineRoute } = await import("../../src/engine/config.js");
  const { runLoop } = await import("../../src/engine/loop.js");
  const { getTopic } = await import("../../src/storage/local-store.js");
  const { generateScript } = await import("../../src/modules/writing/generate-script.js");

  const topic = await getTopic(args.topicId, dataDir);
  if (!topic) throw new Error(`隔离目录里读不到选题 ${args.topicId}（${dataDir}/topics）`);
  const pack = await readFactPack(args.factsPath);
  const config = await loadEngineConfig(dataDir);
  const writer = resolveEngineRoute(config, "writer", config.strongModel);

  const impl = args.mock ? makeMockRunLoop() : runLoop;
  const { runLoopImpl, calls } = createRecorder({ disableReview: args.cell === "pipeline-noreview", impl });
  const warnings: string[] = [];
  const startedAt = new Date();
  const t0 = Date.now();

  let draft: string;
  let meta: Meta = {
    cell: args.cell,
    facts: pack ? "facts" : "nofacts",
    rep: args.rep,
    topicId: args.topicId,
    topicTitle: topic.title,
    platform: args.platform,
    reviewDisabled: args.cell === "pipeline-noreview",
    mock: args.mock,
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    resolvedWriterRoute: {
      baseUrl: writer.config.baseUrl,
      model: writer.model,
      protocol: writer.config.protocol ?? "openai",
    },
    ...(pack && args.factsPath ? { factPack: { path: args.factsPath, sha256: pack.sha, chars: pack.chars } } : {}),
    isolatedDataDir: dataDir,
    sourceDataDir: src,
    missingFromIsolation: iso.missing,
    tokensUsed: 0,
    warnings,
    calls,
  };

  if (args.cell === "direct") {
    // 直写：同一条 writer 路由、极简 prompt、无工具、无闸口、无去 AI 味
    const result = await runLoopImpl(writer.config, {
      model: writer.model,
      systemPrompt: directSystemPrompt(args.platform, pack?.text ?? null),
      userMessage: `选题：${topic.title}`,
      maxTurns: 1,
      maxTotalTokens: 80000,
      logMeta: { runId: `p0-direct-${Date.now()}`, agent: "direct-writer" },
    });
    draft = result.finalMessage.trim();
    if (!draft) throw new Error(`直写格没拿到正文（loop ${result.stopReason}，turns=${result.turns}）`);
    meta = { ...meta, tokensUsed: result.totalTokens, stopReason: result.stopReason };
  } else {
    const generated = await generateScript(
      {
        topic: topic.title,
        platform: args.platform as never,
        topicId: args.topicId,
        ...(pack ? { research: pack.text } : {}),
      },
      dataDir,
      { runLoopImpl, onWarn: (m) => warnings.push(m) },
    );
    draft = `# ${generated.title}\n\n${generated.body}\n\n${generated.hashtags.map((h) => `#${h}`).join(" ")}`.trim();
    meta = {
      ...meta,
      tokensUsed: generated.tokensUsed,
      pipeline: {
        contentId: generated.contentId,
        review: generated.review,
        gateFailures: generated.gateFailures,
        violations: generated.violations,
        rulesApplied: generated.rulesApplied,
        wroteWithoutBrief: generated.wroteWithoutBrief,
        wroteWithoutAngle: generated.wroteWithoutAngle,
      },
    };
  }

  meta.durationMs = Date.now() - t0;
  const outDir = path.join(RUNS_ROOT, args.topicId, `${args.cell}-${meta.facts}-rep${args.rep}`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "draft.md"), `${draft}\n`, "utf-8");
  await fs.writeFile(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");

  console.log(`[p0] ${args.cell} / ${meta.facts} / rep${args.rep} → ${outDir}`);
  console.log(`[p0] 模型 ${meta.resolvedWriterRoute.model} @ ${meta.resolvedWriterRoute.baseUrl}`);
  console.log(`[p0] ${meta.durationMs}ms，${meta.tokensUsed} tokens，正文 ${draft.length} 字符`);
  if (iso.missing.length) console.log(`[p0] 隔离目录缺料：${iso.missing.join("；")}`);
  for (const w of warnings) console.log(`[p0][warn] ${w}`);
}

main()
  .catch((err: unknown) => {
    console.error(`[p0] 失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 传输观察器是个常驻环回服务，不关掉进程就吊在那儿不退（同 src/engine/*.test.ts 的收尾）
    const { shutdownObserver } = await import("../../src/engine/observer.js");
    await shutdownObserver();
  });
