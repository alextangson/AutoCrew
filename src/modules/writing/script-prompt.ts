/**
 * Script Prompt Assembly — pure function driving prompt construction.
 *
 * Takes a track pack, optional creator profile, and request (topic + platform + research)
 * and assembles system/user prompts for the writing model. No I/O, no side effects.
 */
import type { TrackPack } from "../packs/pack-schema.js";
import type { CreatorProfile } from "../profile/creator-profile.js";
import type { ClipboardPlatform } from "../publish/clipboard-publisher.js";

export interface ScriptRequest {
  topic: string;
  platform: ClipboardPlatform;
  /** 调研材料（可选，RAW 注入） */
  research?: string;
}

export function buildScriptPrompts(
  pack: TrackPack,
  profile: CreatorProfile | null,
  req: ScriptRequest,
): { system: string; user: string } {
  const system = buildSystemPrompt(pack, profile, req.platform);
  const user = buildUserPrompt(req);
  return { system, user };
}

function buildSystemPrompt(pack: TrackPack, profile: CreatorProfile | null, platform: ClipboardPlatform): string {
  const parts: string[] = [];

  // Role + pack name
  parts.push(`你是一名专业的口播脚本编剧，擅长为《${pack.name}》赛道创作高效的内容。`);
  parts.push("");

  // Hooks with instruction
  parts.push("## 钩子（Hook）选择");
  parts.push("从以下钩子类型中只选一种最强的来打开脚本：");
  parts.push("");
  for (const hook of pack.hooks) {
    parts.push(`- **${hook.type}**：${hook.whenToUse}`);
  }
  parts.push("");

  parts.push(renderStructure(pack));

  // Platform adjustments
  const platformAdj = pack.platformAdjustments[platform];
  if (platformAdj) {
    parts.push("## 平台特化");
    parts.push(`**篇幅/格式**：${platformAdj.chars}`);
    parts.push(`**风格要求**：${platformAdj.style}`);
    parts.push("");
  }

  const profileSection = profile ? renderProfile(profile) : "";
  if (profileSection) parts.push(profileSection);

  // Compliance
  parts.push("## 合规声明");
  parts.push(pack.complianceNote);
  parts.push("");

  // Tool submission requirement
  parts.push("## 输出要求");
  parts.push("**必须调用 submit_script 工具提交成品，不要把脚本写在普通回复里。**");
  parts.push("工具需要以下字段：title（标题）、hook（开篇）、body（正文）、cta（行动号召）、hashtags（话题标签）。");

  return parts.join("\n");
}

function renderStructure(pack: TrackPack): string {
  const parts: string[] = ["## 脚本结构规则"];
  const sections: Array<[string, string[]]> = [
    ["### Hook（开篇）", pack.structure.hook],
    ["### Body（正文）", pack.structure.body],
    ["### CTA（行动号召）", pack.structure.cta],
  ];
  for (const [heading, rules] of sections) {
    if (rules.length === 0) continue;
    parts.push(heading);
    for (const rule of rules) {
      parts.push(`- ${rule}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

function renderProfile(profile: CreatorProfile): string {
  const parts: string[] = [];

  const activeRules = profile.writingRules.filter((r) => !r.disabled);
  if (activeRules.length > 0) {
    parts.push("## 个人写作规则");
    for (const rule of activeRules) {
      parts.push(`- ${rule.rule}`);
    }
    parts.push("");
  }

  const { never, always } = profile.styleBoundaries;
  if (never.length > 0 || always.length > 0) {
    parts.push("## 风格边界");
    if (never.length > 0) {
      parts.push("**绝不用**：");
      for (const item of never) {
        parts.push(`- ${item}`);
      }
    }
    if (always.length > 0) {
      parts.push("**必须用**：");
      for (const item of always) {
        parts.push(`- ${item}`);
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}

function buildUserPrompt(req: ScriptRequest): string {
  const parts: string[] = [];

  parts.push(`选题：${req.topic}`);
  parts.push("");

  if (req.research) {
    parts.push(`调研材料：${req.research}`);
  } else {
    parts.push("无调研材料，基于常识写但避免编造数据。");
  }
  parts.push("");

  parts.push(`目标平台：${req.platform}`);

  return parts.join("\n");
}
