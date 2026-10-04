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
