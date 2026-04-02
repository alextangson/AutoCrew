/**
 * Predefined workflow templates for AutoCrew.
 *
 * Each template defines a multi-step content pipeline that can be
 * instantiated via the workflow engine.
 */

import type { WorkflowDefinition } from "../../runtime/workflow-engine.js";

const TEMPLATES: WorkflowDefinition[] = [
  {
    id: "xiaohongshu_full",
    name: "小红书一键发布",
    description: "从选题调研到发布的完整小红书内容流水线。包含 AI 写作、去 AI 痕迹、敏感词审查、封面设计等全流程。",
    steps: [
      {
        id: "research",
        name: "选题调研",
        tool: "autocrew_research",
        params: { action: "discover", platform: "xhs" },
      },
      {
        id: "topic",
        name: "创建选题",
        tool: "autocrew_topic",
        params: { action: "create", source: "${research.bestResult}" },
      },
      {
        id: "content",
        name: "AI 写稿",
        tool: "autocrew_content",
        params: { action: "save", topic_id: "${topic.id}" },
        requiresApproval: true,
      },
      {
        id: "humanize",
        name: "去 AI 痕迹",
        tool: "autocrew_humanize",
        params: { action: "rewrite", content_id: "${content.id}" },
      },
      {
        id: "review",
        name: "内容审查",
        tool: "autocrew_review",
        params: { action: "check", content_id: "${content.id}" },
      },
      {
        id: "cover",
        name: "封面设计",
        tool: "autocrew_cover_review",
        params: { action: "generate", content_id: "${content.id}" },
        requiresApproval: true,
      },
      {
        id: "pre_publish",
        name: "发布前检查",
        tool: "autocrew_pre_publish",
        params: { action: "checklist", content_id: "${content.id}" },
      },
      {
        id: "publish",
        name: "发布",
        tool: "autocrew_publish",
        params: { action: "publish", content_id: "${content.id}", platform: "xhs" },
        requiresApproval: true,
      },
    ],
  },
  {
    id: "quick_publish",
    name: "快速发布",
    description: "已有内容的快速发布流程。去 AI 痕迹 → 审查 → 平台适配 → 封面 → 发布。",
    steps: [
      {
        id: "humanize",
        name: "去 AI 痕迹",
        tool: "autocrew_humanize",
        params: { action: "rewrite", content_id: "${content_id}" },
      },
      {
        id: "review",
        name: "内容审查",
        tool: "autocrew_review",
        params: { action: "check", content_id: "${content_id}" },
      },
      {
        id: "rewrite",
        name: "平台适配",
        tool: "autocrew_rewrite",
        params: { action: "adapt", content_id: "${content_id}" },
      },
      {
        id: "cover",
        name: "封面设计",
        tool: "autocrew_cover_review",
        params: { action: "generate", content_id: "${content_id}" },
        requiresApproval: true,
      },
      {
        id: "pre_publish",
        name: "发布前检查",
        tool: "autocrew_pre_publish",
        params: { action: "checklist", content_id: "${content_id}" },
      },
      {
        id: "publish",
        name: "发布",
        tool: "autocrew_publish",
        params: { action: "publish", content_id: "${content_id}" },
        requiresApproval: true,
      },
    ],
  },
];

const templateMap = new Map(TEMPLATES.map((t) => [t.id, t]));

export function getTemplates(): WorkflowDefinition[] {
  return TEMPLATES;
}

export function getTemplate(id: string): WorkflowDefinition | undefined {
  return templateMap.get(id);
}
