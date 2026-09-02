#!/usr/bin/env npx tsx
/**
 * P0 实验跑格器（spec v3 §6）：{direct, writer, pipeline} × {brief, full}。
 *
 *   npx tsx experiments/p0-inputs-vs-structure/run-cell.ts \
 *     --topic <topicId> --cell direct|writer|pipeline --research brief|full --rep <n> [--platform douyin] [--mock]
 *
 * 变量只有一个：**多少调研到达写手**。
 *   brief = 生产现状——buildBriefBlock 的 2800 字摘要
 *   full  = 简报全文（含四视角）+ 创作者内部语料（口播转写、审定稿），不裁剪
 * 创作者不提供任何输入。
 *
 * 三个流程档：
 *   direct   同一条 writer 路由、极简 prompt、单轮、无工具、无质量门、无人味化——「聊天里直写」的替身
 *   writer   AutoCrew 写手轮 + 质量门 + 人味化，审稿轮短路（消融）
 *   pipeline AutoCrew 现状全流程：写手 → AI 审稿 → 修订
 *
 * 红线：**绝不写生产 ~/.autocrew**。管线要读的东西拷进 runs/<topicId>/_data-<research>/，
 * 用显式 dataDir + AUTOCREW_DATA_DIR 两把锁钉住（lib/isolate.ts）。full 档的隔离目录
 * **不带 jobs.jsonl**：没有简报指针，生产代码就不会再把 2800 字块追加进去，
 * 于是 full 档的调研只有我们通过现成的 `ScriptRequest.research`（RAW 注入）给的那一份。不改生产代码。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildIsolatedDataDir, sourceDataDir } from "./lib/isolate.js";
import { createRecorder, type RecordedCall } from "./lib/recorder.js";
import { makeMockRunLoop } from "./lib/mock-loop.js";
import { renderFullBrief } from "./lib/render-brief.js";
import { collectInternalCorpus, type InternalCorpus } from "./lib/internal-corpus.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(HERE, "runs");

type Cell = "direct" | "writer" | "pipeline";
type Research = "brief" | "full";
const CELLS: Cell[] = ["direct", "writer", "pipeline"];
const RESEARCH: Research[] = ["brief", "full"];

interface Args {
  topicId: string;
  cell: Cell;
  research: Research;
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
  const research = get("--research") as Research | undefined;
  const rep = Number(get("--rep") ?? "1");
  if (!topicId) throw new Error("缺 --topic <topicId>");
  if (!cell || !CELLS.includes(cell)) throw new Error(`--cell 只能是 ${CELLS.join(" | ")}`);
  if (!research || !RESEARCH.includes(research)) throw new Error(`--research 只能是 ${RESEARCH.join(" | ")}（必须显式写）`);
  if (!Number.isInteger(rep) || rep < 1) throw new Error("--rep 要是 ≥1 的整数");
  return {
    topicId,
    cell,
    research,
    rep,
    platform: get("--platform") ?? "douyin",
    mock: argv.includes("--mock"),
    refreshData: argv.includes("--refresh-data"),
  };
}

interface Meta {
  cell: Cell;
  research: Research;
  rep: number;
  topicId: string;
  topicTitle: string;
  platform: string;
  reviewDisabled: boolean;
  mock: boolean;
  startedAt: string;
  durationMs: number;
  resolvedWriterRoute: { baseUrl: string; model: string; protocol: string };
  /** 这一格实际交给写手的调研文本：字符数 + sha256（正文在 calls[].user 里能看到） */
  researchInput: { chars: number; sha256: string; briefRevision: number | null; internal?: InternalCorpus["chunks"]; internalScanned?: InternalCorpus["scanned"] };
  isolatedDataDir: string;
  sourceDataDir: string;
  missingFromIsolation: string[];
  tokensUsed: number;
  stopReason?: string;
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
  calls: RecordedCall[];
}

/** 直写格的极简 system prompt：平台 + 用创作者的声音 + 调研材料原文。没有赛道包、没有 gate、没有去 AI 味。 */
function directSystemPrompt(platform: string, research: string): string {
  return [
    `你在为「${platform}」平台写一条口播短视频文案。`,
    "用创作者本人的声音写：第一人称，说人话，不要 AI 腔。",
    "",
    "以下是调研材料，请如实使用，不要编造材料之外的事实：",
    "",
    research,
  ].join("\n");
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const src = sourceDataDir(); // 必须在改 AUTOCREW_DATA_DIR 之前读
  const iso = await buildIsolatedDataDir(args.topicId, RUNS_ROOT, {
    refresh: args.refreshData,
    variant: args.research,
    includeBriefPointer: args.research === "brief",
  });
  process.env.AUTOCREW_DATA_DIR = iso.dataDir;
  const dataDir = iso.dataDir;

  const { loadEngineConfig, resolveEngineRoute } = await import("../../src/engine/config.js");
  const { runLoop } = await import("../../src/engine/loop.js");
  const { getTopic } = await import("../../src/storage/local-store.js");
  const { generateScript } = await import("../../src/modules/writing/generate-script.js");
  const { loadLatestBrief } = await import("../../src/modules/research/brief-store.js");
  const { buildBriefBlock } = await import("../../src/modules/research/brief-inject.js");

  const topic = await getTopic(args.topicId, dataDir);
  if (!topic) throw new Error(`隔离目录里读不到选题 ${args.topicId}（${dataDir}/topics）`);
  const config = await loadEngineConfig(dataDir);
  const writer = resolveEngineRoute(config, "writer", config.strongModel);

  // 调研文本：两档都从同一份最新简报出发（简报文件两档隔离目录都有，只是 full 档没有 jobs.jsonl 指针）
  const brief = await loadLatestBrief(args.topicId, dataDir, (m) => console.warn(`[p0][brief] ${m}`));
  if (!brief) throw new Error(`选题 ${args.topicId} 没有简报——P0 测的是「多少调研到达写手」，没调研无从比较`);
  let researchText: string;
  let internal: InternalCorpus | undefined;
  if (args.research === "brief") {
    researchText = buildBriefBlock(brief, { topicStale: false });
  } else {
    internal = await collectInternalCorpus(src, { id: args.topicId, title: topic.title, description: topic.description });
    researchText = [renderFullBrief(brief), internal.text].filter(Boolean).join("\n\n");
  }

  const impl = args.mock ? makeMockRunLoop() : runLoop;
  const { runLoopImpl, calls } = createRecorder({ disableReview: args.cell === "writer", impl });
  const warnings: string[] = [];
  const startedAt = new Date();
  const t0 = Date.now();

  let draft: string;
  let meta: Meta = {
    cell: args.cell,
    research: args.research,
    rep: args.rep,
    topicId: args.topicId,
    topicTitle: topic.title,
    platform: args.platform,
    reviewDisabled: args.cell === "writer",
    mock: args.mock,
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    resolvedWriterRoute: {
      baseUrl: writer.config.baseUrl,
      model: writer.model,
      protocol: writer.config.protocol ?? "openai",
    },
    researchInput: {
      chars: researchText.length,
      sha256: sha(researchText),
      briefRevision: brief.revision,
      ...(internal ? { internal: internal.chunks, internalScanned: internal.scanned } : {}),
    },
    isolatedDataDir: dataDir,
    sourceDataDir: src,
    missingFromIsolation: iso.missing,
    tokensUsed: 0,
    warnings,
    calls,
  };

  if (args.cell === "direct") {
    const result = await runLoopImpl(writer.config, {
      model: writer.model,
      systemPrompt: directSystemPrompt(args.platform, researchText),
      userMessage: `选题：${topic.title}${topic.description ? `\n${topic.description}` : ""}`,
      maxTurns: 1,
      maxTotalTokens: 80000,
      logMeta: { runId: `p0-direct-${Date.now()}`, agent: "direct-writer" },
    });
    draft = result.finalMessage.trim();
    if (!draft) throw new Error(`直写格没拿到正文（loop ${result.stopReason}，turns=${result.turns}）`);
    meta = { ...meta, tokensUsed: result.totalTokens, stopReason: result.stopReason };
  } else {
    // brief 档：research 留空，让生产代码自己按 jobs.jsonl 指针追加 2800 字块（与现状逐字一致）
    // full 档：research = 全文；隔离目录无指针，生产代码不会再追加
    const generated = await generateScript(
      {
        topic: topic.title,
        platform: args.platform as never,
        topicId: args.topicId,
        ...(args.research === "full" ? { research: researchText } : {}),
      },
      dataDir,
      { runLoopImpl, onWarn: (m) => warnings.push(m) },
    );
    draft = `# ${generated.title}\n\n${generated.body}\n\n${generated.hashtags.map((h) => `#${h}`).join(" ")}`.trim();
    if (args.research === "brief" && generated.wroteWithoutBrief) {
      throw new Error("brief 档却裸写了：隔离目录的 jobs.jsonl 指针没生效，这格作废");
    }
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
  const outDir = path.join(RUNS_ROOT, args.topicId, `${args.cell}-${args.research}-rep${args.rep}`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "draft.md"), `${draft}\n`, "utf-8");
  await fs.writeFile(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");

  console.log(`[p0] ${args.cell} / ${args.research} / rep${args.rep} → ${outDir}`);
  console.log(`[p0] 模型 ${meta.resolvedWriterRoute.model} @ ${meta.resolvedWriterRoute.baseUrl}`);
  console.log(`[p0] 调研 ${meta.researchInput.chars} 字符；${meta.durationMs}ms，${meta.tokensUsed} tokens，正文 ${draft.length} 字符`);
  if (internal) {
    console.log(
      `[p0] 内部语料：${internal.chunks.map((c) => `${c.kind}:${c.title.slice(0, 16)}(${c.chars})`).join("，") || "无相关"}；扫描 ${JSON.stringify(internal.scanned)}`,
    );
  }
  if (iso.missing.length) console.log(`[p0] 隔离目录缺料：${iso.missing.join("；")}`);
  for (const w of warnings) console.log(`[p0][warn] ${w}`);
}

main()
  .catch((err: unknown) => {
    console.error(`[p0] 失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { shutdownObserver } = await import("../../src/engine/observer.js");
    await shutdownObserver();
  });
