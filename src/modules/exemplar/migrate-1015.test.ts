/** 2026-10-15 迁移（spec §4、§15.3、§15.4）：只认固定 id、只改仍 pending 的、原文对不上就中止、只允许抖音那一列变 */
import { describe, expect, it } from "vitest";
import { BASELINE, MIGRATION_ID, publishPlaybooks, assertOnlyDouyinChanged, effectiveTable, FLOOR_ID, migrateProposals, migrateRules, PENDING_RULES, SKIP_DOUYIN, STALE_PROPOSALS } from "./migrate-1015.js";
import { rulesForPlatform, type CreatorProfile, type WritingRule } from "../profile/creator-profile.js";
import type { PlaybookManifest } from "../playbook/types.js";

const rule = (id: string, text: string, extra: Partial<WritingRule> = {}): WritingRule => ({ id, rule: text, status: "active", disabled: false, source: "user_explicit", confidence: 1, createdAt: "t", ...extra } as WritingRule);
function profile(): CreatorProfile {
  return { writingRules: [
    ...Object.entries(SKIP_DOUYIN).map(([id, head]) => rule(id, `${head}，后面还有字`)),
    rule("keep-1", "说人话"), rule("dy-1", "只交能念的正文", { scope: "platform:douyin" }),
    rule(PENDING_RULES[0], "待批一", { status: "pending", disabled: true }),
    rule(PENDING_RULES[1], "否决过的", { status: "rejected", disabled: true }),
    rule("later", "之后新增的待批", { status: "pending", disabled: true }),
  ] } as unknown as CreatorProfile;
}

describe("规则迁移", () => {
  it("挪走的 4 条只对抖音不生效；待批的停用、否决的不动、之后新增的不动；加抖音底线；重复跑幂等", () => {
    const p = profile();
    const before = effectiveTable(p);
    migrateRules(p, "2026-10-15T00:00:00Z");
    const after = effectiveTable(p);
    assertOnlyDouyinChanged(before, after);
    expect(after.douyin.sort()).toEqual(["dy-1", FLOOR_ID, "keep-1"].sort());
    expect(after.xiaohongshu).toEqual(before.xiaohongshu);
    const byId = new Map(p.writingRules.map((r) => [r.id, r]));
    expect(byId.get(PENDING_RULES[0])).toMatchObject({ status: "disabled", disabledReason: "2026-10-15 并入写法与范文" });
    expect(byId.get(PENDING_RULES[1])!.status).toBe("rejected");
    expect(byId.get("later")!.status).toBe("pending");
    const snapshot = JSON.stringify(p);
    const log = migrateRules(p, "2026-10-16T00:00:00Z");
    expect(JSON.stringify(p)).toBe(snapshot);
    expect(log.every((l) => !l.startsWith("✓"))).toBe(true);
  });

  it("规则原文变了或不在 → 整次中止", () => {
    const p = profile();
    p.writingRules[0].rule = "别人改过的话";
    expect(() => migrateRules(p, "t")).toThrow("原文变了");
    const q = profile();
    q.writingRules.shift();
    expect(() => migrateRules(q, "t")).toThrow("不在档案里");
  });

  it("skipPlatforms 只在那个平台跳过；不限平台的读法照旧", () => {
    const p = { writingRules: [rule("a", "x", { skipPlatforms: ["douyin"] })] } as unknown as CreatorProfile;
    expect(rulesForPlatform(p, "douyin")).toEqual([]);
    expect(rulesForPlatform(p, "xiaohongshu")).toHaveLength(1);
    expect(rulesForPlatform(p, null)).toHaveLength(1);
  });

  it("除抖音外有平台变了 → 中止", () => {
    expect(() => assertOnlyDouyinChanged({ douyin: [], xiaohongshu: ["a"] }, { douyin: [], xiaohongshu: [] })).toThrow("xiaohongshu");
  });
});

describe("手册提案迁移", () => {
  it("只改固定 id 里仍 pending 的为 stale；否决的、之后新增的不动", () => {
    const prop = (id: string, status: string) => ({ id, status, kind: "lesson", based_on: 1, text: "", founder_words: "", reason: "", gen: "", at: "t" });
    const m = { schema: 1, events: [], playbooks: [{ id: "renwu", name: "人物故事", current: 2, versions: [], proposals: [prop(STALE_PROPOSALS[0], "pending"), prop(STALE_PROPOSALS[1], "rejected"), prop("pp-later", "pending")] }] } as unknown as PlaybookManifest;
    migrateProposals(m, "t");
    expect(m.playbooks[0].proposals.map((p) => p.status)).toEqual(["stale", "rejected", "pending"]);
    expect(m.playbooks[0].proposals[0]).toMatchObject({ stale_reason: "2026-10-15 并入写法与范文" });
  });
});

describe("手册发布（Codex 复审 #3）", () => {
  const entry = (id: string, current: number, migrated = false) => ({ id, name: id, current, proposals: [],
    versions: Array.from({ length: current }, (_, i) => ({ version: i + 1, at: "t", author: "agent", kind: "edit", ...(migrated && i + 1 === current - 1 ? { migration: MIGRATION_ID } : {}) })) });
  const seeds = Object.keys(BASELINE).map((id) => ({ id, text: `压缩 ${id}` }));
  const read = async (id: string, v: number) => `${id} 第 ${v} 版`;

  it("基线对得上才发布；对不上整次中止", async () => {
    const m = { schema: 1, events: [], playbooks: Object.entries(BASELINE).map(([id, v]) => entry(id, v)) } as unknown as PlaybookManifest;
    expect((await publishPlaybooks(m, seeds, read)).every((b) => b.state === "publish")).toBe(true);
    m.playbooks[0].current = 5;
    await expect(publishPlaybooks(m, seeds, read)).rejects.toThrow("之后有人改过");
  });

  it("已有迁移标记：之后创始人批准了新版本，重跑也不再发布（不回退）；已是压缩版的不动", async () => {
    const m = { schema: 1, events: [], playbooks: Object.entries(BASELINE).map(([id, v]) => entry(id, v + 2, true)) } as unknown as PlaybookManifest;
    expect((await publishPlaybooks(m, seeds, read)).every((b) => b.state === "already_migrated")).toBe(true);
    const fresh = { schema: 1, events: [], playbooks: Object.keys(BASELINE).map((id) => entry(id, 1)) } as unknown as PlaybookManifest;
    expect((await publishPlaybooks(fresh, seeds, async (id) => `压缩 ${id}`)).every((b) => b.state === "already_compressed")).toBe(true);
  });
});
