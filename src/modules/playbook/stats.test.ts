/** 每版统计（spec §4，§9.3/9.4/9.8）：只数带原话、版本对得上的轮次；没定稿的不进中位数；样本 < 3 标「样本不够」 */
import { describe, expect, it } from "vitest";
import type { Content } from "../../storage/local-store.js";
import { draftHash } from "../../storage/draft-hash.js";
import type { PerformanceOutcome } from "../flywheel/outcome-schema.js";
import { computeStats, median, SAMPLE_LOW } from "./stats.js";
import type { PlaybookManifest, PlaybookPin } from "./types.js";

const M = { schema: 1, events: [], playbooks: [
  { id: "ganhuo", name: "干货方法", current: 2, proposals: [], versions: [{ version: 1, at: "", author: "agent", kind: "seed" }, { version: 2, at: "", author: "founder", kind: "edit" }] },
  { id: "shiyan", name: "实验演示", current: 1, proposals: [], versions: [{ version: 1, at: "", author: "agent", kind: "seed" }] },
] } as unknown as PlaybookManifest;

const G1: PlaybookPin = { id: "ganhuo", version: 1 };
const fb = (n: number, pin?: PlaybookPin) => Array.from({ length: n }, (_, i) => ({ version: i + 2, founder_words: `改${i}`, at: "", lessons: [], ...(pin ? { playbook: pin } : {}) }));
function draft(id: string, opts: { angle?: PlaybookPin; final?: PlaybookPin; feedback?: unknown[]; status?: string; editedAfterFinal?: boolean }): Content {
  const c = { id, title: id, body: "正文", platform: "douyin", status: opts.status ?? "drafting",
    draftPath: { kind: "thin", startedAt: "", ...(opts.angle ? { angle: { playbook: opts.angle } } : { angle: {} }), feedback: opts.feedback ?? [] } } as unknown as Content;
  if (opts.final) c.draftFinal = { draftHash: draftHash(c), finalizedAt: "", source: "founder-workbench", kept: [], playbook: opts.final };
  if (opts.editedAfterFinal) c.body = "定了之后又改过的正文";
  return c;
}
const v = (s: Record<string, unknown>, id: string, version: number) => (s.by_playbook as Record<string, Array<Record<string, unknown>>>)[id].find((x) => x.version === version)!;

describe("改稿轮数", () => {
  it("只数版本对得上的带原话轮次；没定稿的算进行中、不进中位数；换体裁前的单独计", () => {
    const contents = [
      draft("a", { angle: G1, final: G1, feedback: fb(2, G1) }),
      draft("b", { angle: G1, final: G1, feedback: [...fb(3, { id: "shiyan", version: 1 }), ...fb(4, G1)] }),
      draft("c", { angle: G1, final: G1, feedback: [...fb(1, G1), ...fb(5)] }),
      draft("wip", { angle: G1, feedback: fb(9, G1) }),
      draft("legacy", { feedback: fb(3) }),
    ];
    const s = computeStats(M, contents, []);
    expect(v(s, "ganhuo", 1)).toMatchObject({ finalized: 3, in_progress: 1, rounds: { median: 2, min: 1, max: 4 }, pre_switch_rounds: 3, label: null });
    // 整篇轮数（验收用）：换体裁前和没记版本的意见也算——b 是 3+4，c 是 1+5
    expect(v(s, "ganhuo", 1)).toMatchObject({ draft_rounds: { median: 6, min: 2, max: 7 } });
    expect(v(s, "ganhuo", 2)).toMatchObject({ finalized: 0, in_progress: 0, label: SAMPLE_LOW });
    expect(v(s, "shiyan", 1)).toMatchObject({ finalized: 0 });
    expect(s.unattributed).toBe(1);
  });

  it("定稿少于 3 条标「样本不够」；删掉 / 归档的不算", () => {
    const s = computeStats(M, [draft("a", { angle: G1, final: G1 }), draft("b", { angle: G1, final: G1 }), { ...draft("x", { angle: G1, final: G1 }), deletedAt: "t" } as Content], []);
    expect(v(s, "ganhuo", 1)).toMatchObject({ finalized: 2, label: SAMPLE_LOW });
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("有效定稿", () => {
  it("定了之后正文又改过（指纹对不上）：不算已定稿，算进行中", () => {
    const s = computeStats(M, [draft("a", { angle: G1, final: G1, feedback: fb(2, G1), editedAfterFinal: true })], []);
    expect(v(s, "ganhuo", 1)).toMatchObject({ finalized: 0, in_progress: 1, rounds: { median: null } });
  });
});

describe("发布数据", () => {
  const out = (contentId: string, metricDate: string, m: Record<string, number>): PerformanceOutcome =>
    ({ contentId, platform: "douyin", platformTitle: "t", publishedAt: "2026-10-01T10:00:00+08:00", metricDate, metrics: m, source: "auto", recordedAt: "", needsReview: false, reviewReasons: [] });
  it("取 D+3 / D+7 正好那天的快照，没有就留空不拿别的天替；发布少于 3 条标样本不够", () => {
    const contents = [draft("a", { angle: G1, final: G1 }), draft("b", { angle: G1, final: G1 })];
    const s = computeStats(M, contents, [
      out("a", "2026-10-04", { views: 1000, shares: 5, favorites: 10, bounce2s: 40 }),
      out("a", "2026-10-09", { views: 2000, shares: 10, favorites: 20, bounce2s: 50 }),
      out("b", "2026-10-05", { views: 9999, shares: 99, bounce2s: 90 }),
    ]);
    const p = v(s, "ganhuo", 1).publish as Record<string, Record<string, unknown>>;
    expect(p.published).toBe(2);
    expect(p.d3).toEqual({ count: 1, bounce2s: 40, shares_per_1k: 5, favorites_per_1k: 10 });
    expect(p.d7).toMatchObject({ count: 0, bounce2s: null });
    expect(p.label).toBe(SAMPLE_LOW);
  });

  it("D+n 按上海日期算：UTC 10-01 18:00 = 上海 10-02，D+3 是 10-05", () => {
    const row = { ...out("a", "2026-10-05", { views: 1000, shares: 1, favorites: 2, bounce2s: 30 }), publishedAt: "2026-10-01T18:00:00Z" };
    const wrong = { ...row, metricDate: "2026-10-04", metrics: { views: 1000, bounce2s: 99 } };
    const s = computeStats(M, [draft("a", { angle: G1, final: G1 })], [wrong, row]);
    expect((v(s, "ganhuo", 1).publish as Record<string, Record<string, unknown>>).d3).toMatchObject({ count: 1, bounce2s: 30 });
  });
});
