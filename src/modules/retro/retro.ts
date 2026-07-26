/**
 * 复盘生成器(V5.6 /goal 闭环):
 * 周复盘 = 产出盘点 + 数据表现 + 对照目标 + 下周建议(≤3 条可执行);
 * 月复盘 = 再深一层:受众画像漂移、内容支柱表现、策略调整提案——
 * 提案只是提案,创始人确认后才落地(画像/目标修改走既有确认流,不自行改)。
 * v1 手动触发(Dashboard 目标卡),跑顺一个月后再谈定时。报告落 <dataDir>/reports/。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { listContents, getDataDir } from "../../storage/local-store.js";
import { listLatestOutcomes } from "../flywheel/outcome-store.js";
import type { OutcomeMetrics } from "../flywheel/outcome-schema.js";
import { loadProfile, personaSummary, goalSummary } from "../profile/creator-profile.js";
import { computeProductionTiming, timingFactsBlock, type ProductionTiming } from "./production-timing.js";

export type RetroMode = "weekly" | "monthly";

export interface RetroResult {
  mode: RetroMode;
  from: string;
  to: string;
  file: string;
  markdown: string;
  tokensUsed: number;
  /** 生产用时（代码算的事实，与报告正文同源；调用方可直接展示，不必从 markdown 里抠） */
  timing: ProductionTiming;
}

const DAY_MS = 86_400_000;
const FILE_RE = /^retro-(weekly|monthly)-(\d{4}-\d{2}-\d{2})\.md$/;

const METRIC_LABELS: Array<[keyof OutcomeMetrics, string]> = [
  ["views", "阅读/播放"],
  ["likes", "赞"],
  ["favorites", "藏"],
  ["comments", "评"],
  ["follows", "粉"],
  ["completionRate", "完播%"],
];

function metricsLine(m: OutcomeMetrics): string {
  return METRIC_LABELS.flatMap(([k, label]) => (typeof m[k] === "number" ? [`${label} ${m[k]}`] : [])).join(" · ");
}

const WEEKLY_PROMPT =
  "你是编辑部数据分析师,为创作者写每周复盘。只基于给到的事实数据写,不编造;数据少就直说数据少,并给出补数据的具体动作。" +
  "结构(markdown):\n# 周复盘 <日期区间>\n## 本周产出\n## 数据表现\n## 对照目标\n(目标进展一句话;没设目标就提醒设,并给一个候选目标)\n## 下周建议\n(≤3 条,每条具体到能直接执行,围绕目标排优先级)\n" +
  "语气直接,像靠谱同事,不客套不注水。完成后调用 submit_retro 提交,不要把报告写在普通回复里。";

const MONTHLY_PROMPT =
  "你是编辑部数据分析师,为创作者写月度深度复盘。只基于给到的事实数据写,不编造;数据不足的结论要标注置信度低。" +
  "结构(markdown):\n# 月度复盘 <日期区间>\n## 本月产出\n## 数据表现\n## 对照目标\n## 受众画像漂移\n(画像与实际停留/收藏行为吻不吻合;不吻合给修正方向)\n## 内容支柱表现\n(哪类主题跑得动、哪类该砍)\n## 策略调整提案\n(每条明确标注『提案——需创始人确认后执行』;涉及画像/目标修改的,引导到校准中心或对话里确认,不要自行改)\n" +
  "语气直接。完成后调用 submit_retro 提交。";

interface RetroFacts {
  fromDate: string;
  toDate: string;
  block: string;
  timing: ProductionTiming;
}

async function gatherFacts(mode: RetroMode, dataDir?: string): Promise<RetroFacts> {
  const days = mode === "weekly" ? 7 : 30;
  const fromIso = new Date(Date.now() - days * DAY_MS).toISOString();
  const fromDate = fromIso.slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);

  const [profile, contents, outcomes] = await Promise.all([
    loadProfile(dataDir),
    listContents(dataDir).catch(() => []),
    listLatestOutcomes(dataDir).catch(() => []),
  ]);

  const created = contents.filter((c) => c.createdAt >= fromIso);
  const published = contents.filter((c) => c.publishedAt && c.publishedAt >= fromIso);
  const judged = contents.filter((c) => c.adoption?.recordedAt && c.adoption.recordedAt >= fromIso);
  const adopted = judged.filter((c) => c.adoption && ["adopted", "light_edit"].includes(c.adoption.verdict)).length;
  const windowOutcomes = outcomes.filter((o) => o.metricDate >= fromDate);
  // 用时是算出来的,不是让模型估的——算好的事实进 prompt,模型只负责解读
  const timing = computeProductionTiming(published);

  const contentLine = (c: (typeof contents)[number]) => `- 《${c.title}》(${c.platform || "未定平台"}·${c.status})`;
  const parts: string[] = [
    `复盘窗口:${fromDate} ~ ${toDate}(${days} 天)`,
    `创作者定位:${profile?.industry || "未填写"}`,
    `目标:${goalSummary(profile?.goal) || "未设定"}`,
    `受众画像:${personaSummary(profile?.audiencePersona, { allTiers: true }) || "未建立"}` +
      (profile?.audiencePersona?.calibratedAt ? `(校准于 ${profile.audiencePersona.calibratedAt.slice(0, 10)})` : "(未校准)"),
    "",
    `本期新建稿件 ${created.length} 篇:`,
    created.length ? created.slice(0, 15).map(contentLine).join("\n") : "(无)",
    `本期发布 ${published.length} 篇:`,
    published.length ? published.slice(0, 15).map(contentLine).join("\n") : "(无)",
    `本期稿件裁决 ${judged.length} 篇` +
      (judged.length ? `,采纳率 ${Math.round((adopted / judged.length) * 100)}%(采纳+轻改 ${adopted})` : ""),
    `本期数据快照 ${windowOutcomes.length} 条:`,
    windowOutcomes.length
      ? windowOutcomes.slice(0, 20).map((o) => `- 《${o.platformTitle}》(${o.platform}) ${metricsLine(o.metrics)}`).join("\n")
      : "(无——提醒创作者回填数据,复盘才有据可依)",
    "",
    timingFactsBlock(timing),
  ];
  return { fromDate, toDate, block: parts.join("\n"), timing };
}

export async function generateRetro(
  mode: RetroMode,
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<RetroResult> {
  const config = await loadEngineConfig(dataDir);
  const facts = await gatherFacts(mode, dataDir);
  const captured = { markdown: null as string | null };
  const submitTool: LoopTool = {
    name: "submit_retro",
    description: "提交复盘报告全文(markdown)。",
    parameters: {
      type: "object",
      properties: { markdown: { type: "string", description: "完整复盘报告,markdown 格式" } },
      required: ["markdown"],
    },
    execute(args) {
      const md = args.markdown;
      if (typeof md !== "string" || md.trim().length < 200) {
        return "Error: 报告太短(需 ≥200 字符的完整报告),请写完整后重新调用 submit_retro";
      }
      captured.markdown = md.trim();
      return "已收到复盘";
    },
  };

  const loopFn = deps?.runLoopImpl ?? runLoop;
  const analytics = resolveEngineRoute(config, "analytics", config.strongModel);
  const result = await loopFn(analytics.config, {
    model: analytics.model,
    systemPrompt: mode === "weekly" ? WEEKLY_PROMPT : MONTHLY_PROMPT,
    userMessage: `${facts.block}\n\n请生成${mode === "weekly" ? "周" : "月度"}复盘报告。`,
    tools: [submitTool],
    maxTurns: 3,
    maxTotalTokens: 30000,
    logMeta: { agent: "analyst" },
  });

  if (!captured.markdown) {
    throw new Error("复盘生成失败:模型未调用 submit_retro 提交报告");
  }

  const dir = path.join(getDataDir(dataDir), "reports");
  await fs.mkdir(dir, { recursive: true });
  const file = `retro-${mode}-${facts.toDate}.md`;
  await fs.writeFile(path.join(dir, file), captured.markdown + "\n", "utf-8");
  return {
    mode,
    from: facts.fromDate,
    to: facts.toDate,
    file,
    markdown: captured.markdown,
    tokensUsed: result.totalTokens,
    timing: facts.timing,
  };
}

export async function listRetros(dataDir?: string): Promise<Array<{ file: string; mode: RetroMode; date: string }>> {
  const dir = path.join(getDataDir(dataDir), "reports");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  return files
    .flatMap((f) => {
      const m = f.match(FILE_RE);
      return m ? [{ file: f, mode: m[1] as RetroMode, date: m[2] }] : [];
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 文件名白名单校验——这是对外暴露的读文件口,不许路径逃逸 */
export async function readRetro(dataDir: string | undefined, file: string): Promise<string | null> {
  if (!FILE_RE.test(file)) return null;
  try {
    return await fs.readFile(path.join(getDataDir(dataDir), "reports", file), "utf-8");
  } catch {
    return null;
  }
}
