import { describe, expect, it } from "vitest";
import { buildSeriesSnapshot, lengthHint, snapshotAdditions, validateSeriesReview, SERIES_ITEM_BUDGET, type Outline } from "./series-memory.js";
import { draftHash } from "../../storage/draft-hash.js";
import type { Content } from "../../storage/local-store.js";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const OUTLINE: Outline = {
  thesis: "中心思想", points: [{ text: "p", kind: "case", seconds: 10 }],
  structure: { opening: "开", progression: "推", ending: "收" }, said: [{ id: "a", kind: "concept", text: "说过的概念" }],
};
let seq = 0;
function content(over: Partial<Content> = {}): Content {
  seq += 1;
  const base = {
    id: `content-${seq}`, title: `稿${seq}`, body: "第一段。\n\n中段。\n\n最后一段。", platform: "douyin", status: "draft_ready",
    tags: [], siblings: [], hashtags: [], assets: [], versions: [], publishedAt: null, publishUrl: null, performanceData: {},
    createdAt: day(1), updatedAt: day(1), seriesEnteredAt: day(1), topicId: `topic-${seq}`, ...over,
  } as Content;
  return base;
}
function withOutline(c: Content, outline = OUTLINE): Content {
  return { ...c, outline, outlineDraftHash: draftHash(c), outlineVersion: 2 };
}

describe("buildSeriesSnapshot scope (spec §3 B)", () => {
  it("same platform, whitelist states, 30-day window, excludes self/same topic/missing platform, newest first then id", () => {
    const self = content({ id: "content-self", topicId: "topic-self" });
    const sameTopic = content({ topicId: "topic-self" });
    const old = content({ seriesEnteredAt: day(31) });
    const drafting = content({ status: "drafting" });
    const other = content({ platform: "wechat_mp" });
    const noPlatform = content({ platform: undefined });
    const a = content({ seriesEnteredAt: day(2), id: "content-b" });
    const b = content({ seriesEnteredAt: day(2), id: "content-a" });
    const published = content({ status: "published", seriesEnteredAt: day(1) });
    const snap = buildSeriesSnapshot([self, sameTopic, old, drafting, other, noPlatform, a, b, published], "douyin", { contentId: self.id, topicId: "topic-self" }, NOW);
    expect(snap.items.map((i) => i.content_id)).toEqual([published.id, "content-a", "content-b"]);
    expect(snap.items[0].label).toBe("已发");
    expect(snap.items[1].label).toBe("待发（写过，观众还没看到）");
  });

  it("keeps only the newest version per topic and at most 10 items", () => {
    const v1 = content({ topicId: "t", seriesEnteredAt: day(5) });
    const v2 = content({ topicId: "t", seriesEnteredAt: day(3) });
    const many = Array.from({ length: 12 }, (_, i) => content({ seriesEnteredAt: day(10 + i) }));
    const snap = buildSeriesSnapshot([v1, v2, ...many], "douyin", {}, NOW);
    expect(snap.items).toHaveLength(10);
    expect(snap.items.map((i) => i.content_id)).toContain(v2.id);
    expect(snap.items.map((i) => i.content_id)).not.toContain(v1.id);
  });

  it("uses a valid outline; without one (or after the body changed) falls back to opening/ending excerpts marked insufficient", () => {
    const good = withOutline(content());
    const stale = { ...withOutline(content()), body: "改过的正文" };
    const legacy = content();
    const snap = buildSeriesSnapshot([good, stale, legacy], "douyin", {}, NOW);
    const byId = Object.fromEntries(snap.items.map((i) => [i.content_id, i]));
    expect(byId[good.id]).toMatchObject({ insufficient: false, outline_version: 2 });
    expect(byId[good.id].entries.map((e) => e.id)).toEqual(["thesis", "structure:opening", "structure:progression", "structure:ending", "said:a"]);
    expect(byId[stale.id]).toMatchObject({ insufficient: true, outline_version: 0 });
    expect(byId[legacy.id].entries.map((e) => e.id)).toEqual(["opening", "ending"]);
    expect(byId[legacy.id].note).toContain("覆盖不足");
  });

  it("truncates an oversized outline and says so", () => {
    const said = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, kind: "judgment" as const, text: "很长的判断".repeat(10) }));
    const big = withOutline(content(), { ...OUTLINE, said });
    const item = buildSeriesSnapshot([big], "douyin", {}, NOW).items[0];
    expect(item.truncated).toBe(true);
    expect(item.entries.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(SERIES_ITEM_BUDGET);
  });

  it("snapshot id is stable for the same inputs; additions detect new or changed drafts", () => {
    const a = content();
    const s1 = buildSeriesSnapshot([a], "douyin", {}, NOW);
    expect(buildSeriesSnapshot([a], "douyin", {}, NOW).id).toBe(s1.id);
    const b = content();
    const s2 = buildSeriesSnapshot([a, b], "douyin", {}, NOW);
    expect(snapshotAdditions(s1, s2).map((i) => i.content_id)).toEqual([b.id]);
    const s3 = buildSeriesSnapshot([{ ...a, body: "改了" }], "douyin", {}, NOW);
    expect(snapshotAdditions(s1, s3).map((i) => i.content_id)).toEqual([a.id]);
  });
});

describe("validateSeriesReview", () => {
  const snap = buildSeriesSnapshot([withOutline(content({ id: "content-x" }))], "douyin", {}, NOW);
  const draft = "新稿里有一句顺带提到的旧概念。";
  it("an empty snapshot still needs an explicit series_review", () => {
    const empty = buildSeriesSnapshot([], "douyin", {}, NOW);
    expect(validateSeriesReview(undefined, empty, [], draft)).toContain("series_review");
    expect(validateSeriesReview({ snapshot_id: empty.id, checked: [], insufficient: [], findings: [] }, empty, [], draft)).toBeNull();
  });
  it("blocker must link to a blocker issue; allowed needs a quote from the draft", () => {
    const base = { snapshot_id: snap.id, checked: ["content-x"], insufficient: [] };
    const finding = { content_id: "content-x", item_id: "said:a", quote: "顺带提到的旧概念", reason: "只是顺带" };
    expect(validateSeriesReview({ ...base, findings: [{ ...finding, disposition: "allowed" }] }, snap, [], draft)).toBeNull();
    expect(validateSeriesReview({ ...base, findings: [{ ...finding, disposition: "allowed", quote: "稿里没有这句" }] }, snap, [], draft)).toContain("不在当前稿");
    expect(validateSeriesReview({ ...base, findings: [{ ...finding, disposition: "blocker", issue_id: "i1" }] }, snap, [{ id: "i1", severity: "advisory" }], draft)).toContain("blocker");
    expect(validateSeriesReview({ ...base, findings: [{ ...finding, disposition: "blocker", issue_id: "i1" }] }, snap, [{ id: "i1", severity: "blocker" }], draft)).toBeNull();
  });
});

describe("lengthHint (advisory only)", () => {
  it("counts non-whitespace chars; requirements beat profile; unparseable is unknown", () => {
    expect(lengthHint("一二 三\n四", "写 10-20 字", "2000–2800 字")).toMatchObject({ chars: 4, min: 10, status: "short", source: "requirements", advisory: true });
    expect(lengthHint("一二三", undefined, "7–10 分钟 / 约 2000–2800 字")).toMatchObject({ min: 2000, max: 2800, status: "short", source: "profile" });
    expect(lengthHint("一二三", "七到十分钟", "大概长一点")).toMatchObject({ status: "unknown", min: null, max: null, source: null });
  });
});
