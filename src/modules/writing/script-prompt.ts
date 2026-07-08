/**
 * Script Prompt Assembly — pure function driving prompt construction.
 *
 * Takes a track pack, optional creator profile, and request (topic + platform + research)
 * and assembles system/user prompts for the writing model. No I/O, no side effects.
 */
import type { TrackPack, StructureMode, QualityGateSpec } from "../packs/pack-schema.js";
import type { CreatorProfile } from "../profile/creator-profile.js";
import { rulesForPlatform } from "../profile/creator-profile.js";
import type { ClipboardPlatform } from "../publish/clipboard-publisher.js";

export interface ScriptRequest {
  topic: string;
  platform: ClipboardPlatform;
  /** 调研材料（可选，RAW 注入） */
  research?: string;
  /** 显式指定赛道包；缺省按平台路由（wechat_mp → 公众号图文，其余 → 口播） */
  packId?: string;
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

  // Role + pack name（包可覆盖：公众号图文写手 vs 口播编剧）
  parts.push(pack.writerRole ?? `你是一名专业的口播脚本编剧，擅长为《${pack.name}》赛道创作高效的内容。`);
  parts.push("");

  // Hooks with instruction
  parts.push("## 钩子（Hook）选择");
  parts.push("从以下钩子类型中只选一种最强的来打开脚本：");
  parts.push("");
  for (const hook of pack.hooks) {
    parts.push(`- **${hook.type}**：${hook.whenToUse}`);
  }
  parts.push("");

  if (pack.structureModes?.length) parts.push(renderStructureModes(pack.structureModes));

  parts.push(renderStructure(pack));

  if (pack.qualityGate) parts.push(renderQualityGate(pack.qualityGate));

  // Platform adjustments
  const platformAdj = pack.platformAdjustments[platform];
  if (platformAdj) {
    parts.push("## 平台特化");
    parts.push(`**篇幅/格式**：${platformAdj.chars}`);
    parts.push(`**风格要求**：${platformAdj.style}`);
    parts.push("");
  }

  const profileSection = profile ? renderProfile(profile, platform) : "";
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

function renderStructureModes(modes: StructureMode[]): string {
  const parts: string[] = ["## 结构模式（选其一）", "按选题特性选择最合适的一种模式展开全文："];
  for (const m of modes) {
    parts.push(`- **${m.name}**：${m.guide}`);
  }
  parts.push("");
  return parts.join("\n");
}

/** Gate 阈值前置进 prompt：让模型第一稿就冲达标线，而不是靠打回轮学习要求 */
function renderQualityGate(gate: QualityGateSpec): string {
  const parts: string[] = ["## 质量硬门禁（提交即校验，未达标会被打回重写）"];
  if (gate.minChars !== undefined) parts.push(`- 全文中文字符 ≥ ${gate.minChars}`);
  if (gate.minDataPoints !== undefined) {
    parts.push(`- 数据引用（数字+百分比/时间/金额等量纲）≥ ${gate.minDataPoints} 处`);
  }
  if (gate.minImageTags !== undefined) {
    parts.push(`- 正文 [IMAGE: 具体画面prompt] 配图标记 ≥ ${gate.minImageTags} 个，分布在不同段落`);
  }
  if (gate.bannedHookPatterns?.length) parts.push("- 开头命中反模式即打回（禁用开头见上方规则）");
  parts.push("");
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

function renderProfile(profile: CreatorProfile, platform: ClipboardPlatform): string {
  const parts: string[] = [];

  // 声音内核 + 当前平台包，其余平台的规则不进上下文（PRD-v4 §4.3 隔离）
  const activeRules = rulesForPlatform(profile, platform);
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
