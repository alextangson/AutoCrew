/**
 * Codex 评审 P2：显式传 undefined 清掉摘要/手法卡/快照 id 时，稿件、版本记录和审稿上下文指纹要一致。
 * 走真实路径：旧包（无冻结快照）交稿的 persistDraft 就是这样清掉上一版遗留的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getContent, reviewContextHash, saveContent, updateContent } from "./local-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-ctx-clear-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const OUTLINE = {
  thesis: "t", points: [{ text: "p", kind: "case" as const, seconds: 1 }],
  structure: { opening: "o", progression: "p", ending: "e" }, said: [],
};

describe("explicit undefined clears context consistently", () => {
  it("content, the new version record and the review-context fingerprint all agree after clearing", async () => {
    const c = await saveContent({ title: "标题", body: "第一版", platform: "douyin", status: "drafting", tags: [] }, dir);
    await updateContent(c.id, { body: "第二版", outline: OUTLINE, technique_ids: [{ id: "minto-scq-intro", version: 1 }], seriesSnapshotId: "snap-1" }, dir);
    expect((await getContent(c.id, dir))?.reviewContextHash).toBeTruthy();

    await updateContent(c.id, { body: "第三版（旧包交稿）", outline: undefined, technique_ids: undefined, seriesSnapshotId: undefined }, dir);
    const after = (await getContent(c.id, dir))!;
    expect(after.outline).toBeUndefined();
    expect(after.technique_ids).toBeUndefined();
    expect(after.seriesSnapshotId).toBeUndefined();
    expect(after.reviewContextHash).toBeUndefined();
    const last = after.versions.at(-1)!;
    expect(last.body).toBe("第三版（旧包交稿）");
    expect(last.outline).toBeUndefined();
    expect(last.technique_ids).toBeUndefined();
    expect(last.seriesSnapshotId).toBeUndefined();
    expect(last.reviewContextHash).toBeUndefined();

    // 只清掉手法卡：指纹按实际剩下的状态算
    await updateContent(c.id, { body: "第四版", outline: OUTLINE, technique_ids: [{ id: "minto-scq-intro", version: 1 }], seriesSnapshotId: "snap-2" }, dir);
    await updateContent(c.id, { technique_ids: undefined }, dir);
    const partial = (await getContent(c.id, dir))!;
    expect(partial.technique_ids).toBeUndefined();
    expect(partial.reviewContextHash).toBe(reviewContextHash(partial, partial));
    expect(partial.versions.at(-1)).toMatchObject({ reviewContextHash: partial.reviewContextHash, seriesSnapshotId: "snap-2" });
    expect(partial.versions.at(-1)?.technique_ids).toBeUndefined();
  });
});
