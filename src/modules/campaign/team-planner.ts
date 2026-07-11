import type {
  Campaign,
  CampaignAgent,
  CampaignAgentRole,
  CampaignTask,
  CampaignTeam,
  GovernedAction,
  PromotionChannel,
} from "./domain.js";

const ROLE_SPECS: Record<CampaignAgentRole, Omit<CampaignAgent, "id" | "role">> = {
  growth_lead: {
    name: "增长负责人",
    mission: "把业务目标拆成可验证的推广策略，并协调团队交付。",
    capabilities: ["strategy", "prioritization", "experiment_design"],
    approvalRequiredFor: ["external_publish", "paid_spend", "change_website"],
  },
  market_researcher: {
    name: "市场研究员",
    mission: "研究客户、竞品、渠道和证据，避免团队凭空制定策略。",
    capabilities: ["customer_research", "competitor_research", "source_verification"],
    approvalRequiredFor: [],
  },
  content_strategist: {
    name: "内容策略师",
    mission: "把定位和受众问题转成内容支柱、选题和分发节奏。",
    capabilities: ["content_strategy", "editorial_calendar", "message_architecture"],
    approvalRequiredFor: ["external_publish"],
  },
  copywriter: {
    name: "文案创作者",
    mission: "为目标渠道生产符合品牌与平台习惯的内容资产。",
    capabilities: ["copywriting", "platform_adaptation", "creative_iteration"],
    approvalRequiredFor: ["external_publish", "send_message"],
  },
  seo_specialist: {
    name: "SEO 专员",
    mission: "建立搜索需求地图并提出可追踪的站内内容与页面优化任务。",
    capabilities: ["keyword_research", "technical_seo", "content_brief"],
    approvalRequiredFor: ["change_website"],
  },
  channel_operator: {
    name: "渠道运营",
    mission: "根据渠道规则安排分发、互动和复用，保留完整执行证据。",
    capabilities: ["distribution", "community_operations", "scheduling"],
    approvalRequiredFor: ["external_publish", "send_message"],
  },
  paid_media_specialist: {
    name: "付费投放专员",
    mission: "设计小预算、可止损的付费实验并持续优化。",
    capabilities: ["media_plan", "budget_control", "creative_testing"],
    approvalRequiredFor: ["paid_spend", "external_publish"],
  },
  performance_analyst: {
    name: "增长分析师",
    mission: "定义指标、归因和复盘口径，让每轮执行都能学习。",
    capabilities: ["measurement", "attribution", "experiment_analysis"],
    approvalRequiredFor: ["export_customer_data"],
  },
};

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function rolesForCampaign(campaign: Campaign): CampaignAgentRole[] {
  const roles: CampaignAgentRole[] = [
    "growth_lead",
    "market_researcher",
    "content_strategist",
    "copywriter",
    "performance_analyst",
  ];
  if (campaign.brief.targetUrl || campaign.brief.channels.some((c) => c === "website" || c === "seo")) {
    roles.push("seo_specialist");
  }
  if (campaign.brief.channels.some((c) => !["website", "seo", "content"].includes(c))) {
    roles.push("channel_operator");
  }
  if (campaign.brief.channels.includes("paid_ads")) roles.push("paid_media_specialist");
  return unique(roles);
}

function roleForChannel(channel: PromotionChannel): CampaignAgentRole {
  if (channel === "website" || channel === "seo") return "seo_specialist";
  if (channel === "paid_ads") return "paid_media_specialist";
  if (channel === "content") return "content_strategist";
  return "channel_operator";
}

function governedActionForChannel(channel: PromotionChannel): GovernedAction | undefined {
  if (channel === "paid_ads") return "paid_spend";
  if (channel === "website" || channel === "seo") return "change_website";
  if (channel !== "content") return "external_publish";
  return undefined;
}

export function planCampaignTeam(campaign: Campaign, now = new Date().toISOString()): {
  team: CampaignTeam;
  tasks: CampaignTask[];
} {
  const version = (campaign.team?.version ?? 0) + 1;
  const teamId = `team-${version}`;
  const roles = rolesForCampaign(campaign);
  const agents = roles.map((role) => ({ id: `agent-${role.replaceAll("_", "-")}`, role, ...ROLE_SPECS[role] }));
  const team: CampaignTeam = { id: teamId, planner: "rules_v1", version, agents, createdAt: now };

  const seed = (suffix: string, task: Omit<CampaignTask, "id" | "createdAt" | "updatedAt">): CampaignTask => ({
    id: `task-v${version}-${suffix}`,
    ...task,
    createdAt: now,
    updatedAt: now,
  });

  const audit = seed("business-audit", {
    title: "审计业务与产品承诺",
    description: "梳理产品、独特价值、转化路径、限制条件和现有证据。",
    assigneeRole: "growth_lead",
    status: "ready",
    dependsOn: [],
  });
  const research = seed("market-research", {
    title: "研究受众、竞品与市场证据",
    description: "形成受众问题、竞品主张、渠道信号和可引用证据清单。",
    assigneeRole: "market_researcher",
    status: "ready",
    dependsOn: [],
  });
  const strategy = seed("growth-strategy", {
    title: "制定推广策略与实验假设",
    description: "基于审计和研究确定定位、信息架构、优先渠道与成功指标。",
    assigneeRole: "growth_lead",
    status: "pending",
    dependsOn: [audit.id, research.id],
  });
  const messageKit = seed("message-kit", {
    title: "产出核心信息与首轮素材包",
    description: "把定位转成核心主张、证据、CTA、渠道文案母稿和创意简报。",
    assigneeRole: "copywriter",
    status: "pending",
    dependsOn: [strategy.id],
  });

  const channelTasks = campaign.brief.channels.flatMap((channel) => {
    const slug = channel.replaceAll("_", "-");
    const plan = seed(`channel-${slug}-plan`, {
      title: `制定 ${channel} 渠道执行计划`,
      description: "明确内容/动作、频率、产物、人工审批点和首轮实验。",
      assigneeRole: roleForChannel(channel),
      channel,
      status: "pending",
      dependsOn:
        channel === "website" || channel === "seo"
          ? [strategy.id]
          : [strategy.id, messageKit.id],
    });
    const action = governedActionForChannel(channel);
    const execute = seed(`channel-${slug}-execute`, {
      title: `执行 ${channel} 首轮推广动作`,
      description: "按已确认的渠道计划生成或执行首轮动作，并保存完整证据。",
      assigneeRole: roleForChannel(channel),
      channel,
      status: "pending",
      dependsOn: [plan.id],
      ...(action ? { requiredApproval: action } : {}),
    });
    return [plan, execute];
  });

  const measurement = seed("measurement-plan", {
    title: "建立指标与复盘口径",
    description: "定义基线、渠道指标、归因窗口、停止条件和复盘节奏。",
    assigneeRole: "performance_analyst",
    status: "pending",
    dependsOn: [strategy.id],
  });

  return { team, tasks: [audit, research, strategy, messageKit, ...channelTasks, measurement] };
}
