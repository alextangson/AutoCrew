/** 选题会纪要（人读）：从 meetings/<date>.json 渲染，进「我的内容/选题会」只读副本（同复盘栏的做法） */
import type { MeetingRecord } from "./meeting-store.js";

const TIER_LABEL: Record<string, string> = { core: "核心受众", adjacent: "邻近受众", surprise: "意外受众" };

function slotBlock(s: MeetingRecord["slots"][number], i: number): string {
  return [
    `### ${i + 1}. ${s.title}`,
    "",
    `- 给谁看：${TIER_LABEL[s.persona.key] ?? s.persona.key}（${s.persona.name}）`,
    `- 观众拿走什么：${s.payoff}`,
    `- 形式：${s.format}${s.line ? `；内容线：${s.line}` : ""}`,
    `- 为什么现在：${s.whyNow}`,
    `- 数据依据：${s.dataBasis}`,
    `- 赌什么：${s.bet}（看 ${s.watch.platform} D+${s.watch.day} ${s.watch.metric}，高于同平台同龄中位数的概率 ${s.probability}%）`,
    `- 事前验尸：${s.premortem}`,
    ...(s.angleDecision ? [`- 已有立意卡的处理：${s.angleDecision === "rerun" ? "重跑立意" : "接受偏离"}`] : []),
  ].join("\n");
}

export function renderMeetingMinutes(m: MeetingRecord): string {
  const parts = [
    `# ${m.date} 选题会纪要`,
    "",
    `只读副本，由 meetings/${m.date}.json（第 ${m.revision} 版）生成。选中≠开工：片单只在看板「选题」列置顶，开写仍是一条一个会话。`,
    "",
    "## 上次下注对账",
    "",
    ...(m.reviews.length ? m.reviews.map((r) => `- ${r.hypothesisId}：${r.verdict}；还会这么选吗——${r.wouldRepeat}`) : ["- （无）"]),
    "",
    `## 本周片单（${m.slots.length} 条）`,
    "",
    ...(m.slots.length ? m.slots.map(slotBlock) : ["这次一条都没选。"]),
    "",
    "## 毙掉的题",
    "",
    ...(m.rejected.length ? m.rejected.map((r) => `- ${r.title}：${r.reason}`) : ["- （无）"]),
  ];
  if (m.notes) parts.push("", "## 备注", "", m.notes);
  return parts.join("\n") + "\n";
}
