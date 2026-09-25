/**
 * claims.test.ts — 认领、租约、令牌门与交接台账（P3 spec §6.1）。
 *
 * 这条链只有三件事值得钉死，其余都是包装：
 * 1. **过期等于没人认领**，且接管必须换令牌（不换就没有 fencing，迟到写入照样落盘）；
 * 2. **令牌对不上就不许写**，拒绝话术要说得出持有者是谁——说不出，宿主只会干等；
 * 3. **交接要留账**，五处转换与接管各记一条，稿卡那条链才读得出来。
 * P6 §3.8 之后再加一条：**令牌是凭据，同宿主不例外**——宿主名下可能是另一个会话。
 *
 * 全程真实临时目录，零网络。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  activeClaim,
  assertClaimToken,
  claimContent,
  claimGrant,
  claimView,
  CLAIM_LEASE_MS,
  ensureClaim,
  redactClaim,
  releaseClaim,
  transferClaim,
} from "./claims.js";
import {
  approveCoverVariant,
  getContent,
  saveContent,
  saveCoverReview,
  transitionStatus,
  updateContent,
  type Content,
  type ContentStatus,
} from "./local-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-claims-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function seed(status: ContentStatus = "drafting", platform = "wechat_mp"): Promise<Content> {
  return saveContent(
    { title: "AI 写码的账", body: "正文", platform, status, tags: [], hashtags: [] },
    dir,
  );
}

/** 把租约手动推到过去——测过期不许靠 sleep */
async function expireLease(id: string): Promise<void> {
  const content = await getContent(id, dir);
  await updateContent(
    id,
    { claim: { ...content!.claim!, leaseUntil: new Date(Date.now() - 60_000).toISOString() } },
    dir,
  );
}

describe("claim / renew / conflict", () => {
  it("首次认领拿到令牌与 30 分钟租约", async () => {
    const c = await seed();
    const r = await claimContent(c.id, "writer", "codex", dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim.token).toMatch(/^clm-/);
    const left = Date.parse(r.claim.leaseUntil) - Date.now();
    expect(left).toBeGreaterThan(CLAIM_LEASE_MS - 60_000);
    expect(left).toBeLessThanOrEqual(CLAIM_LEASE_MS);
    expect((await getContent(c.id, dir))!.claim?.host).toBe("codex");
  });

  it("同宿主带着令牌重复认领 = 续约，令牌不变", async () => {
    const c = await seed();
    const first = await claimContent(c.id, "writer", "codex", dir);
    await new Promise((r) => setTimeout(r, 5));
    const again = await claimContent(c.id, "writer", "codex", dir, { token: first.ok ? first.claim.token : "" });
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.claim.token).toBe(first.claim.token);
    expect(Date.parse(again.claim.leaseUntil)).toBeGreaterThan(Date.parse(first.claim.leaseUntil));
  });

  it("别的宿主在租约内认领 → 被拒并返回持有者（不含令牌）", async () => {
    const c = await seed();
    await claimContent(c.id, "writer", "codex", dir);
    const second = await claimContent(c.id, "writer", "claude-code", dir);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain("codex");
    expect(second.error).toContain("写手");
    expect(second.holder).toBeDefined();
    expect(second.holder as unknown as Record<string, unknown>).not.toHaveProperty("token");
  });

  it("创始人自己（local-user）明确认领也挡不过别人的活租约", async () => {
    const c = await seed();
    await claimContent(c.id, "writer", "codex", dir);
    expect((await claimContent(c.id, "writer", "local-user", dir)).ok).toBe(false);
  });
});

describe("过期与接管", () => {
  it("租约过期 = 没人认领", async () => {
    const c = await seed();
    await claimContent(c.id, "writer", "codex", dir);
    await expireLease(c.id);
    expect(activeClaim((await getContent(c.id, dir))!)).toBeNull();
  });

  it("过期后被接管：换新令牌 + handoffs 记一条「接管（租约过期）」", async () => {
    const c = await seed();
    const first = await claimContent(c.id, "writer", "codex", dir);
    await expireLease(c.id);
    const taken = await claimContent(c.id, "writer", "claude-code", dir);
    expect(first.ok && taken.ok).toBe(true);
    if (!first.ok || !taken.ok) return;
    expect(taken.claim.token).not.toBe(first.claim.token);

    const after = await getContent(c.id, dir);
    const handoff = after!.handoffs?.at(-1);
    expect(handoff).toMatchObject({ from: "codex", to: "claude-code", by: "claude-code" });
    expect(handoff?.note).toContain("接管");
  });

  it("接管后旧令牌的迟到写入被拒（fencing）", async () => {
    const c = await seed();
    const first = await claimContent(c.id, "writer", "codex", dir);
    await expireLease(c.id);
    await claimContent(c.id, "writer", "claude-code", dir);
    const stale = assertClaimToken(
      (await getContent(c.id, dir))!,
      "codex",
      first.ok ? first.claim.token : "x",
    );
    expect(stale.ok).toBe(false);
  });
});

describe("release", () => {
  it("令牌对不上不许释放", async () => {
    const c = await seed();
    await claimContent(c.id, "writer", "codex", dir);
    const r = await releaseClaim(c.id, "clm-not-mine", dir);
    expect(r.ok).toBe(false);
    expect((await getContent(c.id, dir))!.claim).toBeTruthy();
  });

  it("令牌匹配 → 认领清空", async () => {
    const c = await seed();
    const claimed = await claimContent(c.id, "writer", "codex", dir);
    if (!claimed.ok) throw new Error("claim failed");
    expect(await releaseClaim(c.id, claimed.claim.token, dir)).toEqual({ ok: true, released: true });
    expect((await getContent(c.id, dir))!.claim).toBeUndefined();
  });
});

describe("assertClaimToken / ensureClaim", () => {
  it("没人认领 → 放行；带匹配令牌 → 放行；同宿主不带令牌 → 拒（P6 §3.8）", async () => {
    const c = await seed();
    expect(assertClaimToken(c, "codex").ok).toBe(true);
    const claimed = await claimContent(c.id, "writer", "codex", dir);
    if (!claimed.ok) throw new Error("claim failed");
    const stored = (await getContent(c.id, dir))!;
    expect(assertClaimToken(stored, "codex", claimed.claim.token)).toEqual({ ok: true });
    expect(assertClaimToken(stored, "claude-code", claimed.claim.token)).toEqual({ ok: true });
    expect(assertClaimToken(stored, "codex")).toMatchObject({ ok: false, code: "claim_held" });
  });

  it("别的宿主无令牌 → 拒绝，话里有持有者与剩余分钟", async () => {
    const c = await seed();
    await claimContent(c.id, "writer", "codex", dir);
    const gate = assertClaimToken((await getContent(c.id, dir))!, "claude-code");
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.error).toContain("codex");
    expect(gate.error).toMatch(/还剩 \d+ 分钟/);
  });

  it("工作台（local-user）越得过令牌门，但不抢别人还活着的认领", async () => {
    const c = await seed();
    await claimContent(c.id, "writer", "codex", dir);
    const guard = await ensureClaim(c.id, { host: "local-user" }, dir);
    expect(guard.ok).toBe(true);
    expect((await getContent(c.id, dir))!.claim?.host).toBe("codex");
  });

  it("没人认领时写操作自动认领（软门），岗位缺省沿用旧岗位", async () => {
    const c = await seed();
    await claimContent(c.id, "cover", "codex", dir);
    await expireLease(c.id);
    const guard = await ensureClaim(c.id, { host: "codex" }, dir);
    expect(guard.ok).toBe(true);
    expect((await getContent(c.id, dir))!.claim?.employee).toBe("cover");
  });

  it("续租：带匹配令牌的写操作把租约推后", async () => {
    const c = await seed();
    const claimed = await claimContent(c.id, "writer", "codex", dir);
    if (!claimed.ok) throw new Error("claim failed");
    await new Promise((r) => setTimeout(r, 5));
    const renewed = await ensureClaim(c.id, { host: "claude-code", token: claimed.claim.token }, dir);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.claim.token).toBe(claimed.claim.token);
    expect(Date.parse(renewed.claim.leaseUntil)).toBeGreaterThan(Date.parse(claimed.claim.leaseUntil));
  });
});

describe("脱敏", () => {
  it("claimView / redactClaim 抹掉令牌，其余字段保留", async () => {
    const c = await seed();
    await claimContent(c.id, "writer", "codex", dir);
    const stored = (await getContent(c.id, dir))!;
    expect(claimView(stored.claim)).not.toHaveProperty("token");
    expect(claimView(stored.claim)?.host).toBe("codex");
    expect(redactClaim(stored).claim).not.toHaveProperty("token");
    // 原对象不被就地改写——脱敏是拷贝，不是破坏
    expect(stored.claim?.token).toBeTruthy();
  });
});

describe("交接台账（五处）", () => {
  it("draft_ready：写手 → 创作者，by 记调用宿主", async () => {
    const c = await seed("drafting");
    const moved = await transitionStatus(c.id, "draft_ready", { host: "codex" }, dir);
    expect(moved.ok).toBe(true);
    expect(moved.content?.handoffs?.at(-1)).toMatchObject({ from: "writer", to: "creator", by: "codex" });
  });

  it("approved：视频稿交给剪辑师，图文稿直接交给发布", async () => {
    const video = await seed("reviewing", "douyin");
    const text = await seed("reviewing", "wechat_mp");
    const a = await transitionStatus(video.id, "approved", {}, dir);
    const b = await transitionStatus(text.id, "approved", {}, dir);
    expect(a.content?.handoffs?.at(-1)).toMatchObject({ from: "creator", to: "editor" });
    expect(b.content?.handoffs?.at(-1)).toMatchObject({ from: "creator", to: "publisher" });
  });

  it("publish_ready（pre_publish 走的那条）记一条交接", async () => {
    const c = await seed("approved", "wechat_mp");
    const moved = await transitionStatus(c.id, "publish_ready", {}, dir);
    expect(moved.ok).toBe(true);
    expect(moved.content?.handoffs?.at(-1)).toMatchObject({ to: "publisher" });
  });

  it("videoDone 盖戳：剪辑师 → 封面师，by 记当前认领人", async () => {
    const c = await seed("editing", "douyin");
    await claimContent(c.id, "editor", "codex", dir);
    const updated = await updateContent(
      c.id,
      { videoDone: { renderedRevision: 2, at: new Date().toISOString() } },
      dir,
    );
    expect(updated?.handoffs?.at(-1)).toMatchObject({ from: "editor", to: "cover", by: "codex" });
  });

  it("封面 approve：封面师 → 发布（状态不动，只记账）", async () => {
    const c = await seed("cover_pending", "douyin");
    await saveCoverReview(
      c.id,
      {
        platform: "douyin",
        status: "review_pending",
        variants: [{ label: "a", imagePaths: { "3:4": "/tmp/a.png" }, revision: 1 }],
      },
      dir,
    );
    await claimContent(c.id, "cover", "codex", dir);
    const review = await approveCoverVariant(c.id, "a", dir);
    expect(review?.approvedLabel).toBe("a");
    const after = await getContent(c.id, dir);
    expect(after!.status).toBe("cover_pending"); // approve 不推状态（§6.2）
    expect(after!.handoffs?.at(-1)).toMatchObject({ from: "cover", to: "publisher", by: "codex" });
  });
});

describe("交接即释放（真机 2026-09-06）", () => {
  it("写手认领的稿推进到 draft_ready，写手认领随交接清掉；别的岗位认领不动", async () => {
    const { saveContent, transitionStatus, getContent } = await import("./local-store.js");
    const { claimContent } = await import("./claims.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ac-claims-handoff-"));
    try {
      const c = await saveContent({ title: "t", body: "b", platform: "wechat", status: "drafting" }, dir);
      const claimed = await claimContent(c.id, "writer", "claude-code", dir);
      expect(claimed.ok).toBe(true);
      expect((await transitionStatus(c.id, "draft_ready", { host: "claude-code" }, dir)).ok).toBe(true);
      const after = await getContent(c.id, dir);
      expect(after?.claim).toBeUndefined();
      expect(after?.handoffs?.at(-1)).toMatchObject({ from: "writer", to: "creator" });
      // 封面师的认领在过审时不该被清：过审的交接是 creator → publisher/editor
      const c2 = await saveContent({ title: "t2", body: "b", platform: "wechat", status: "reviewing" }, dir);
      expect((await claimContent(c2.id, "cover", "codex", dir)).ok).toBe(true);
      expect((await transitionStatus(c2.id, "approved", {}, dir)).ok).toBe(true);
      expect((await getContent(c2.id, dir))?.claim?.employee).toBe("cover");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("写门：令牌是凭据，同宿主不例外（P6 §3.8）", () => {
  it("同宿主第二个会话（不带令牌）：认领与写入都 claim_held，拒绝里不带令牌", async () => {
    const c = await seed();
    const first = await claimContent(c.id, "writer", "claude-code", dir);
    if (!first.ok) throw new Error("claim failed");
    const second = await claimContent(c.id, "writer", "claude-code", dir);
    expect(second).toMatchObject({ ok: false, code: "claim_held", holder: { host: "claude-code" } });
    if (second.ok) return;
    expect(second.error).toContain("同宿主的另一个会话");
    expect(second.error).toContain("takeover:true");
    expect(JSON.stringify(second)).not.toContain(first.claim.token);

    const write = await ensureClaim(c.id, { host: "claude-code" }, dir);
    expect(write).toMatchObject({ ok: false, code: "claim_held" });
    expect((await getContent(c.id, dir))!.claim?.token).toBe(first.claim.token);
  });

  it("takeover:true：换新令牌、记一条交接，旧令牌随即失效", async () => {
    const c = await seed();
    const first = await claimContent(c.id, "writer", "claude-code", dir);
    if (!first.ok) throw new Error("claim failed");
    const taken = await claimContent(c.id, "writer", "claude-code", dir, { takeover: true });
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.claim.token).not.toBe(first.claim.token);
    const after = (await getContent(c.id, dir))!;
    expect(after.handoffs?.at(-1)).toMatchObject({
      from: "claude-code",
      to: "claude-code",
      by: "claude-code",
      note: "接管（同宿主另一会话）",
    });
    expect(assertClaimToken(after, "claude-code", first.claim.token).ok).toBe(false);
    expect(assertClaimToken(after, "claude-code", taken.claim.token).ok).toBe(true);
  });

  it("takeover 挡不过别的宿主的活租约（跨宿主只能等租约过期）", async () => {
    const c = await seed();
    await claimContent(c.id, "writer", "codex", dir);
    const r = await claimContent(c.id, "writer", "claude-code", dir, { takeover: true });
    expect(r).toMatchObject({ ok: false, code: "claim_held", holder: { host: "codex" } });
  });

  it("local-user 越门写入：放行、不抢认领，handoffs 记 override:true；令牌不回给他", async () => {
    const c = await seed();
    const held = await claimContent(c.id, "writer", "codex", dir);
    if (!held.ok) throw new Error("claim failed");
    expect(assertClaimToken((await getContent(c.id, dir))!, "local-user")).toEqual({ ok: true, override: true });

    const guard = await ensureClaim(c.id, { host: "local-user" }, dir);
    expect(guard).toMatchObject({ ok: true, override: true });
    expect(claimGrant(guard, "local-user")).toEqual({});
    const after = (await getContent(c.id, dir))!;
    expect(after.claim?.host).toBe("codex");
    expect(after.claim?.token).toBe(held.claim.token);
    expect(after.handoffs?.at(-1)).toMatchObject({
      from: "codex",
      to: "local-user",
      by: "local-user",
      note: "工作台越过认领",
      override: true,
    });
  });

  it("工作台写自己名下的认领不算越门：不记 override", async () => {
    const c = await seed();
    await ensureClaim(c.id, { host: "local-user" }, dir);
    expect(assertClaimToken((await getContent(c.id, dir))!, "local-user")).toEqual({ ok: true });
    await ensureClaim(c.id, { host: "local-user" }, dir);
    expect((await getContent(c.id, dir))!.handoffs ?? []).toHaveLength(0);
  });

  it("写操作自动认领时令牌只回给认领宿主本人", async () => {
    const c = await seed();
    const mine = await ensureClaim(c.id, { host: "claude-code" }, dir);
    expect(claimGrant(mine, "claude-code").claim_token).toMatch(/^clm-/);
    // 带着别人令牌续租的宿主：认领仍记在原主名下，回执不再重发令牌
    const token = claimGrant(mine, "claude-code").claim_token!;
    const borrowed = await ensureClaim(c.id, { host: "codex", token }, dir);
    expect(borrowed.ok && borrowed.claim.host).toBe("claude-code");
    expect(claimGrant(borrowed, "codex")).toEqual({});
  });
});

describe("transferClaim：交接即转移（P6 §3.8）", () => {
  it("写手/claude-code → 剪辑师/codex：新令牌、旧令牌作废、交接留账", async () => {
    const c = await seed("approved", "douyin");
    const writer = await claimContent(c.id, "writer", "claude-code", dir);
    if (!writer.ok) throw new Error("claim failed");
    const moved = await transferClaim(
      c.id,
      { token: writer.claim.token, host: "claude-code", toEmployee: "editor", toHost: "codex" },
      dir,
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.claim).toMatchObject({ employee: "editor", host: "codex" });
    expect(moved.claim.token).not.toBe(writer.claim.token);

    const after = (await getContent(c.id, dir))!;
    expect(after.claim).toMatchObject({ employee: "editor", host: "codex", token: moved.claim.token });
    expect(after.handoffs?.at(-1)).toMatchObject({ from: "writer", to: "editor", by: "claude-code" });
    expect(after.handoffs?.at(-1)?.note).toContain("claude-code → codex");
    // 旧令牌的迟到写入被拒；新令牌放行
    expect(await ensureClaim(c.id, { host: "claude-code", token: writer.claim.token }, dir)).toMatchObject({
      ok: false,
      code: "claim_held",
    });
    expect((await ensureClaim(c.id, { host: "codex", token: moved.claim.token }, dir)).ok).toBe(true);
  });

  it("没令牌的调用方转不走别人的认领；local-user 可以，账上标 override", async () => {
    const c = await seed("approved", "douyin");
    await claimContent(c.id, "writer", "claude-code", dir);
    const input = { host: "claude-code", toEmployee: "editor" as const, toHost: "codex" };
    expect(await transferClaim(c.id, input, dir)).toMatchObject({ ok: false, code: "claim_held" });
    expect((await getContent(c.id, dir))!.claim?.host).toBe("claude-code");

    const byUser = await transferClaim(c.id, { ...input, host: "local-user", note: "工作台派工" }, dir);
    expect(byUser).toMatchObject({ ok: true, claim: { host: "codex", employee: "editor" } });
    expect((await getContent(c.id, dir))!.handoffs?.at(-1)).toMatchObject({
      from: "writer",
      to: "editor",
      by: "local-user",
      override: true,
      note: "工作台派工（claude-code → codex）",
    });
  });

  it("没人认领时直接转交给下一岗", async () => {
    const c = await seed("approved", "douyin");
    const moved = await transferClaim(c.id, { host: "claude-code", toEmployee: "editor", toHost: "codex" }, dir);
    expect(moved).toMatchObject({ ok: true, claim: { host: "codex", employee: "editor" } });
    expect((await getContent(c.id, dir))!.handoffs?.at(-1)).toMatchObject({ from: "claude-code", to: "editor" });
  });

  it("稿件不存在 → ok:false", async () => {
    expect(await transferClaim("content-nope", { host: "x", toEmployee: "editor", toHost: "codex" }, dir)).toMatchObject({
      ok: false,
    });
  });
});
