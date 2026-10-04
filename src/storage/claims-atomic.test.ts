/** Codex 复审：所有认领改动共用一条按稿件的串行队列；剪辑工位的心跳认领永不被闲置接管 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureClaim, takeOverIdleClaim, transferClaim } from "./claims.js";
import { tokenMatches } from "./claim-token.js";
import { getContent, saveContent, updateContent } from "./local-store.js";
import { HUMAN_WRITE } from "./first-body-guard.js";

let dir: string;
async function idleClaimed(): Promise<{ id: string; token: string }> {
  const c = await saveContent({ title: "t", body: "正文".repeat(50), platform: "douyin", status: "draft_ready", tags: [], _provenance: HUMAN_WRITE }, dir);
  const r = await ensureClaim(c.id, { host: "claude-code", employee: "writer" }, dir);
  if (!r.ok) throw new Error("claim failed");
  const at = new Date(Date.now() - 11 * 60_000).toISOString();
  const cur = (await getContent(c.id, dir))!;
  await updateContent(c.id, { claim: { ...cur.claim!, lastWriteAt: at, at } }, dir);
  return { id: c.id, token: r.claim.token };
}
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "claims-atomic-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("认领改动原子化", () => {
  it("剪辑工位的心跳认领闲置多久都不被接管", async () => {
    const { id, token } = await idleClaimed();
    const t = await transferClaim(id, { token, host: "claude-code", toEmployee: "editor", toHost: "codex", heartbeat: true }, dir);
    expect(t.ok).toBe(true);
    const cur = (await getContent(id, dir))!;
    const at = new Date(Date.now() - 60 * 60_000).toISOString();
    await updateContent(id, { claim: { ...cur.claim!, lastWriteAt: at } }, dir);
    expect((await takeOverIdleClaim(id, "writer", "claude-code", dir)).ok).toBe(false);
    expect((await getContent(id, dir))!.claim).toMatchObject({ host: "codex", heartbeat: true });
  });

  it("同时转交给剪辑工位和闲置接管：剪辑的令牌与心跳不丢", async () => {
    const { id, token } = await idleClaimed();
    const [t, k] = await Promise.all([
      transferClaim(id, { token, host: "claude-code", toEmployee: "editor", toHost: "codex", heartbeat: true }, dir),
      takeOverIdleClaim(id, "writer", "other-host", dir),
    ]);
    const final = (await getContent(id, dir))!.claim!;
    if (t.ok) {
      expect(final.heartbeat).toBe(true);
      expect(tokenMatches(final.token, t.claim.token)).toBe(true);
    } else {
      expect(k.ok).toBe(true);
    }
  });

  it("同时续租和闲置接管：不会两个都拿到有效令牌", async () => {
    const { id, token } = await idleClaimed();
    const [renew, take] = await Promise.all([
      ensureClaim(id, { host: "claude-code", employee: "writer", token }, dir),
      takeOverIdleClaim(id, "writer", "other-host", dir),
    ]);
    const final = (await getContent(id, dir))!.claim!;
    if (renew.ok) expect(tokenMatches(final.token, renew.claim.token) || !take.ok).toBe(true);
    expect(renew.ok && take.ok).toBe(false);
  });
});

describe("锁顺序：系列锁 → 认领队列 → 单稿写锁（Codex 复审 P1 死锁）", () => {
  it("一边持系列锁再认领，一边在认领里续租系列范围内的稿：两边都在限时内完成", async () => {
    const { seriesTransaction } = await import("./series-transaction.js");
    const c = await saveContent({ title: "t", body: "正文".repeat(50), platform: "douyin", status: "draft_ready", tags: [], _provenance: HUMAN_WRITE }, dir);
    const first = await ensureClaim(c.id, { host: "claude-code", employee: "writer" }, dir);
    if (!first.ok) throw new Error("claim failed");
    const series = seriesTransaction(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return ensureClaim(c.id, { host: "claude-code", employee: "writer", token: first.claim.token }, dir);
    });
    const renew = ensureClaim(c.id, { host: "claude-code", employee: "writer", token: first.claim.token }, dir);
    const timeout = new Promise<"hang">((r) => setTimeout(() => r("hang"), 2000));
    expect(await Promise.race([Promise.all([series, renew]).then(() => "done"), timeout])).toBe("done");
  });
});

describe("排队期间租约到期的心跳续租（Codex 复审 P2）", () => {
  it("进队时有效、带当前令牌：仍按续租算，令牌与心跳都保留", async () => {
    const { vi } = await import("vitest");
    const { seriesTransaction } = await import("./series-transaction.js");
    const { id, token } = await idleClaimed();
    const t = await transferClaim(id, { token, host: "claude-code", toEmployee: "editor", toHost: "codex", heartbeat: true }, dir);
    if (!t.ok) throw new Error("transfer failed");
    let clock = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const cur = (await getContent(id, dir))!;
      await updateContent(id, { claim: { ...cur.claim!, leaseUntil: new Date(clock + 1000).toISOString() } }, dir);
      let release!: () => void;
      const blocker = seriesTransaction(() => new Promise<void>((r) => { release = r; }));
      while (!release) await new Promise((r) => setImmediate(r));
      const renew = ensureClaim(id, { host: "codex", employee: "editor", token: t.claim.token }, dir);
      clock += 2000;
      release();
      await blocker;
      const r = await renew;
      expect(r.ok && r.claim.token).toBe(t.claim.token);
      const final = (await getContent(id, dir))!.claim!;
      expect(final.heartbeat).toBe(true);
      expect(tokenMatches(final.token, t.claim.token)).toBe(true);
    } finally { spy.mockRestore(); }
  });
});
