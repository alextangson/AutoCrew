/**
 * Codex 评审 P1：系列范围内稿件的任何写入都要先排系列锁——否则审稿台「核对快照 + 登记」期间，
 * 快照里邻居稿的正文可以被改掉，审稿仍以旧 draft_hash 落地 accepted。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getContent, revertToVersion, saveContent, transitionStatus, updateContent, updateContentIfDraftMatches } from "./local-store.js";
import { seriesTransaction } from "./series-transaction.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-series-lock-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

/** 占住系列锁，返回释放函数（模拟审稿台正在核对快照） */
async function holdSeriesLock(): Promise<() => Promise<void>> {
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const held = seriesTransaction(() => new Promise<void>((r) => { entered(); release = r; }));
  await inside;
  return async () => { release(); await held; };
}
const settledWithin = (p: Promise<unknown>, ms = 50) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe("writes to in-scope content wait for the series lock", () => {
  it("updateContent, updateContentIfDraftMatches, revertToVersion and leaving the range all queue behind a review check", async () => {
    const neighbour = await saveContent({ title: "邻居", body: "旧正文", platform: "douyin", status: "drafting", tags: [] }, dir);
    await transitionStatus(neighbour.id, "draft_ready", { force: true }, dir);
    const outside = await saveContent({ title: "范围外", body: "写稿中", platform: "douyin", status: "drafting", tags: [] }, dir);

    const release = await holdSeriesLock();
    const edit = updateContent(neighbour.id, { body: "审稿期间改的正文" }, dir);
    const matched = updateContentIfDraftMatches(neighbour.id, neighbour, { title: "改标题" }, dir);
    const revert = revertToVersion(neighbour.id, 1, dir);
    const leave = transitionStatus(neighbour.id, "revision", { force: true }, dir);
    const unrelated = updateContent(outside.id, { body: "范围外随便改" }, dir);
    expect(await settledWithin(unrelated)).toBe(true);
    expect(await settledWithin(edit)).toBe(false);
    expect(await settledWithin(matched)).toBe(false);
    expect(await settledWithin(revert)).toBe(false);
    expect(await settledWithin(leave)).toBe(false);
    expect((await getContent(neighbour.id, dir))?.body).toBe("旧正文");
    await release();
    await Promise.all([edit, matched, revert, leave]);
  });
});
