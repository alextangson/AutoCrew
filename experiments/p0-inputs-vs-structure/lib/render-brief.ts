/**
 * 把一份 ResearchBrief 完整渲染成文本——**不裁剪**。
 *
 * 生产里写手只吃 `buildBriefBlock` 的 2800 字摘要（brief-inject.ts），`perspectives`
 * 整段从没进过任何提示词。`full` 档就是把这份 20–27KB 的 JSON 原样摊开给写手，
 * 看「到达写手的调研量」这个变量本身值多少分。
 *
 * 渲染顺序刻意和 buildBriefBlock 一致（摘要 → 张力 → 角度 → 证据 → 缺口），
 * 再追加四视角全文，这样 brief 档与 full 档的差异只在「多出来的部分」。
 */
import type { ResearchBrief } from "../../../src/modules/research/brief-store.js";

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  return [`## ${title}`, ...lines, ""];
}

export function renderFullBrief(brief: ResearchBrief): string {
  const out: string[] = [
    "<<<RESEARCH_BRIEF_FULL>>>",
    `调研简报 v${brief.revision}（完整版，含四视角全文；引文均来自已读页面，可直接引用）`,
    "",
  ];
  out.push(...section("摘要", [brief.summary]));
  out.push(...section("跨视角张力点", brief.tensions.map((t, i) => `- tension-${i + 1}：${t}`)));
  out.push(...section("角度建议", brief.angleSuggestions.map((a) => `- ${a}`)));
  out.push(
    ...section(
      "证据（简报级）",
      brief.evidence.map((e, i) => `- ev-${i + 1}【${e.claim}】「${e.quote}」——${e.sourceUrl}`),
    ),
  );
  for (const p of brief.perspectives) {
    const lines: string[] = [];
    lines.push(...p.insights.map((x) => `- 洞察：${x.text}（来源 ${x.sourceIds.join(", ")}）`));
    lines.push(...p.evidence.map((e) => `- 证据【${e.claim}】「${e.quote}」（${e.sourceId}）`));
    lines.push(...p.gaps.map((g) => `- 缺口：${g}`));
    out.push(...section(`视角 ${p.name}`, lines));
  }
  if (brief.missingPerspectives.length) out.push(`未跑成的视角：${brief.missingPerspectives.join("、")}`, "");
  out.push(...section("材料缺口（并集）", brief.gaps.map((g) => `- ${g}`)));
  out.push("<<<END_RESEARCH_BRIEF_FULL>>>");
  return out.join("\n");
}
