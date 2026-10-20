// verifier 第二轮（2026-10-20）B–H 的回归测试；A 与 MCP 路径另见 activity-ledger-verify.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMcpRequest } from "../../../mcp/server.js";
import { executePublish } from "../../tools/publish.js";
import { freshnessOf, type ActivityRecord } from "./activity-ledger.js";
import { LEDGER_FILE } from "./activity-ledger-store.js";

const ROOT = path.join(os.homedir(), ".cache", "autocrew-yt", "ledger-fixes");
beforeAll(() => { mkdirSync(ROOT, { recursive: true }); vi.stubEnv("AUTOCREW_LOCAL_DIR", mkdtempSync(path.join(ROOT, "machine-"))); });
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(ROOT, "d-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const LOCAL = { principal: { subject: "local", plan: "local" as const }, host: "claude-code" };
const mcp = async (args: Record<string, unknown>) => {
  const res = await handleMcpRequest({ id: 1, method: "tools/call", params: { name: "autocrew_publish", arguments: args } }, LOCAL as never, dir);
  return ((res as { result?: { structuredContent?: Record<string, any> } })?.result?.structuredContent ?? {}) as Record<string, any>;
};
const KEY = "douyin:768386";
const base = {
  platform: "douyin", name: "抖音精选App征稿中", platform_activity_id: "768386", official_url: "https://example.com/a",
  verified_at: "2026-10-19T10:00:00+08:00", sources: ["活动日历"], rules: { main_topic: "#a" },
};
const NOW = "2026-10-20T12:00:00+08:00";
const record = (value: unknown, extra: Record<string, unknown> = {}) =>
  executePublish({ action: "activity_record", _dataDir: dir, _now: NOW, value, ...extra }) as Promise<Record<string, any>>;

describe("B window date spellings", () => {
  const rec = (window: ActivityRecord["window"]): ActivityRecord => ({ key: "k", platform: "douyin", name: "n", official_url: "https://e", relevance: "fits_us", verified_at: "2026-11-14T20:00:00+08:00", sources: [], history: [], window });
  it("YYYY.MM.DD is date-only", () => {
    expect(freshnessOf(rec({ end: "2026.11.15", timezone: "Asia/Shanghai" }), Date.parse("2026-11-15T12:00:00+08:00"))).toBe("recheck");
    expect(freshnessOf(rec({ end: "2026.11.15", timezone: "Asia/Shanghai" }), Date.parse("2026-11-16T00:10:00+08:00"))).toBe("expired");
  });
  it("a datetime without offset is read in window.timezone", () => {
    const r = rec({ end: "2026-11-15 23:59", timezone: "Asia/Shanghai" });
    expect(freshnessOf(r, Date.parse("2026-11-15T23:50:00+08:00"))).toBe("recheck");
    expect(freshnessOf(r, Date.parse("2026-11-16T00:05:00+08:00"))).toBe("expired");
    // 同一刻按 UTC 理解会还没到截止：确认用的是上海时间
    expect(freshnessOf(rec({ end: "2026-11-15 23:59", timezone: "UTC" }), Date.parse("2026-11-16T00:05:00+08:00"))).toBe("recheck");
  });
  it("an unparseable end stays recheck", () => {
    expect(freshnessOf(rec({ end: "11月15日" }), Date.parse("2026-11-01T12:00:00+08:00"))).toBe("recheck");
  });
});

describe("C scheduled count ignores plans whose time already passed", () => {
  it("status still says scheduled but scheduled_at is past → not counted", async () => {
    const plan = (at: string) => ({ content_id: at, platforms: [{ platform: "douyin", publication: { status: "scheduled", scheduled_at: at }, campaigns: [{ ledger_key: KEY, selected: true }] }] });
    for (const [d, at] of [["past", "2026-10-19T18:00:00+08:00"], ["future", "2026-10-25T18:00:00+08:00"]]) {
      await fs.mkdir(path.join(dir, "projects", d, "06-publish"), { recursive: true });
      await fs.writeFile(path.join(dir, "projects", d, "06-publish", "publish-plan.json"), JSON.stringify(plan(at)));
    }
    await record(base);
    const r = await record({ key: KEY, verified_at: "2026-10-20T11:00:00+08:00", sources: ["s"], rules: { main_topic: "#b" } });
    expect(r.scheduled_users).toBe(1);
  });
});

describe("D activities reports platforms with no entries (via MCP)", () => {
  it("returns empty_platforms without a platform filter", async () => {
    expect((await mcp({ action: "activity_record", value: base })).ok).toBe(true);
    const r = await mcp({ action: "activities" });
    expect(r.empty_platforms).toEqual(["xiaohongshu", "bilibili", "wechat_video"]);
    expect(r.empty_platforms_note).toContain("完整核查");
    expect((await mcp({ action: "activities", platform: "douyin" })).empty_platforms).toBeUndefined();
  });
  it("skill text routes empty platforms, rechecks and founder-named misses to the full chain", async () => {
    const t = await fs.readFile(path.resolve(__dirname, "../../../skills/publish-content/references/campaigns-and-followup.md"), "utf8");
    for (const s of ["empty_platforms", "完整核查：去哪查", "activity-list.html", "抖音科技", "升级为把这个活动完整重读"]) expect(t).toContain(s);
    expect(await fs.readFile(path.resolve(__dirname, "../../../skills/publish-content/references/publishing-contract.md"), "utf8")).toContain("没看新活动：原因");
  });
});

describe("E on-disk list/enum fields are type-checked", () => {
  const write = async (rec: Record<string, unknown>) => fs.writeFile(path.join(dir, LEDGER_FILE), JSON.stringify({ version: 1, activities: { [KEY]: {
    key: KEY, platform: "douyin", name: "a", official_url: "https://e.com", relevance: "fits_us", verified_at: "2026-10-19T00:00:00+08:00", sources: ["x"], history: [], ...rec,
  } } }));
  it.each([[{ sources: "x" }], [{ relevance: "maybe" }], [{ relevance: "not_for_us" }], [{ evidence: ["a", 1] }]])("%j → ledger_unreadable naming the path", async (bad) => {
    await write(bad);
    const r = await executePublish({ action: "activities", _dataDir: dir }) as Record<string, any>;
    expect(r).toMatchObject({ ok: false, code: "ledger_unreadable" });
    expect(r.error).toContain(path.join(dir, LEDGER_FILE));
  });
  it("non-string sources are refused on write", async () => {
    expect(await record({ ...base, sources: [{ url: "x" }] })).toMatchObject({ ok: false, code: "bad_param" });
  });
});

describe("F the model cannot move the clock over MCP", () => {
  it("_now in tool args is ignored on the MCP path", async () => {
    expect((await mcp({ action: "activity_record", value: { ...base, verified_at: "2026-10-01T10:00:00+08:00" } })).ok).toBe(true);
    const r = await mcp({ action: "activities", _now: "2026-10-02T10:00:00+08:00" });
    expect(r.activities[0].freshness).toBe("recheck");
  });
});

describe("G out-of-order older verification", () => {
  it("is refused with stale_verification and leaves the ledger untouched", async () => {
    await record(base);
    const before = await fs.readFile(path.join(dir, LEDGER_FILE), "utf8");
    const r = await record({ key: KEY, verified_at: "2026-10-18T10:00:00+08:00", sources: ["s"], rules: { main_topic: "#old" } });
    expect(r).toMatchObject({ ok: false, code: "stale_verification" });
    expect(await fs.readFile(path.join(dir, LEDGER_FILE), "utf8")).toBe(before);
    expect((await record({ key: KEY, verified_at: base.verified_at, sources: ["s"] })).ok).toBe(true);
  });
});

describe("H verified_at needs an offset and cannot be in the future", () => {
  it.each(["2026-10-19T10:00:00", "2026-10-19", "2026-10-20T13:00:00+08:00"])("%s is refused", async (v) => {
    expect(await record({ ...base, verified_at: v })).toMatchObject({ ok: false, code: "bad_param" });
  });
  it("Z and small clock skew are accepted", async () => {
    expect((await record({ ...base, verified_at: "2026-10-20T04:05:00Z" })).ok).toBe(true);
  });
});
