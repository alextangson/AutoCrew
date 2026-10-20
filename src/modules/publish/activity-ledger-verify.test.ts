/**
 * Verifier edge tests for the activity ledger (spec 2026-10-20-activity-ledger), written from observed behavior.
 * Failing tests here are findings, not chores: do not bend them to pass.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../tools/pre-publish.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../tools/pre-publish.js")>();
  return { ...orig, executePrePublish: vi.fn(orig.executePrePublish) };
});

import { executePrePublish } from "../../tools/pre-publish.js";
import { handleMcpRequest } from "../../../mcp/server.js";
import { executePublish } from "../../tools/publish.js";
import { freshnessOf, type ActivityRecord } from "./activity-ledger.js";

const ROOT = path.join(os.homedir(), ".cache", "autocrew-yt", "verify-ledger", "vitest");
const tmp = (p: string) => { mkdirSync(ROOT, { recursive: true }); return mkdtempSync(path.join(ROOT, p)); };
beforeAll(() => { vi.stubEnv("AUTOCREW_LOCAL_DIR", tmp("machine-")); });
afterEach(() => { vi.mocked(executePrePublish).mockClear(); });

const LOCAL = { principal: { subject: "local", plan: "local" as const }, host: "claude-code" };
const mcpPublish = async (dataDir: string, args: Record<string, unknown>) => {
  const res = await handleMcpRequest({ id: 1, method: "tools/call", params: { name: "autocrew_publish", arguments: args } }, LOCAL as never, dataDir);
  return (res as { result?: { structuredContent?: Record<string, unknown> } })?.result?.structuredContent ?? {};
};
const douyin = {
  platform: "douyin", name: "抖音精选App征稿中（精选创作季）", platform_activity_id: "7683863375256966171",
  official_url: "https://api.amemv.com/magic/eco/runtime/release/6aa24c0e543ef6ae09235356",
  window: { start: "2026-09-10T00:00:00+08:00", end: "2026-12-30T23:59:00+08:00", timezone: "Asia/Shanghai" },
  rules: { main_topic: "#抖音精选App征稿中" }, verified_at: "2026-10-20T09:50:00+08:00", sources: ["活动日历"],
};

describe("MCP entry: ledger actions with content_id (the publish session's own video)", () => {
  // activity_record reads params.content_id to exclude the current video from the scheduled-video count,
  // but the ToolRunner pre-publish gate fires for every autocrew_publish action that carries content_id
  // unless the action is in PUBLISH_GATE_EXEMPT_ACTIONS — and activities/activity_record are not.
  it("activities with content_id is not blocked by the pre-publish gate", async () => {
    const dir = tmp("gate-read-");
    const r = await mcpPublish(dir, { action: "activities", content_id: "content-1790472579078-n0ezov" });
    expect(r.error).not.toBe("pre_publish_check_failed");
    expect(r.ok).toBe(true);
  });

  it("activity_record with content_id is written, not blocked by the pre-publish gate", async () => {
    const dir = tmp("gate-write-");
    const r = await mcpPublish(dir, { action: "activity_record", content_id: "content-1790472579078-n0ezov", value: douyin });
    expect(r.error).not.toBe("pre_publish_check_failed");
    expect(r.ok).toBe(true);
  });

  it("a ledger read/write never runs the pre-publish checklist (which advances content state)", async () => {
    const dir = tmp("gate-spy-");
    await mcpPublish(dir, { action: "activities", content_id: "content-1790472579078-n0ezov" });
    expect(vi.mocked(executePrePublish)).not.toHaveBeenCalled();
  });

  it("without content_id the same calls go through (control)", async () => {
    const dir = tmp("gate-ctrl-");
    expect((await mcpPublish(dir, { action: "activity_record", value: douyin })).ok).toBe(true);
    expect((await mcpPublish(dir, { action: "activities" })).ok).toBe(true);
  });
});

describe("edge 6: date-only deadline in a non-ISO date spelling", () => {
  const rec = (end: string): ActivityRecord => ({
    key: "xiaohongshu:谁ai上班", platform: "xiaohongshu", name: "谁AI上班", official_url: "https://x.com",
    window: { end, timezone: "Asia/Shanghai" }, relevance: "fits_us",
    verified_at: "2026-11-14T20:00:00+08:00", sources: ["x"], history: [],
  });
  const noonOnDeadline = Date.parse("2026-11-15T12:00:00+08:00");

  it("ISO date-only end is recheck on the deadline day (control)", () => {
    expect(freshnessOf(rec("2026-11-15"), noonOnDeadline)).toBe("recheck");
  });

  // The tool docs never require ISO for window.end; a model copying a poster writes 2026/11/15.
  // Date.parse reads it as local midnight, so the whole deadline day is already "expired" — the 23:59 problem in reverse.
  it("slash date-only end is not expired during the deadline day", () => {
    expect(freshnessOf(rec("2026/11/15"), noonOnDeadline)).toBe("recheck");
  });

  it("slash date-only end is not recheck-by-deadline two days early", () => {
    expect(freshnessOf(rec("2026/11/15"), Date.parse("2026-11-13T12:00:00+08:00"))).toBe("fresh");
  });
});

describe("edge 2: hand-edited ledger with wrong-typed list fields", () => {
  it("a string evidence on disk is either refused on read or kept intact on update, never split into characters", async () => {
    const dir = tmp("evidence-");
    const file = path.join(dir, "platform-activities.json");
    writeFileSync(file, JSON.stringify({ version: 1, activities: { "douyin:1": {
      key: "douyin:1", platform: "douyin", name: "a", official_url: "https://e.com", relevance: "fits_us",
      verified_at: "2026-10-20T00:00:00+08:00", sources: ["x"], history: [], evidence: "shot.png",
    } } }));
    const r = await executePublish({ action: "activity_record", _dataDir: dir, value: { key: "douyin:1", verified_at: "2026-10-20T10:00:00+08:00", sources: ["y"], evidence: ["new.png"] } });
    if (r.ok) {
      const ev = JSON.parse(readFileSync(file, "utf8")).activities["douyin:1"].evidence as string[];
      expect(ev).toContain("shot.png");
      expect(ev).not.toContain("s");
    } else {
      expect(String((r as { error?: unknown }).error)).toContain(file);
    }
  });
});

describe("edge 4: excluding the current video only works on the direct path", () => {
  it("direct executePublish with content_id excludes the current video's own plan", async () => {
    const dir = tmp("sched-");
    const plan = (id: string) => ({
      content_id: id, platforms: [{ platform: "douyin", scheduled_at: "2026-10-25T18:00:00+08:00", publication: { status: "scheduled" },
        campaigns: [{ name: "抖音精选App征稿中", selected: true, ledger_key: "douyin:7683863375256966171" }] }],
    });
    for (const id of ["vid-other", "vid-current"]) {
      mkdirSync(path.join(dir, "projects", id, "06-publish"), { recursive: true });
      writeFileSync(path.join(dir, "projects", id, "06-publish", "publish-plan.json"), JSON.stringify(plan(id)));
    }
    await executePublish({ action: "activity_record", _dataDir: dir, _now: "2026-10-20T10:00:00+08:00", value: douyin });
    const r = await executePublish({ action: "activity_record", _dataDir: dir, _now: "2026-10-20T11:00:00+08:00", content_id: "vid-current",
      value: { key: "douyin:7683863375256966171", verified_at: "2026-10-20T10:55:00+08:00", sources: ["详情页"], rules: { main_topic: "#抖音精选App征稿中2.0" } } }) as Record<string, unknown>;
    expect(r.scheduled_users).toBe(1);
  });
});
