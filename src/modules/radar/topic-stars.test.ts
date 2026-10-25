import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rateTopic, parseStars, starAdjustments, STAR_ADJUST_CAP } from "./topic-stars.js";
import { agingDaysLeft, TOPIC_TTL_MS } from "./topic-aging.js";
import { saveTopic, getTopic, listTopics, listTrash, restoreTopic, saveContent, softDeleteTopic } from "../../storage/local-store.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-stars-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

const topic = (title = "t", source = "radar:HN") => saveTopic({ title, description: "d", tags: [], source }, dir);

describe("rateTopic", () => {
  it("4–5 星记下、不进回收站；带途径和原话", async () => {
    const t = await topic();
    const r = await rateTopic(t.id, 5, { via: "mcp", founderWords: "这个好" }, dir);
    expect(r.ok && r.trashed).toBe(false);
    expect(await getTopic(t.id, dir)).toMatchObject({ stars: 5, starredVia: "mcp", starWords: "这个好" });
  });

  it("1–2 星 → 进回收站；捞回 → 星级清掉、不再自动老化", async () => {
    const t = await topic();
    const r = await rateTopic(t.id, 1, { via: "board" }, dir);
    expect(r.ok && r.trashed).toBe(true);
    expect((await listTrash(dir)).topics.map((x) => x.id)).toEqual([t.id]);
    const back = await restoreTopic(t.id, dir);
    expect(back?.stars).toBeUndefined();
    expect(back?.restoredAt).toBeTruthy();
    expect(agingDaysLeft(back!, 0, Date.now() + 2 * TOPIC_TTL_MS)).toBeNull();
  });

  it("手动删的 4 星选题捞回来星级保留", async () => {
    const t = await topic();
    await rateTopic(t.id, 4, { via: "board" }, dir);
    await softDeleteTopic(t.id, dir);
    expect((await restoreTopic(t.id, dir))?.stars).toBe(4);
  });

  it("清掉星级（0 / null）", async () => {
    const t = await topic();
    await rateTopic(t.id, 4, { via: "board" }, dir);
    const r = await rateTopic(t.id, 0, { via: "board" }, dir);
    expect(r.ok).toBe(true);
    const raw = JSON.parse(await fs.readFile(path.join(dir, "topics", `${t.id}.json`), "utf-8"));
    expect("stars" in raw).toBe(false);
  });

  it("已经开写的选题打 1–2 星被拒（血缘不能悬空），3–5 星照常", async () => {
    const t = await topic();
    await saveContent({ _provenance: HUMAN_WRITE, title: "稿", body: "b", platform: "douyin", status: "drafting", tags: [], hashtags: [], topicId: t.id }, dir);
    const low = await rateTopic(t.id, 2, { via: "board" }, dir);
    expect(low).toMatchObject({ ok: false, code: "topic_has_drafts" });
    expect((await listTopics(dir)).map((x) => x.id)).toContain(t.id);
    expect((await rateTopic(t.id, 3, { via: "board" }, dir)).ok).toBe(true);
  });

  it("已进回收站（比如刚被老化清理挪走）→ 照实拒绝，不偷偷捞回", async () => {
    const t = await topic();
    await softDeleteTopic(t.id, dir);
    expect(await rateTopic(t.id, 5, { via: "board" }, dir)).toMatchObject({ ok: false, code: "in_trash" });
  });

  it("坏参数被拒；字符串数字照收", async () => {
    const t = await topic();
    expect((await rateTopic(t.id, 6, { via: "board" }, dir)).ok).toBe(false);
    expect((await rateTopic(t.id, 2.5, { via: "board" }, dir)).ok).toBe(false);
    expect(parseStars("4")).toBe(4);
    expect(parseStars(null)).toBeNull();
    expect(await rateTopic("topic-nope", 3, { via: "board" }, dir)).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("starAdjustments", () => {
  it("按来源汇总 (星−3)×3，3 星中性，夹在上限内", () => {
    const m = starAdjustments([
      { source: "radar:HN", stars: 1 }, { source: "radar:HN", stars: 2 },
      { source: "radar:X", stars: 3 },
      ...Array.from({ length: 10 }, () => ({ source: "radar:PH", stars: 5 })),
      { source: "radar:HN" },
    ]);
    expect(m.get("radar:HN")).toBe(-9);
    expect(m.has("radar:X")).toBe(false);
    expect(m.get("radar:PH")).toBe(STAR_ADJUST_CAP);
  });
});

describe("agingDaysLeft", () => {
  it("从 max(入库, 上线日) 起算 7 天；≥3 星 = null", () => {
    const now = new Date("2026-10-25T12:00:00Z").getTime();
    const created = new Date(now - 30 * 86400_000).toISOString();
    expect(agingDaysLeft({ createdAt: created }, now, now)).toBe(7);
    expect(agingDaysLeft({ createdAt: new Date(now - 1.5 * 86400_000).toISOString() }, 0, now)).toBe(6);
    expect(agingDaysLeft({ createdAt: created, stars: 3 }, now, now)).toBeNull();
    expect(agingDaysLeft({ createdAt: created }, 0, now)).toBe(0);
  });
});
