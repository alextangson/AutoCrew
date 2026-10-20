import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedLedger } from "./activity-ledger-seed.js";
import { LEDGER_FILE } from "./activity-ledger-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "act-seed-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function put(project: string, name: string, body: unknown) {
  const d = path.join(dir, "projects", project, "06-publish", "campaigns");
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(d, name), typeof body === "string" ? body : JSON.stringify(body));
}
const douyin = (checkedAt: string) => ({
  platform: "douyin", checked_at: checkedAt, checked_via: "ego lite", sources_checked: ["活动日历"],
  selected: {
    activity_id: "7683863375256966171", name: "抖音精选App征稿中", official_url: "https://api.amemv.com/x",
    window: { calendar_start: "2026-09-10T00:00:00+08:00", calendar_end: "2026-12-30T23:59:00+08:00", poster_window: "7月15日–12月30日", timezone: "Asia/Shanghai（换算）" },
    main_topic: "#抖音精选App征稿中", required_mentions: "未要求",
  },
  excluded: [{ name: "典籍里的科技", reason: "内容不符" }],
});

describe("seedLedger", () => {
  it("dry-run reports imports, unreadable files and per-video exclusions without writing", async () => {
    await put("p1", "douyin.json", douyin("2026-10-03T10:20:00+08:00"));
    await put("p1", "bilibili.json", { platform: "bilibili", checked_at: "2026-10-03T10:45:00+08:00", selected: null });
    await put("p2", "research.json", { checked_date: "2026-10-11", douyin: {} });
    await put("p2", "broken.json", "{ nope");
    const r = await seedLedger({ dataDir: dir, write: false });
    expect(r.scanned).toBe(4);
    expect(r.imported).toEqual([expect.objectContaining({ key: "douyin:7683863375256966171", verified_at: "2026-10-03T10:20:00+08:00" })]);
    expect(r.unreadable).toHaveLength(3);
    expect(r.skipped_exclusions.map((x) => x.name)).toEqual(["典籍里的科技"]);
    await expect(fs.access(path.join(dir, LEDGER_FILE))).rejects.toThrow();
  });

  it("--write keeps the original verified_at and the newest of duplicate checks", async () => {
    await put("p1", "douyin.json", douyin("2026-10-03T10:20:00+08:00"));
    await put("p2", "douyin.json", douyin("2026-09-20T10:20:00+08:00"));
    const r = await seedLedger({ dataDir: dir, write: true });
    expect(r.superseded).toHaveLength(1);
    const ledger = JSON.parse(await fs.readFile(path.join(dir, LEDGER_FILE), "utf8"));
    const row = ledger.activities["douyin:7683863375256966171"];
    expect(row.verified_at).toBe("2026-10-03T10:20:00+08:00");
    expect(row.window).toMatchObject({ start: "2026-09-10T00:00:00+08:00", end: "2026-12-30T23:59:00+08:00", timezone: "Asia/Shanghai", raw: "7月15日–12月30日" });
    expect(row.relevance).toBe("fits_us");
  });

  it("does not overwrite an existing ledger entry", async () => {
    await fs.writeFile(path.join(dir, LEDGER_FILE), JSON.stringify({ version: 1, activities: { "douyin:7683863375256966171": { key: "douyin:7683863375256966171", platform: "douyin", name: "抖音精选App征稿中", official_url: "https://e.com", relevance: "fits_us", sources: ["s"], verified_at: "2026-10-19T00:00:00+08:00", history: [] } } }));
    await put("p1", "douyin.json", douyin("2026-10-03T10:20:00+08:00"));
    const r = await seedLedger({ dataDir: dir, write: true });
    expect(r.imported).toEqual([]);
    const ledger = JSON.parse(await fs.readFile(path.join(dir, LEDGER_FILE), "utf8"));
    expect(ledger.activities["douyin:7683863375256966171"].verified_at).toBe("2026-10-19T00:00:00+08:00");
  });
});
