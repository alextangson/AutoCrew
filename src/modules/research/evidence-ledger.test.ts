/**
 * evidence-ledger.test.ts — 每稿一份的证据账本（P1 spec §3.3）。
 *
 * 被断言的是确定性层：id 分配规则、三类来源的播种、共享 budget 的耗尽语义、
 * 落盘快照是纯 JSON 且与内部状态解耦。
 */
import { describe, it, expect } from "vitest";

import {
  createEvidenceLedger,
  restoreEvidenceLedger,
  seedLedgerFromBrief,
  seedLedgerFromOwnMaterial,
  seedLedgerFromUserClaims,
  type LookupRecord,
} from "./evidence-ledger.js";
import type { ResearchBrief } from "./brief-store.js";

const BRIEF = {
  schemaVersion: 1,
  evidence: [
    { claim: "使用率过半", quote: "62% 的人每天使用 AI 编程助手", sourceUrl: "https://example.com/survey" },
    { claim: "维护成本上升", quote: "维护成本上升了三成", sourceUrl: "https://example.com/analysis" },
    { claim: "空引文应被跳过", quote: "   ", sourceUrl: "https://example.com/empty" },
  ],
} as unknown as ResearchBrief;

function lookup(over: Partial<LookupRecord> = {}): LookupRecord {
  return {
    need: "一个真实案例",
    status: "found",
    itemIds: ["ev-T1.1"],
    gaps: [],
    tokens: 120,
    turns: 3,
    startedAt: "2026-09-04T00:00:00.000Z",
    endedAt: "2026-09-04T00:01:00.000Z",
    ...over,
  };
}

describe("createEvidenceLedger", () => {
  it("按登记序返回条目，不带 id 的条目分配 led-<n>", () => {
    const ledger = createEvidenceLedger();
    const a = ledger.add({ source: "verified_quote", quote: "甲" });
    const b = ledger.add({ id: "ev-T1.1", source: "verified_quote", quote: "乙", sourceId: "p1" });
    const c = ledger.add({ source: "user_claim", quote: "丙" });
    expect([a.id, b.id, c.id]).toEqual(["led-1", "ev-T1.1", "led-2"]);
    expect(ledger.entries().map((e) => e.id)).toEqual(["led-1", "ev-T1.1", "led-2"]);
  });

  it("同 id 重复登记是幂等的：保留先到的那条", () => {
    const ledger = createEvidenceLedger();
    const first = ledger.add({ id: "om:c1:transcript:2:0", source: "own_claim", quote: "原片段" });
    const again = ledger.add({ id: "om:c1:transcript:2:0", source: "own_claim", quote: "改过的片段" });
    expect(again).toBe(first);
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]!.quote).toBe("原片段");
  });

  it("空的可选字段不进落盘 JSON", () => {
    const ledger = createEvidenceLedger();
    ledger.add({ source: "user_claim", quote: "创始人给的材料" });
    expect(Object.keys(ledger.snapshot().entries[0]!).sort()).toEqual(["id", "quote", "source"]);
  });

  it("budget 用完返回 false，写手与修订共享同一份计数", () => {
    const ledger = createEvidenceLedger({ maxLookups: 2 });
    expect(ledger.budget.max).toBe(2);
    expect(ledger.budget.take()).toBe(true); // 写手第 1 次
    expect(ledger.budget.take()).toBe(true); // 写手第 2 次
    expect(ledger.budget.take()).toBe(false); // 修订轮：没有了
    expect(ledger.budget.used()).toBe(2);
  });

  it("默认 3 次", () => {
    expect(createEvidenceLedger().budget.max).toBe(3);
  });

  it("recordLookup 留痕，快照与内部状态解耦", () => {
    const ledger = createEvidenceLedger();
    const rec = lookup({ status: "empty", itemIds: [], gaps: ["没有公开数据"] });
    ledger.recordLookup(rec);
    rec.gaps.push("事后改动不该影响账本");
    expect(ledger.lookups()[0]!.gaps).toEqual(["没有公开数据"]);

    const snap = ledger.snapshot();
    snap.lookups[0]!.gaps.push("改快照也不该影响账本");
    ledger.add({ source: "verified_quote", quote: "后来才加的" });
    expect(ledger.lookups()[0]!.gaps).toEqual(["没有公开数据"]);
    expect(snap.entries).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(ledger.snapshot()))).toEqual(ledger.snapshot());
  });

  it("快照带 budget 用量", () => {
    const ledger = createEvidenceLedger({ maxLookups: 3 });
    ledger.budget.take();
    expect(ledger.snapshot().budget).toEqual({ max: 3, used: 1 });
  });
});

describe("播种", () => {
  it("简报证据沿用 ev-N，空引文跳过", () => {
    const ledger = createEvidenceLedger();
    seedLedgerFromBrief(ledger, BRIEF);
    expect(ledger.entries().map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    expect(ledger.entries().every((e) => e.source === "verified_quote")).toBe(true);
    expect(ledger.entries()[0]).toMatchObject({
      claim: "使用率过半",
      quote: "62% 的人每天使用 AI 编程助手",
      sourceUrl: "https://example.com/survey",
    });
  });

  it("内部语料一段一条，id 就是 om: 片段 id", () => {
    const ledger = createEvidenceLedger();
    seedLedgerFromOwnMaterial(ledger, [
      { id: "om:c1:transcript:2:0", text: "我自己做插件那次" },
      { id: "om:c1:transcript:2:1", text: "后来发现纠正写在易失内存里" },
      { id: "om:c2:approved_draft:1:0", text: "  " },
    ]);
    expect(ledger.entries().map((e) => e.id)).toEqual(["om:c1:transcript:2:0", "om:c1:transcript:2:1"]);
    expect(ledger.entries()[0]!.source).toBe("own_claim");
    expect(ledger.entries()[0]!.quote).toBe("我自己做插件那次");
  });

  it("用户材料记 user_claim；没给 id 就编 user-<n>", () => {
    const ledger = createEvidenceLedger();
    seedLedgerFromUserClaims(ledger, [
      { id: "", text: "创始人补的行业背景" },
      { id: "user-topic", text: "选题描述" },
    ]);
    expect(ledger.entries().map((e) => e.id)).toEqual(["user-1", "user-topic"]);
    expect(ledger.entries().every((e) => e.source === "user_claim")).toBe(true);
  });

  it("三类来源同居一本账本，只有 verified_quote 算外部已核验", () => {
    const ledger = createEvidenceLedger();
    seedLedgerFromBrief(ledger, BRIEF);
    seedLedgerFromOwnMaterial(ledger, [{ id: "om:c1:transcript:2:0", text: "我自己那次" }]);
    seedLedgerFromUserClaims(ledger, [{ id: "", text: "创始人材料" }]);
    expect(ledger.entries().filter((e) => e.source === "verified_quote")).toHaveLength(2);
    expect(ledger.entries()).toHaveLength(4);
  });
});

// ─── 从快照恢复（P3 §5.2：宿主写稿是跨调用的，账本只能从盘上续） ─────────────

describe("restoreEvidenceLedger", () => {
  it("条目、查证记录、配额三样都续上，snapshot 往返不丢东西", () => {
    const first = createEvidenceLedger();
    seedLedgerFromBrief(first, BRIEF);
    first.budget.take();
    first.recordLookup({
      need: "返工工时数据",
      status: "found",
      itemIds: ["ev-T1.1"],
      gaps: [],
      tokens: 10,
      turns: 2,
      startedAt: "2026-09-05T00:00:00.000Z",
      endedAt: "2026-09-05T00:01:00.000Z",
    });

    const restored = restoreEvidenceLedger(first.snapshot());
    expect(restored.entries().map((e) => e.id)).toEqual(first.entries().map((e) => e.id));
    expect(restored.lookups()).toHaveLength(1);
    expect(restored.budget.used()).toBe(1);
    expect(restored.snapshot()).toEqual(first.snapshot());
  });

  it("配额从 used 续：恢复两次不等于额度重置（写两遍就等于没有上限）", () => {
    const snapshot = createEvidenceLedger({ maxLookups: 3 }).snapshot();
    const a = restoreEvidenceLedger({ ...snapshot, budget: { max: 3, used: 2 } });
    expect(a.budget.take()).toBe(true);
    expect(a.budget.take()).toBe(false);
    expect(a.budget.used()).toBe(3);
  });

  it("自动 id 从快照最大号续——回到 led-1 会让新条目撞上旧条目被无声吞掉", () => {
    const first = createEvidenceLedger();
    first.add({ source: "user_claim", quote: "第一条" });
    first.add({ source: "user_claim", quote: "第二条" });
    expect(first.entries().map((e) => e.id)).toEqual(["led-1", "led-2"]);

    const restored = restoreEvidenceLedger(first.snapshot());
    const fresh = restored.add({ source: "user_claim", quote: "第三条" });
    expect(fresh.id).toBe("led-3");
    expect(fresh.quote).toBe("第三条");
    expect(restored.entries()).toHaveLength(3);
  });

  it("显式 budget 参数压过快照里的（换配额时不必先改快照）", () => {
    const snapshot = createEvidenceLedger().snapshot();
    const restored = restoreEvidenceLedger(snapshot, { max: 1, used: 0 });
    expect(restored.budget.max).toBe(1);
    expect(restored.budget.take()).toBe(true);
    expect(restored.budget.take()).toBe(false);
  });
});
