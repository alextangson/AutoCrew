/**
 * 复盘生成器(V5.6 /goal 闭环 + P2b/P2c 假设闭环):
 * 周复盘 = 产出盘点 + 数据表现 + 对照目标 + 下周建议(≤3 条可执行);
 * 月复盘 = 再深一层:受众画像漂移、内容支柱表现、策略调整提案——
 * 提案只是提案,创始人确认后才落地(画像/目标修改走既有确认流,不自行改)。
 *
 * 分工(spec §5.3):**证据由代码聚合、裁决由代码算定**(metrics-window + hypothesis-judge),
 * 模型只做两件事——解释已裁决的假设、提出 ≤3 条新假设。模型不得改判,也不自己算指标。
 *
 * 写序(spec §5.4):报告落盘成功 → 才写台账;台账写失败 → 报告尾部追加明示,不静默。
 * 报告文件名带时间戳型 runId,同日重跑不互相覆盖。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { getDataDir } from "../../storage/local-store.js";
import { gatherFacts, type RetroFacts } from "./retro-facts.js";
import { appendHypotheses, parseHypothesisProposals, METRIC_FOCUS_KEYS, type Hypothesis } from "./hypotheses.js";
import { applyJudgement } from "./hypothesis-judge.js";
import type { ProductionTiming } from "./production-timing.js";

export type RetroMode = "weekly" | "monthly";

export interface RetroHypothesisResult {
  /** 本期被代码裁决的开放假设数 */
  judged: number;
  /** 其中盖上终裁(supported/refuted)的条数;inconclusive 保持 open 等下期 */
  closed: number;
  /** 本期落盘的新假设条数 */
  proposed: number;
  /** 台账是否按预期落账(校验失败或写盘失败都是 false) */
  written: boolean;
  /** 未落账的如实原因——同时会追加到报告尾部 */
  error?: string;
}

export interface RetroResult {
  mode: RetroMode;
  from: string;
  to: string;
  file: string;
  /** 本次运行身份(= 文件名去掉 .md);假设的 retroRunId 指向它 */
  runId: string;
  markdown: string;
  tokensUsed: number;
  /** 生产用时（代码算的事实，与报告正文同源；调用方可直接展示，不必从 markdown 里抠） */
  timing: ProductionTiming;
  hypotheses: RetroHypothesisResult;
}

/** 同日重跑不覆盖:日期后可带 T+6 位时分秒(老报告没有这段,照旧可列可读) */
const FILE_RE = /^retro-(weekly|monthly)-(\d{4}-\d{2}-\d{2})(?:T\d{6})?\.md$/;

const OBSERVATIONAL_FOOTER =
  "> 口径说明:本报告的假设裁决与数据对比均为观察性结论,非对照实验,混杂因素(题材/时长/发布时段/投流)未隔离。";

/** 免责口径不靠模型自觉:模型没写就由代码补上 */
function withFooter(markdown: string): string {
  return markdown.includes("观察性结论") ? markdown : `${markdown}\n\n${OBSERVATIONAL_FOOTER}`;
}

const HYPOTHESIS_RULES =
  "\n## 假设复盘(固定小节,放在建议之前)\n" +
  "1) 已裁决假设:事实块里每条假设的裁决(supported/refuted/inconclusive)与证据**都是代码算定的**," +
  "你只解释「为什么可能是这样」并给下一步动作——**严禁改判、严禁自己重算指标、严禁给出事实块里没有的数字**;" +
  "样本不足判成 inconclusive 的,就如实说数据还不够,不要替它下结论。\n" +
  "2) 报告正文必须写上一句:「以上裁决为观察性结论,非对照实验,混杂因素未隔离。」\n" +
  "3) 新假设:提 ≤3 条可证伪的假设(数据太少就少提或不提),通过 submit_retro 的 hypotheses 参数提交," +
  "值是 JSON 数组字符串,不要写进报告正文:\n" +
  '[{"statement":"一句话假设","metricFocus":"completionRate","direction":"up","scope":{"platform":"douyin"},"nextAction":"下一步具体动作"}]\n' +
  `metricFocus 只能取:${METRIC_FOCUS_KEYS.join("/")};direction 只能是 up/down;nextAction 必填;没有新假设就传 []。`;

const WEEKLY_PROMPT =
  "你是编辑部数据分析师,为创作者写每周复盘。只基于给到的事实数据写,不编造;数据少就直说数据少,并给出补数据的具体动作。" +
  "结构(markdown):\n# 周复盘 <日期区间>\n## 本周产出\n## 数据表现\n(事实块给的是增量/cohort/定龄三视图,累计快照已经排除;直接引用,不要自己换算)\n## 对照目标\n(目标进展一句话;没设目标就提醒设,并给一个候选目标)\n## 假设复盘\n## 下周建议\n(≤3 条,每条具体到能直接执行,围绕目标排优先级)\n" +
  HYPOTHESIS_RULES +
  "\n语气直接,像靠谱同事,不客套不注水。完成后调用 submit_retro 提交,不要把报告写在普通回复里。";

const MONTHLY_PROMPT =
  "你是编辑部数据分析师,为创作者写月度深度复盘。只基于给到的事实数据写,不编造;数据不足的结论要标注置信度低。" +
  "结构(markdown):\n# 月度复盘 <日期区间>\n## 本月产出\n## 数据表现\n## 对照目标\n## 受众画像漂移\n(画像与实际停留/收藏行为吻不吻合;不吻合给修正方向)\n## 内容支柱表现\n(哪类主题跑得动、哪类该砍)\n## 假设复盘\n## 策略调整提案\n(每条明确标注『提案——需创始人确认后执行』;涉及画像/目标修改的,引导到校准中心或对话里确认,不要自行改)\n" +
  HYPOTHESIS_RULES +
  "\n语气直接。完成后调用 submit_retro 提交。";

interface Captured {
  markdown: string | null;
  proposals: Hypothesis[];
  /** 假设块解析/校验失败的如实理由;成功或未提假设时为 null */
  error: string | null;
  attempts: number;
}

/**
 * 提交工具。报告与假设分开结账:报告合格就收下,假设块不合格只重试一次
 * (第二次仍不合格 → 收下报告、本期不写新假设,并把原因带出去明示)。
 */
function buildSubmitTool(captured: Captured, runId: string): LoopTool {
  return {
    name: "submit_retro",
    description: "提交复盘报告全文(markdown)与本期新假设(hypotheses,JSON 数组字符串)。",
    parameters: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "完整复盘报告,markdown 格式" },
        hypotheses: {
          type: "string",
          description: '本期新假设 JSON 数组字符串,≤3 条,每条含 statement/metricFocus/direction/nextAction;没有就传 []',
        },
      },
      required: ["markdown"],
    },
    execute(args) {
      const md = args.markdown;
      if (typeof md !== "string" || md.trim().length < 200) {
        return "Error: 报告太短(需 ≥200 字符的完整报告),请写完整后重新调用 submit_retro";
      }
      captured.markdown = md.trim();

      const raw = typeof args.hypotheses === "string" ? args.hypotheses.trim() : "";
      if (!raw) {
        captured.proposals = [];
        captured.error = null;
        return "已收到复盘(本期未提新假设)";
      }
      const parsed = parseHypothesisProposals(raw, { retroRunId: runId });
      if (parsed.ok) {
        captured.proposals = parsed.value;
        captured.error = null;
        return `已收到复盘,新假设 ${parsed.value.length} 条`;
      }
      captured.attempts += 1;
      captured.proposals = [];
      captured.error = parsed.errors.join("；");
      if (captured.attempts === 1) {
        return `Error: 假设块不合格(${captured.error})。报告保持原样,只修正 hypotheses 参数后重新调用 submit_retro;实在修不好就传 []`;
      }
      return "已收到复盘;假设块两次都不合格,本期台账不写入新假设";
    },
  };
}

/** 报告先落盘,再写台账(spec §5.4);台账写失败在报告尾部追加明示 */
async function writeLedger(
  facts: RetroFacts,
  captured: Captured,
  dataDir?: string,
): Promise<RetroHypothesisResult> {
  const result: RetroHypothesisResult = {
    judged: facts.judged.length,
    closed: facts.judged.filter((j) => j.verdict.status !== "inconclusive").length,
    proposed: 0,
    written: true,
  };
  if (facts.ledgerError) {
    // 台账读不出来 = 手上没有开放假设的原始记录,盲写会把别人的记录覆盖成半截
    return { ...result, written: false, error: `台账读取失败,本期未做假设裁决与写入:${facts.ledgerError}` };
  }
  const records = [
    ...facts.judged.map((j) => applyJudgement(j.hypothesis, j.verdict)),
    ...captured.proposals,
  ];
  try {
    await appendHypotheses(records, dataDir);
    result.proposed = captured.proposals.length;
  } catch (err) {
    result.written = false;
    result.error = `台账写入失败:${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  if (captured.error) {
    result.written = false;
    result.error = `新假设未写入台账(两次校验失败):${captured.error}`;
  }
  return result;
}

/** 报告落盘 → 写台账 → 台账没落成就在报告尾部追加明示（spec §5.4 的写序） */
async function persist(
  runId: string,
  submitted: string,
  facts: RetroFacts,
  captured: Captured,
  dataDir?: string,
): Promise<{ file: string; markdown: string; hypotheses: RetroHypothesisResult }> {
  const dir = path.join(getDataDir(dataDir), "reports");
  await fs.mkdir(dir, { recursive: true });
  const file = `${runId}.md`;
  let markdown = withFooter(submitted);
  await fs.writeFile(path.join(dir, file), markdown + "\n", "utf-8");

  const hypotheses = await writeLedger(facts, captured, dataDir);
  if (!hypotheses.written && hypotheses.error) {
    const note = `\n> ⚠️ 台账未写入:${hypotheses.error}\n`;
    markdown += note;
    await fs.appendFile(path.join(dir, file), note, "utf-8").catch(() => {});
  }
  return { file, markdown, hypotheses };
}

export async function generateRetro(
  mode: RetroMode,
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<RetroResult> {
  const config = await loadEngineConfig(dataDir);
  const facts = await gatherFacts(mode === "weekly" ? 7 : 30, dataDir);
  const stamp = new Date().toISOString();
  const runId = `retro-${mode}-${stamp.slice(0, 10)}T${stamp.slice(11, 19).replace(/:/g, "")}`;
  const captured: Captured = { markdown: null, proposals: [], error: null, attempts: 0 };

  const loopFn = deps?.runLoopImpl ?? runLoop;
  const analytics = resolveEngineRoute(config, "analytics", config.strongModel);
  const result = await loopFn(analytics.config, {
    model: analytics.model,
    systemPrompt: mode === "weekly" ? WEEKLY_PROMPT : MONTHLY_PROMPT,
    userMessage: `${facts.block}\n\n请生成${mode === "weekly" ? "周" : "月度"}复盘报告。`,
    tools: [buildSubmitTool(captured, runId)],
    maxTurns: 4, // 3 轮正常 + 1 轮假设块重试
    maxTotalTokens: 30000,
    logMeta: { agent: "analyst" },
  });

  if (!captured.markdown) {
    throw new Error("复盘生成失败:模型未调用 submit_retro 提交报告");
  }

  const { file, markdown, hypotheses } = await persist(runId, captured.markdown, facts, captured, dataDir);

  return {
    mode,
    from: facts.fromDate,
    to: facts.toDate,
    file,
    runId,
    markdown,
    tokensUsed: result.totalTokens,
    timing: facts.timing,
    hypotheses,
  };
}

export async function listRetros(
  dataDir?: string,
): Promise<Array<{ file: string; mode: RetroMode; date: string; runId: string }>> {
  const dir = path.join(getDataDir(dataDir), "reports");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  return files
    .flatMap((f) => {
      const m = f.match(FILE_RE);
      return m ? [{ file: f, mode: m[1] as RetroMode, date: m[2], runId: f.replace(/\.md$/, "") }] : [];
    })
    // 日期倒序;同日多次重跑按文件名(含时分秒)倒序,最新的排最前
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.file < b.file ? 1 : -1));
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
