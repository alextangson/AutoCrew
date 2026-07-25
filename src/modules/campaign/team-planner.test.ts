import { describe, expect, it } from "vitest";
import type { Campaign } from "./domain.js";
import { planCampaignTeam } from "./team-planner.js";
import { createCampaignWorkflow } from "./workflow-engine.js";

const campaign: Campaign = {
  schemaVersion: 2,
  id: "campaign-1-demo",
  name: "独立站增长",
  mode: "managed_growth",
  status: "draft",
  brief: {
    targetUrl: "https://example.com/",
    businessDescription: "面向独立开发者的 SaaS",
    goals: ["获得前 100 个注册用户"],
    channels: ["seo", "xiaohongshu", "paid_ads"],
    constraints: ["付费投放必须人工确认"],
  },
  team: null,
  tasks: [],
  runs: [],
  artifacts: [],
  approvals: [],
  metrics: [],
  workflow: createCampaignWorkflow("2026-07-11T00:00:00.000Z"),
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

describe("planCampaignTeam", () => {
  it("assembles specialists from the campaign brief", () => {
    const plan = planCampaignTeam(campaign, "2026-07-11T01:00:00.000Z");
    const roles = plan.team.agents.map((agent) => agent.role);
    expect(roles).toContain("growth_lead");
    expect(roles).toContain("seo_specialist");
    expect(roles).toContain("channel_operator");
    expect(roles).toContain("paid_media_specialist");
    expect(roles).toContain("performance_analyst");
  });

  it("creates a dependency graph and explicit approval boundaries", () => {
    const { tasks } = planCampaignTeam(campaign);
    const strategy = tasks.find((task) => task.id.endsWith("growth-strategy"))!;
    expect(strategy.dependsOn).toHaveLength(2);
    expect(tasks.filter((task) => task.status === "ready")).toHaveLength(2);
    expect(tasks.find((task) => task.id.endsWith("paid-ads-execute"))?.requiredApproval).toBe("paid_spend");
    expect(tasks.find((task) => task.id.endsWith("xiaohongshu-execute"))?.requiredApproval).toBe("external_publish");
    expect(tasks.find((task) => task.id.endsWith("xiaohongshu-plan"))?.requiredApproval).toBeUndefined();
    expect(tasks.find((task) => task.assigneeRole === "copywriter")?.id).toContain("message-kit");
    expect(tasks.find((task) => task.id.endsWith("xiaohongshu-plan"))?.dependsOn).toHaveLength(2);
  });

  it("increments the team strategy version when replanning", () => {
    const first = planCampaignTeam(campaign);
    const second = planCampaignTeam({ ...campaign, team: first.team });
    expect(first.team.version).toBe(1);
    expect(second.team.version).toBe(2);
    expect(second.tasks.every((task) => task.id.startsWith("task-v2-"))).toBe(true);
  });
});
