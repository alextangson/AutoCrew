/**
 * 写手侧登记（§11 待修第一条）：provided/skip 写稿没有研究任务，由用户材料推算出来的数
 * 只能靠 claim_offline 带 content_id + pack_id 进稿件台账。钉住四件事：
 * 不要 task_id 也能登记成 `user-<n>`；写门照拦；12 条终身额度照算；带 task_id 的老路一字不变。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeScout } from "./scout.js";
import { readPack, writePack, type ReadyPack } from "./writer-pack.js";
import { loadHostEvidence } from "../modules/research/host-evidence-store.js";
import { inspectHostResearchTask } from "../modules/research/host-research-store.js";
import { EMPTY_OWN_MATERIAL } from "../modules/research/own-material.js";
import { createEvidenceLedger, seedLedgerFromUserClaims } from "../modules/research/evidence-ledger.js";
import { getContent, saveContent, saveTopic, updateContent } from "../storage/local-store.js";
import { claimContent } from "../storage/claims.js";

const RESEARCH = "每周开 3 场例会；每场会后整理纪要要 40 分钟，用了自动纪要后每场只要 10 分钟。";
let dir: string;
let topicId: string;

const scout = (args: Record<string, unknown>) =>
  executeScout(
    { topic_id: topicId, ...args, _dataDir: dir, _host: "claude" },
    { collectOwnMaterialImpl: vi.fn(async () => structuredClone(EMPTY_OWN_MATERIAL)) },
  );

/** 一篇 provided 模式、已备好包的稿：台账里只有播种的用户材料 */
async function seedProvidedDraft() {
  const content = await saveContent(
    { title: "草稿", body: "", topicId, platform: "douyin", status: "drafting", tags: [] },
    dir,
  );
  const ledger = createEvidenceLedger();
  seedLedgerFromUserClaims(ledger, [{ id: "user-research", text: RESEARCH }]);
  const pack: ReadyPack = {
    packId: "pack-1", issuedAt: "now", state: "ready", host: "claude", briefHash: "", angleId: "user-direction",
    ledger: ledger.snapshot(), ledgerBudget: { max: 3, used: 0 }, repair: { max: 2, used: 0 }, reviewRounds: 0, attempts: {},
    context: {
      req: { topic: "例会纪要", topicId, platform: "douyin", modelExecution: "host", researchMode: "provided", research: RESEARCH },
      platform: "douyin", trackPackId: "koubo", prompts: { system: "按任务写作", user: RESEARCH }, researchSlot: RESEARCH,
      voiceSamples: [], canFindEvidence: true, rulesApplied: 0, wroteWithoutBrief: true, wroteWithoutAngle: false,
    },
  };
  await writePack(content.id, pack, dir);
  await updateContent(content.id, { pack: { packId: pack.packId, issuedAt: pack.issuedAt, host: pack.host } }, dir);
  return { contentId: content.id, pack, target: { content_id: content.id, pack_id: pack.packId } };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-content-evidence-"));
  topicId = (await saveTopic({ title: "例会纪要", description: "", tags: [] }, dir)).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("claim_offline 带稿件目标、不带 task_id", () => {
  it("登记成 user-<n> 的 user_claim 并带推算依据；同一句重登沿用原号不扣额度", async () => {
    const { contentId, target } = await seedProvidedDraft();
    const claim = { ...target, claim: "每场会议省三十分钟", reason: "user-research：40 分钟减 10 分钟" };
    const first = await scout({ action: "claim_offline", ...claim });
    expect(first).toMatchObject({
      ok: true, claim_id: "user-1", verified: false, host_evidence_used: 1, host_evidence_limit: 12,
      evidence_entry: { id: "user-1", source: "user_claim", claim: claim.claim, quote: claim.claim, reason: claim.reason },
      claim_token: expect.stringMatching(/^clm-/),
    });
    const token = first.claim_token as string;
    expect(await scout({ action: "claim_offline", ...claim, claim_token: token })).toMatchObject({ claim_id: "user-1", host_evidence_used: 1 });
    expect(
      await scout({ action: "claim_offline", ...target, claim_token: token, claim: "一周省一个半小时", reason: "3 场 × 30 分钟" }),
    ).toMatchObject({ claim_id: "user-2", host_evidence_used: 2 });

    const pack = (await readPack(contentId, dir))!;
    expect(pack.ledger.entries.map((e) => e.id)).toEqual(["user-research", "user-1", "user-2"]);
    expect((await getContent(contentId, dir))?.evidenceLedger?.entries.find((e) => e.id === "user-1")).toMatchObject({ reason: claim.reason });
    expect(await loadHostEvidence(contentId, dir)).toHaveLength(2);
    const md = await fs.readFile(path.join(dir, "contents", contentId, "writing-pack.md"), "utf-8");
    expect(md).toContain("- user-1（用户材料）：每场会议省三十分钟");
    // 没为登记另起一轮研究任务
    expect(await inspectHostResearchTask(topicId, dir)).toBeNull();
  });

  it("有活认领时不带令牌被拒（claim_held + 持有者），账本不动", async () => {
    const { contentId, target } = await seedProvidedDraft();
    const claimed = await claimContent(contentId, "writer", "claude", dir);
    if (!claimed.ok) throw new Error(claimed.error);
    const args = { action: "claim_offline", ...target, claim: "每场会议省三十分钟", reason: "40 减 10" };
    expect(await scout(args)).toMatchObject({ ok: false, code: "claim_held", holder: { host: "claude" } });
    expect(await loadHostEvidence(contentId, dir)).toEqual([]);
    expect((await readPack(contentId, dir))!.ledger.entries.map((e) => e.id)).toEqual(["user-research"]);
    expect(await scout({ ...args, claim_token: claimed.claim.token })).toMatchObject({ ok: true, claim_id: "user-1" });
  });

  it("每稿 12 条终身额度：第 13 条被拒", async () => {
    const { contentId, target } = await seedProvidedDraft();
    let token = "";
    for (let i = 1; i <= 12; i++) {
      const r = await scout({ action: "claim_offline", ...target, claim_token: token, claim: `推算${i}`, reason: "由 user-research 推算" });
      expect(r).toMatchObject({ ok: true, claim_id: `user-${i}`, host_evidence_used: i });
      token = r.claim_token as string;
    }
    expect(
      await scout({ action: "claim_offline", ...target, claim_token: token, claim: "推算13", reason: "由 user-research 推算" }),
    ).toMatchObject({ ok: false, code: "evidence_quota" });
    expect(await loadHostEvidence(contentId, dir)).toHaveLength(12);
  });

  it("缺 reason、cite 不带任务、没带稿件目标：各自说清，不落账", async () => {
    const { contentId, target } = await seedProvidedDraft();
    expect(await scout({ action: "claim_offline", ...target, claim: "每场省三十分钟" })).toMatchObject({ code: "missing_argument" });
    expect(await scout({ action: "cite", ...target, source_id: "p1", claim: "x", quote: "y" })).toMatchObject({ code: "task_required" });
    const bare = await scout({ action: "claim_offline", claim: "每场省三十分钟", reason: "40 减 10" });
    expect(bare).toMatchObject({ ok: false, code: "task_required" });
    expect(String(bare.error)).toContain("content_id");
    expect(await loadHostEvidence(contentId, dir)).toEqual([]);
  });

  it("带 task_id 的老路不变：记进研究任务，入稿条目仍是 ev-H…", async () => {
    const { contentId, target } = await seedProvidedDraft();
    const prepared = await scout({ action: "prepare", platform: "douyin", requirements: "按例会经历写" });
    expect(prepared.ok).toBe(true);
    const r = await scout({ action: "claim_offline", task_id: prepared.task_id, ...target, claim: "口述", reason: "无原页" });
    expect(r).toMatchObject({ ok: true, task_id: prepared.task_id, host_evidence_used: 1, evidence_entry: { source: "user_claim" } });
    expect(String(r.claim_id)).toMatch(/^u/);
    expect((r.evidence_entry as { id: string }).id).toMatch(/^ev-H/);
    expect((r.evidence_entry as { reason?: string }).reason).toBeUndefined();
    expect((await inspectHostResearchTask(topicId, dir))?.offlineClaims).toHaveLength(1);
    expect(await loadHostEvidence(contentId, dir)).toHaveLength(1);
  });
});
