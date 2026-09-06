import { describe, it, expect } from "vitest";
import {
  DIGEST_MAX_CHARS,
  DIGEST_SKIP_REPLY,
  digestItemsSent,
  formatDigestDate,
  interpretDigestReply,
  jobStatusReply,
  layoutDigest,
  outOfRangeReply,
  pickDigestTopics,
  renderDigest,
  renderEmptyDigest,
  staleDigestPrefix,
  startedReply,
  truncate,
  type DigestCandidate,
  type LastDigest,
} from "./daily-digest.js";

const NOW = Date.parse("2026-09-07T09:00:00.000Z");
const hoursAgo = (h: number): string => new Date(NOW - h * 3600_000).toISOString();

function candidate(over: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    id: `topic-${Math.random().toString(36).slice(2, 8)}`,
    title: "DeepSeek Harness 开源实战",
    source: "radar:36氪",
    reason: "命中「Agent 落地」",
    link: "https://example.com/a",
    createdAt: hoursAgo(3),
    ...over,
  };
}

describe("pickDigestTopics · 候选筛选（spec §2.1）", () => {
  it("只要 radar: 源——手工录入与收件箱来的选题不进摘要", () => {
    const picked = pickDigestTopics(
      [
        candidate({ id: "topic-radar", source: "radar:36氪" }),
        candidate({ id: "topic-manual", source: undefined }),
        candidate({ id: "topic-inbox", source: "telegram" }),
        candidate({ id: "topic-chat", source: "chat" }),
      ],
      { now: NOW },
    );
    expect(picked.map((p) => p.topicId)).toEqual(["topic-radar"]);
  });

  it("回收站里的与已点选角度的都排除（状态不再是初始）", () => {
    const picked = pickDigestTopics(
      [
        candidate({ id: "topic-live" }),
        candidate({ id: "topic-trashed", deletedAt: hoursAgo(1) }),
        candidate({ id: "topic-used", selectedAngle: { id: "a1" } }),
      ],
      { now: NOW },
    );
    expect(picked.map((p) => p.topicId)).toEqual(["topic-live"]);
  });

  it("时间窗：since 之后入库的才算；缺省 since = 最近 24 小时", () => {
    const topics = [
      candidate({ id: "topic-old", createdAt: hoursAgo(30) }),
      candidate({ id: "topic-mid", createdAt: hoursAgo(20) }),
      candidate({ id: "topic-new", createdAt: hoursAgo(2) }),
    ];
    expect(pickDigestTopics(topics, { now: NOW }).map((p) => p.topicId)).toEqual(["topic-mid", "topic-new"]);
    expect(
      pickDigestTopics(topics, { now: NOW, since: hoursAgo(5) }).map((p) => p.topicId),
    ).toEqual(["topic-new"]);
  });

  it("未来时间戳（时钟歪了）不进这一份", () => {
    const picked = pickDigestTopics([candidate({ id: "topic-future", createdAt: hoursAgo(-2) })], { now: NOW });
    expect(picked).toHaveLength(0);
  });

  it("沿用入库顺序（createdAt 升序）并取前 5 条，序号从 1 连排", () => {
    const topics = [6, 5, 4, 3, 2, 1].map((h) => candidate({ id: `topic-${h}`, createdAt: hoursAgo(h) }));
    const picked = pickDigestTopics(topics, { now: NOW });
    expect(picked.map((p) => p.topicId)).toEqual(["topic-6", "topic-5", "topic-4", "topic-3", "topic-2"]);
    expect(picked.map((p) => p.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("剥掉 radar: 前缀，把源名原样带给渲染层", () => {
    const [item] = pickDigestTopics([candidate({ source: "radar:36氪" })], { now: NOW });
    expect(item.source).toBe("36氪");
  });
});

describe("renderDigest · 纯文本与截断（spec §2.2）", () => {
  const opts = { date: "2026-09-07", sourcesScanned: 9, now: NOW };

  it("头 · 条目 · 尾三段齐全，一条 = 标题/理由·源·时间/链接", () => {
    const text = renderDigest(pickDigestTopics([candidate()], { now: NOW }), opts);
    expect(text).toContain("AutoCrew 今日选题 · 9 月 7 日");
    expect(text).toContain("1. DeepSeek Harness 开源实战");
    expect(text).toContain("命中「Agent 落地」 · 36氪 · 3h 前");
    expect(text).toContain("https://example.com/a");
    expect(text).toContain("回复数字起深调研（1–1）；回 0 = 今天都不做。");
  });

  it("标题截 60、理由截 80（含省略号，总长恰好在线上）", () => {
    const text = renderDigest(
      pickDigestTopics([candidate({ title: "标".repeat(80), reason: "由".repeat(100) })], { now: NOW }),
      opts,
    );
    expect(text).toContain(`1. ${"标".repeat(59)}…`);
    expect(text).toContain(`${"由".repeat(79)}…`);
    expect(truncate("短", 60)).toBe("短");
  });

  it("5 条合计超长 → 丢尾条直到 ≤3500，且 lastDigest 只记真发出去的那几条", () => {
    const fat = [1, 2, 3, 4, 5].map((i) =>
      candidate({ id: `topic-${i}`, createdAt: hoursAgo(10 - i), link: `https://e.com/${"x".repeat(900)}${i}` }),
    );
    const picked = pickDigestTopics(fat, { now: NOW });
    const { text, items } = layoutDigest(picked, opts);
    expect(picked).toHaveLength(5);
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(items.length).toBeLessThan(5);
    expect(digestItemsSent(picked, opts)).toEqual(items);
    // 丢的是尾巴：留下的序号仍与用户看到的一致
    expect(items.map((i) => i.n)).toEqual(items.map((_, idx) => idx + 1));
  });

  it("空摘要照发一行，扫了几个源不知道就不写数字", () => {
    expect(renderEmptyDigest(opts)).toBe("AutoCrew 今日选题 · 9 月 7 日\n\n今天雷达没有新的命中定位的选题（扫了 9 个源）。");
    expect(renderEmptyDigest({ date: "2026-09-07" })).toBe(
      "AutoCrew 今日选题 · 9 月 7 日\n\n今天雷达没有新的命中定位的选题。",
    );
  });

  it("日期形状不认就原样回，不猜", () => {
    expect(formatDigestDate("2026-09-07")).toBe("9 月 7 日");
    expect(formatDigestDate("昨天")).toBe("昨天");
  });
});

describe("interpretDigestReply · 回复映射（spec §2.4）", () => {
  const last: LastDigest = {
    date: "2026-09-07",
    sentAt: new Date(NOW).toISOString(),
    items: [
      { n: 1, topicId: "topic-a", title: "甲" },
      { n: 2, topicId: "topic-b", title: "乙" },
    ],
  };

  it("非纯数字 / 没有清单 → none（照常入灵感账）", () => {
    expect(interpretDigestReply("想做一期讲选题的", last).kind).toBe("none");
    expect(interpretDigestReply("1篇", last).kind).toBe("none");
    expect(interpretDigestReply("123", last).kind).toBe("none"); // 三位数不是序号
    expect(interpretDigestReply("2", null).kind).toBe("none");
    expect(interpretDigestReply("2", { ...last, items: [] }).kind).toBe("none");
  });

  it("0 = 今天都不做；带空格的数字 trim 后仍算数", () => {
    expect(interpretDigestReply("0", last)).toEqual({ kind: "skip" });
    const r = interpretDigestReply(" 2 ", last);
    expect(r).toEqual({ kind: "pick", n: 2, item: last.items[1], repeat: false });
  });

  it("超范围明说范围", () => {
    expect(interpretDigestReply("7", last)).toEqual({ kind: "out_of_range", n: 7, count: 2 });
    expect(outOfRangeReply(2)).toBe("清单里只有 1–2");
  });

  it("同一个数字再回一次 = repeat（查进度，不是再起一轮）", () => {
    const r = interpretDigestReply("1", { ...last, picked: [1] });
    expect(r).toMatchObject({ kind: "pick", n: 1, repeat: true });
  });

  it("回复文案：起调研 / 进度 / 旧清单日期前缀", () => {
    expect(DIGEST_SKIP_REPLY).toBe("好，今天不动");
    expect(startedReply("甲")).toContain("已起深调研：《甲》");
    expect(jobStatusReply("甲", "running")).toBe("《甲》的深调研：进行中");
    expect(jobStatusReply("甲", "failed", "上游 500")).toContain("失败：上游 500");
    expect(jobStatusReply("甲")).toContain("还没有调研记录");
    expect(staleDigestPrefix("2026-09-07", "2026-09-07")).toBe("");
    expect(staleDigestPrefix("2026-09-06", "2026-09-07")).toBe("（这是 9 月 6 日的清单）");
  });
});
