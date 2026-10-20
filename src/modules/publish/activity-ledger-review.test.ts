// Codex 评审 7 条的回归测试（2026-10-20）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executePublish } from "../../tools/publish.js";
import { freshnessOf, type ActivityRecord } from "./activity-ledger.js";
import { LEDGER_FILE } from "./activity-ledger-store.js";
import { LOCK_TIMING } from "./activity-ledger-lock.js";
import { seedLedger } from "./activity-ledger-seed.js";

const NOW = "2026-10-20T12:00:00+08:00";
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "act-review-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  platform: "douyin", name: "抖音精选App征稿中", platform_activity_id: "768386", official_url: "https://example.com/a",
  verified_at: "2026-10-19T10:00:00+08:00", sources: ["活动日历"],
  window: { start: "2026-09-10T00:00:00+08:00", end: "2026-12-30T23:59:00+08:00" }, rules: { main_topic: "#抖音精选App征稿中" },
};
const KEY = "douyin:768386";
const call = (p: Record<string, unknown>) => executePublish({ _dataDir: dir, _now: NOW, ...p }) as Promise<Record<string, any>>;
const record = (value: unknown, extra: Record<string, unknown> = {}) => call({ action: "activity_record", value, ...extra });
const list = () => call({ action: "activities" });
const ledgerFile = () => path.join(dir, LEDGER_FILE);
const upd = (o: Record<string, unknown>) => record({ key: KEY, verified_at: "2026-10-20T09:00:00+08:00", sources: ["详情页"], ...o });

describe("P1 nested value types", () => {
  it("rejects non-string window/form sub-fields on write", async () => {
    expect(await record({ ...base, window: { end: 123 } })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await record({ ...base, form: { url: ["x"] } })).toMatchObject({ ok: false, code: "bad_param" });
    await expect(fs.access(ledgerFile())).rejects.toThrow();
  });
  it("a single malformed record on disk is an error naming the ledger path", async () => {
    await record(base);
    const raw = JSON.parse(await fs.readFile(ledgerFile(), "utf8"));
    raw.activities[KEY].window.end = 123;
    await fs.writeFile(ledgerFile(), JSON.stringify(raw));
    const r = await list();
    expect(r).toMatchObject({ ok: false, code: "ledger_unreadable" });
    expect(r.error).toContain(ledgerFile());
    expect(r.error).toContain(KEY);
  });
});

describe("P1 relevance cannot bypass the founder_quote guard", () => {
  it("relevance: null is refused and the record stays not_for_us", async () => {
    await record({ ...base, relevance: "not_for_us", reason: "不做" });
    expect((await upd({ relevance: null })).ok).toBe(false);
    expect((await list()).activities[0].relevance).toBe("not_for_us");
  });
});

describe("P1 cross-process lock", () => {
  const saved = { ...LOCK_TIMING };
  afterEach(() => Object.assign(LOCK_TIMING, saved));
  it("a held lock times out with a visible error and no write", async () => {
    Object.assign(LOCK_TIMING, { timeoutMs: 200 });
    await fs.writeFile(`${ledgerFile()}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
    const r = await record(base);
    expect(r).toMatchObject({ ok: false, code: "ledger_write_failed" });
    expect(r.error).toContain(".lock");
    await expect(fs.access(ledgerFile())).rejects.toThrow();
  });
  it("a stale lock (dead pid or too old) is taken over and released", async () => {
    await fs.writeFile(`${ledgerFile()}.lock`, JSON.stringify({ pid: 999999, host: os.hostname(), at: Date.now() - 60_000 }));
    expect((await record(base)).ok).toBe(true);
    await expect(fs.access(`${ledgerFile()}.lock`)).rejects.toThrow();
  });
  it("two processes writing at once keep every key", async () => {
    const script = path.join(dir, "writer.mts");
    const store = path.resolve(__dirname, "activity-ledger-store.ts");
    const patch = path.resolve(__dirname, "activity-ledger-patch.ts");
    await fs.writeFile(script, `
import { recordActivity } from ${JSON.stringify(store)};
import { parsePatch } from ${JSON.stringify(patch)};
const [dir, tag] = process.argv.slice(2);
await Promise.all(Array.from({ length: 8 }, (_, i) => {
  const p = parsePatch({ platform: "douyin", name: tag + i, platform_activity_id: tag + i, official_url: "https://e.com", verified_at: "2026-10-19T10:00:00+08:00", sources: ["s"] });
  if (!p.ok) throw new Error(p.error);
  return recordActivity(dir, p.value, new Date().toISOString());
}));`);
    const run = (tag: string) => promisify(execFile)("npx", ["tsx", script, dir, tag], { cwd: path.resolve(__dirname, "../../..") });
    await Promise.all([run("a"), run("b")]);
    const raw = JSON.parse(await fs.readFile(ledgerFile(), "utf8"));
    expect(Object.keys(raw.activities)).toHaveLength(16);
  }, 60_000);
});

describe("P2 scheduled-video count reads publication state and selection", () => {
  it("counts only selected campaigns on platforms scheduled and not yet public", async () => {
    const plan = (id: string, pub: Record<string, unknown>, selected = true) => ({
      content_id: id, platforms: [{ platform: "douyin", publication: pub, campaigns: [{ ledger_key: KEY, selected }] }],
    });
    const plans: Record<string, unknown> = {
      a: plan("a", { status: "scheduled", scheduled_at: "2026-10-25T18:00:00+08:00" }),
      b: plan("b", { status: "scheduled", scheduled_at: "2026-10-25T18:00:00+08:00" }, false),
      c: plan("c", { status: "published", scheduled_at: "2026-10-25T18:00:00+08:00", public_url: "https://x" }),
      d: plan("d", { status: "draft", scheduled_at: "2026-10-26T18:00:00+08:00" }),
    };
    for (const [d, p] of Object.entries(plans)) {
      await fs.mkdir(path.join(dir, "projects", d, "06-publish"), { recursive: true });
      await fs.writeFile(path.join(dir, "projects", d, "06-publish", "publish-plan.json"), JSON.stringify(p));
    }
    await record(base);
    const r = await upd({ rules: { main_topic: "#新" } });
    expect(r.scheduled_users).toBe(2); // a（已定时）+ d（publication.scheduled_at 在未来、未公开）
  });
});

describe("P2 seed only fills absent keys", () => {
  it("keeps an existing entry untouched and reports it", async () => {
    await record({ ...base, relevance: "not_for_us", reason: "不做", evidence: ["e.png"] });
    const before = await fs.readFile(ledgerFile(), "utf8");
    const d = path.join(dir, "projects", "p1", "06-publish", "campaigns");
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "douyin.json"), JSON.stringify({
      platform: "douyin", checked_at: "2026-10-20T10:00:00+08:00", sources_checked: ["s"],
      selected: { activity_id: "768386", name: "抖音精选App征稿中", official_url: "https://e.com" },
    }));
    const r = await seedLedger({ dataDir: dir, write: true });
    expect(r.imported).toEqual([]);
    expect(r.already_in_ledger.map((x) => x.key)).toEqual([KEY]);
    expect(await fs.readFile(ledgerFile(), "utf8")).toBe(before);
  });
});

describe("P2 evidence", () => {
  it("malformed evidence is refused", async () => {
    expect(await record({ ...base, evidence: "[broken" })).toMatchObject({ ok: false, code: "bad_param" });
  });
  it("evidence: null clears it and is recorded in the diff and history", async () => {
    await record({ ...base, evidence: ["a.png"] });
    const r = await upd({ evidence: null });
    expect(r.changes).toEqual([{ field: "evidence", before: ["a.png"], after: null }]);
    const row = (await list()).activities[0];
    expect(row.evidence).toBeUndefined();
    expect(row.history.map((h: any) => h.field)).toContain("evidence");
  });
});

describe("P2 not_open", () => {
  const rec = (window: ActivityRecord["window"]): ActivityRecord => ({ key: "k", platform: "douyin", name: "n", official_url: "https://e", relevance: "fits_us", verified_at: "2026-10-19T10:00:00+08:00", sources: [], history: [], window });
  it("an activity whose window has not opened is not_open, with opens_at in the listing", async () => {
    expect(freshnessOf(rec({ start: "2026-11-01T00:00:00+08:00", end: "2026-12-30T23:59:00+08:00" }), Date.parse(NOW))).toBe("not_open");
    expect(freshnessOf(rec({ start: "2026-10-21" }), Date.parse(NOW))).toBe("not_open");
    expect(freshnessOf(rec({ start: "2026-10-20" }), Date.parse(NOW))).toBe("fresh");
    await record({ ...base, window: { start: "2026-11-01T00:00:00+08:00", end: "2026-12-30T23:59:00+08:00" } });
    const r = await list();
    expect(r.activities[0]).toMatchObject({ freshness: "not_open", opens_at: "2026-11-01T00:00:00+08:00" });
    expect(r.counts.not_open).toBe(1);
  });
});
