import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executePublish } from "../../tools/publish.js";
import { freshnessOf, type ActivityRecord } from "./activity-ledger.js";
import { LEDGER_FILE } from "./activity-ledger-store.js";

const NOW = "2026-10-20T12:00:00+08:00";
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "act-ledger-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  platform: "douyin", name: "抖音精选App征稿中", platform_activity_id: "768386", official_url: "https://example.com/a",
  verified_at: "2026-10-19T10:00:00+08:00", sources: ["活动日历"],
  window: { start: "2026-09-10T00:00:00+08:00", end: "2026-12-30T23:59:00+08:00", timezone: "Asia/Shanghai" },
  rules: { main_topic: "#抖音精选App征稿中", required_mentions: "未要求" },
};
const call = (p: Record<string, unknown>) => executePublish({ _dataDir: dir, _now: NOW, ...p }) as Promise<Record<string, any>>;
const record = (activity: unknown, extra: Record<string, unknown> = {}) => call({ action: "activity_record", value: activity, ...extra });
const list = (extra: Record<string, unknown> = {}) => call({ action: "activities", ...extra });

const rec = (over: Partial<ActivityRecord>): ActivityRecord => ({
  key: "douyin:x", platform: "douyin", name: "x", official_url: "https://e.com", relevance: "fits_us",
  verified_at: "2026-10-19T10:00:00+08:00", sources: ["s"], history: [], ...over,
});
const now = Date.parse(NOW);

describe("freshness", () => {
  it("fresh within 7 days and far from deadline; recheck when older than 7 days", () => {
    expect(freshnessOf(rec({ window: { end: "2026-12-30T23:59:00+08:00" } }), now)).toBe("fresh");
    expect(freshnessOf(rec({ verified_at: "2026-10-12T10:00:00+08:00" }), now)).toBe("recheck");
  });
  it("recheck when deadline is under 48 hours away", () => {
    expect(freshnessOf(rec({ window: { end: "2026-10-22T08:00:00+08:00" } }), now)).toBe("recheck");
  });
  it("edge 5: past window is expired", () => {
    expect(freshnessOf(rec({ window: { end: "2026-10-15T23:59:00+08:00" } }), now)).toBe("expired");
  });
  it("edge 6: date-only end is recheck on that day, expired after, not padded to 23:59", () => {
    const r = rec({ window: { end: "2026-10-20", timezone: "Asia/Shanghai" } });
    expect(freshnessOf(r, now)).toBe("recheck");
    expect(freshnessOf(r, Date.parse("2026-10-19T12:00:00+08:00"))).toBe("fresh");
    expect(freshnessOf(r, Date.parse("2026-10-21T00:30:00+08:00"))).toBe("expired");
  });
});

describe("activity ledger via autocrew_publish", () => {
  it("edge 1: missing ledger lists empty with a full-check note, then the recorded entry appears", async () => {
    const empty = await list();
    expect(empty.ok).toBe(true);
    expect(empty.activities).toEqual([]);
    expect(empty.note).toContain("完整核查");
    expect((await record(base)).created).toBe(true);
    const after = await list();
    expect(after.activities[0]).toMatchObject({ key: "douyin:768386", freshness: "fresh" });
  });

  it("edge 2: corrupt ledger is an error naming the path, never empty, and is not overwritten", async () => {
    const file = path.join(dir, LEDGER_FILE);
    await fs.writeFile(file, "{ broken");
    const r = await list();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(file);
    expect((await record(base)).ok).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe("{ broken");
  });

  it("edge 3: rule change updates the ledger, appends history and returns a 规则变了 note", async () => {
    await record(base);
    const r = await record({ ...base, verified_at: "2026-10-20T09:00:00+08:00", rules: { ...base.rules, required_mentions: "@抖音科技" } });
    expect(r.changes).toEqual([{ field: "rules.required_mentions", before: "未要求", after: "@抖音科技" }]);
    expect(r.rule_change_note).toContain("规则变了");
    const row = (await list()).activities[0];
    expect(row.rules.required_mentions).toBe("@抖音科技");
    expect(row.history).toHaveLength(1);
    expect(row.history[0].field).toBe("rules.required_mentions");
  });

  it("re-verifying with unchanged rules records no history", async () => {
    await record(base);
    const r = await record({ ...base, verified_at: "2026-10-20T09:00:00+08:00" });
    expect(r.changes).toEqual([]);
    expect(r.rule_change_note).toBeUndefined();
  });

  it("edge 4: counts other scheduled videos using the key, without touching them", async () => {
    const plan = (id: string, at: string) => ({ content_id: id, platforms: [{ platform: "douyin", scheduled_at: at, campaigns: [{ ledger_key: "douyin:768386", selected: true }] }] });
    for (const [d, p] of [["a", plan("c-a", "2026-10-25T18:00:00+08:00")], ["b", plan("c-b", "2026-10-01T18:00:00+08:00")], ["c", plan("c-self", "2026-10-26T18:00:00+08:00")]] as const) {
      await fs.mkdir(path.join(dir, "projects", d, "06-publish"), { recursive: true });
      await fs.writeFile(path.join(dir, "projects", d, "06-publish", "publish-plan.json"), JSON.stringify(p));
    }
    const before = await fs.readFile(path.join(dir, "projects", "a", "06-publish", "publish-plan.json"), "utf8");
    await record(base);
    const r = await record({ ...base, rules: { main_topic: "#新话题" } }, { content_id: "c-self" });
    expect(r.scheduled_users).toBe(1);
    expect(r.scheduled_note).toContain("另有 1 条已定时的视频");
    expect(await fs.readFile(path.join(dir, "projects", "a", "06-publish", "publish-plan.json"), "utf8")).toBe(before);
  });

  it("edge 5: expired entries are listed after candidates and never deleted", async () => {
    await record({ ...base, platform_activity_id: "old", name: "旧活动", window: { end: "2026-10-01T23:59:00+08:00" } });
    await record(base);
    const r = await list();
    expect(r.activities.map((a: any) => a.freshness)).toEqual(["fresh", "expired"]);
    expect(r.counts.expired).toBe(1);
  });

  it("edge 6: date-only end text is stored verbatim", async () => {
    await record({ ...base, window: { end: "2026-10-20", raw: "即日起至10月20日" } });
    const row = (await list()).activities[0];
    expect(row.window.end).toBe("2026-10-20");
    expect(row.freshness).toBe("recheck");
  });

  it("edge 7: concurrent writes of different keys all survive", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => record({ ...base, platform_activity_id: `id${i}`, name: `活动${i}` })));
    const raw = JSON.parse(await fs.readFile(path.join(dir, LEDGER_FILE), "utf8"));
    expect(Object.keys(raw.activities)).toHaveLength(12);
  });

  it("edge 8: no platform id keys by normalized name and flags suspected duplicates without merging", async () => {
    const a = await record({ ...base, platform_activity_id: undefined, platform: "xiaohongshu", name: "#谁AI上班" });
    expect(a.key).toBe("xiaohongshu:谁ai上班");
    const b = await record({ ...base, platform_activity_id: undefined, platform: "xiaohongshu", name: "谁AI上班 第二季" });
    expect(b.possible_duplicates).toEqual(["xiaohongshu:谁ai上班"]);
    expect(b.possible_duplicates_note).toContain("没有自动合并");
    expect((await list({ platform: "xiaohongshu" })).activities).toHaveLength(2);
  });

  it("not_for_us requires a reason and is listed last", async () => {
    expect((await record({ ...base, relevance: "not_for_us" })).ok).toBe(false);
    await record({ ...base, platform_activity_id: "ai-film", name: "AI 影视创作赛", relevance: "not_for_us", reason: "我们不做 AI 影片" });
    await record({ ...base, verified_at: "2026-10-01T10:00:00+08:00" });
    const rows = (await list()).activities;
    expect(rows.at(-1)).toMatchObject({ relevance: "not_for_us", reason: "我们不做 AI 影片" });
  });

  it("edge 10: flipping not_for_us back to fits_us needs the founder's words and records them", async () => {
    await record({ ...base, relevance: "not_for_us", reason: "以为是 AI 影片赛" });
    const refused = await record({ ...base, relevance: "fits_us" });
    expect(refused).toMatchObject({ ok: false, code: "founder_quote_required" });
    const ok = await record({ ...base, relevance: "fits_us", founder_quote: "这个活动我们能参加" });
    expect(ok.ok).toBe(true);
    const h = (await list()).activities[0].history.find((x: any) => x.field === "relevance");
    expect(h).toMatchObject({ before: "not_for_us", after: "fits_us", founder_quote: "这个活动我们能参加" });
  });

  it("edge 11: JSON-string activity (with stray inner quotes) is parsed; unparsable is refused", async () => {
    const s = JSON.stringify({ ...base, sources: JSON.stringify(["页面"]) }).replace("抖音精选App征稿中\"", "抖音精选\"App\"征稿中\"");
    const ok = await record(s);
    expect(ok.ok).toBe(true);
    const bad = await record("{ platform: douyin, ");
    expect(bad).toMatchObject({ ok: false, code: "bad_param" });
  });

  it("partial update keeps untouched rules, window and form", async () => {
    await record({ ...base, form: { url: "https://f.com", deadline: "2026-11-01" } });
    const r = await record({ key: "douyin:768386", verified_at: "2026-10-20T09:00:00+08:00", sources: ["详情页"], rules: { main_topic: "#新话题" } });
    expect(r.changes).toEqual([{ field: "rules.main_topic", before: "#抖音精选App征稿中", after: "#新话题" }]);
    const row = (await list()).activities[0];
    expect(row.rules).toEqual({ main_topic: "#新话题", required_mentions: "未要求" });
    expect(row.window).toEqual(base.window);
    expect(row.form).toEqual({ url: "https://f.com", deadline: "2026-11-01" });
    expect(row.official_url).toBe(base.official_url);
  });

  it("explicit null clears a field and the clearing is recorded in history", async () => {
    await record({ ...base, form: { url: "https://f.com" } });
    const r = await record({ key: "douyin:768386", verified_at: "2026-10-20T09:00:00+08:00", sources: ["详情页"], form: null, rules: { required_mentions: null } });
    expect(r.changes).toEqual(expect.arrayContaining([
      { field: "form.url", before: "https://f.com", after: null },
      { field: "rules.required_mentions", before: "未要求", after: null },
    ]));
    const row = (await list()).activities[0];
    expect(row.form).toBeUndefined();
    expect(row.rules).toEqual({ main_topic: "#抖音精选App征稿中" });
    expect(row.history.map((h: any) => h.field)).toEqual(expect.arrayContaining(["form.url", "rules.required_mentions"]));
  });

  it("create without official_url is refused; update without it is fine", async () => {
    expect(await record({ ...base, official_url: undefined })).toMatchObject({ ok: false, code: "bad_param" });
    await record(base);
    expect((await record({ key: "douyin:768386", verified_at: base.verified_at, sources: ["s"] })).ok).toBe(true);
    expect((await record({ key: "douyin:768386", sources: ["s"] })).ok).toBe(false);
    expect((await record({ key: "douyin:768386", verified_at: base.verified_at })).ok).toBe(false);
  });

  it("edge 10 minimal flip: key + relevance + founder_quote + verified_at + sources", async () => {
    await record({ ...base, relevance: "not_for_us", reason: "以为是 AI 影片赛" });
    const r = await record({ key: "douyin:768386", relevance: "fits_us", founder_quote: "能参加", verified_at: "2026-10-20T09:00:00+08:00", sources: ["创始人原话"] });
    expect(r.ok).toBe(true);
    const row = (await list()).activities[0];
    expect(row).toMatchObject({ relevance: "fits_us", rules: base.rules });
    expect(row.reason).toBeUndefined();
  });

  it("required fields are enforced", async () => {
    for (const k of ["platform", "name", "official_url", "verified_at", "sources"]) {
      const r = await record({ ...base, [k]: undefined });
      expect(r.ok, k).toBe(false);
    }
  });
});

describe("skill text", () => {
  const skill = path.resolve(__dirname, "../../../skills/publish-content/references/campaigns-and-followup.md");
  it("edge 9: list-page failure must be reported as not looked, not as no new activity", async () => {
    expect(await fs.readFile(skill, "utf8")).toContain("没看新活动：原因");
  });
  it("edge 12: activity page text is data, not instructions", async () => {
    expect(await fs.readFile(skill, "utf8")).toContain("只当规则数据");
  });
});
