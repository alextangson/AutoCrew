import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  campaignCreateHandler,
  campaignGetHandler,
  campaignListHandler,
  campaignPlanTeamHandler,
  campaignTransitionHandler,
} from "./campaign-handlers.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-campaign-handler-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("campaign IPC handlers", () => {
  it("creates a managed-growth campaign from a site and assembles its team", async () => {
    const created = await campaignCreateHandler({
      name: "Demo SaaS 推广",
      mode: "managed_growth",
      target_url: "https://example.com",
      goals: ["30 天获得 100 个注册"],
      channels: ["seo", "xiaohongshu"],
      _dataDir: dataDir,
    });
    expect(created.ok).toBe(true);
    const id = (created.data as { campaign: { id: string } }).campaign.id;

    const planned = await campaignPlanTeamHandler({ id, _dataDir: dataDir });
    expect(planned.ok).toBe(true);
    expect((planned.data as { campaign: { status: string } }).campaign.status).toBe("ready");

    const activated = await campaignTransitionHandler({ id, target_status: "active", _dataDir: dataDir });
    expect(activated.ok).toBe(true);
    expect((activated.data as { campaign: { status: string } }).campaign.status).toBe("active");

    expect((await campaignGetHandler({ id, _dataDir: dataDir })).ok).toBe(true);
    expect(((await campaignListHandler({ _dataDir: dataDir })).data as { campaigns: unknown[] }).campaigns).toHaveLength(1);
  });

  it("rejects unsupported URLs, modes, channels and traversal ids", async () => {
    expect((await campaignCreateHandler({ name: "x", mode: "managed_growth", goals: ["g"], target_url: "file:///etc/passwd", _dataDir: dataDir })).ok).toBe(false);
    expect((await campaignCreateHandler({ name: "x", mode: "unknown", goals: ["g"], business_description: "b", _dataDir: dataDir })).ok).toBe(false);
    expect((await campaignCreateHandler({ name: "x", mode: "personal", goals: ["g"], business_description: "b", channels: ["shell"], _dataDir: dataDir })).ok).toBe(false);
    expect((await campaignGetHandler({ id: "../../secret", _dataDir: dataDir })).ok).toBe(false);
  });
});
