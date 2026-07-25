import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCampaignTeam,
  claimCampaignTask,
  completeCampaignTask,
  createCampaign,
  failCampaignTask,
  getCampaign,
  listCampaigns,
  readCampaignArtifact,
  retryCampaignTask,
  transitionCampaign,
} from "./campaign-store.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-campaign-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function seed() {
  return createCampaign(
    {
      name: "产品推广",
      mode: "managed_growth",
      brief: {
        targetUrl: "https://example.com/",
        goals: ["获取注册"],
        channels: ["website", "seo", "content"],
        constraints: [],
      },
    },
    dataDir,
  );
}

describe("campaign store", () => {
  it("persists one atomic aggregate per campaign", async () => {
    const created = await seed();
    expect(await getCampaign(created.id, dataDir)).toEqual(created);
    expect((await listCampaigns(dataDir)).map((campaign) => campaign.id)).toEqual([created.id]);
    await expect(fs.access(path.join(dataDir, "campaigns", created.id, "campaign.json"))).resolves.toBeUndefined();
  });

  it("reads schema v1 campaigns through the dynamic-workflow migration", async () => {
    const created = await seed();
    const file = path.join(dataDir, "campaigns", created.id, "campaign.json");
    const legacy = { ...created } as Partial<typeof created> & { schemaVersion: number };
    legacy.schemaVersion = 1;
    delete legacy.workflow;
    await fs.writeFile(file, JSON.stringify(legacy), "utf-8");

    const migrated = await getCampaign(created.id, dataDir);
    expect(migrated?.schemaVersion).toBe(2);
    expect(migrated?.workflow).toMatchObject({
      revision: 0,
      autonomy: "manual",
      schedule: { intervalMinutes: 1440 },
    });
    expect(migrated?.workflow.events[0].summary).toContain("迁移");
  });

  it("plans a team before allowing activation", async () => {
    const created = await seed();
    await expect(transitionCampaign(created.id, "active", dataDir)).rejects.toThrow(/Invalid campaign transition/);
    const planned = await buildCampaignTeam(created.id, dataDir);
    expect(planned?.status).toBe("ready");
    expect(planned?.team?.agents.length).toBeGreaterThanOrEqual(5);
    expect(planned?.tasks.length).toBeGreaterThan(3);
    expect((await transitionCampaign(created.id, "active", dataDir))?.status).toBe("active");
  });

  it("fails closed for traversal ids", async () => {
    expect(await getCampaign("../../secret", dataDir)).toBeNull();
    expect(await buildCampaignTeam("campaign-1/../../secret", dataDir)).toBeNull();
  });

  it("claims tasks, persists artifacts, unlocks dependencies and supports explicit retry", async () => {
    const created = await seed();
    await buildCampaignTeam(created.id, dataDir);
    await transitionCampaign(created.id, "active", dataDir);

    const audit = await claimCampaignTask(created.id, dataDir);
    expect(audit?.task.status).toBe("running");
    const afterAudit = await completeCampaignTask(
      created.id,
      audit!.run.id,
      {
        title: "业务审计",
        markdown: "审计证据。".repeat(80),
        kind: "research",
        runtime: "pi-agent",
        agentSessionId: "session-test-audit",
      },
      dataDir,
    );
    expect(afterAudit?.runs.find((run) => run.id === audit!.run.id)).toMatchObject({
      runtime: "pi-agent",
      agentSessionId: "session-test-audit",
    });
    const auditArtifact = afterAudit!.artifacts[0];
    expect(await readCampaignArtifact(created.id, auditArtifact.id, dataDir)).toContain("审计证据");

    const research = await claimCampaignTask(created.id, dataDir);
    await completeCampaignTask(
      created.id,
      research!.run.id,
      { title: "市场研究", markdown: "市场证据。".repeat(80), kind: "research" },
      dataDir,
    );
    const strategy = await claimCampaignTask(created.id, dataDir);
    expect(strategy?.task.id).toContain("growth-strategy");
    await failCampaignTask(created.id, strategy!.run.id, "模型暂时不可用", dataDir);
    expect((await getCampaign(created.id, dataDir))?.tasks.find((task) => task.id === strategy!.task.id)?.status).toBe("failed");
    await retryCampaignTask(created.id, strategy!.task.id, dataDir);
    expect((await getCampaign(created.id, dataDir))?.tasks.find((task) => task.id === strategy!.task.id)?.status).toBe("ready");
  });

  it("recovers a stale running task before claiming it again", async () => {
    const created = await seed();
    await buildCampaignTeam(created.id, dataDir);
    await transitionCampaign(created.id, "active", dataDir);
    const started = new Date("2026-07-11T00:00:00.000Z");
    const first = await claimCampaignTask(created.id, dataDir, started);
    const second = await claimCampaignTask(created.id, dataDir, new Date(started.getTime() + 31 * 60 * 1000));
    expect(second?.task.id).toBe(first?.task.id);
    expect(second?.run.attempt).toBe(2);
    const campaign = await getCampaign(created.id, dataDir);
    expect(campaign?.runs.find((run) => run.id === first?.run.id)).toMatchObject({ status: "failed" });
  });
});
