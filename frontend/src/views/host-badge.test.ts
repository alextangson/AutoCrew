/**
 * 宿主徽章（P3 spec §6.1 / §5.3）：字段缺了不许崩、不许编，租约过期必须自己说出来。
 */
import { describe, expect, it } from "vitest";
import { claimBadge, hostBadges, hostLabel, packWaitBadge, writtenByBadge } from "./host-badge";

const NOW = new Date("2026-09-06T12:00:00Z").getTime();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();
const minutesAhead = (n: number) => new Date(NOW + n * 60_000).toISOString();

describe("hostLabel", () => {
  it("maps the three known hosts and passes anything else through", () => {
    expect(hostLabel("claude-code")).toBe("Claude");
    expect(hostLabel("codex")).toBe("Codex");
    expect(hostLabel("dsh")).toBe("dsh");
    expect(hostLabel("local-user")).toBe("工作台");
    // 不认识的宿主原样显示——猜成某个已知宿主就是把归因编出来
    expect(hostLabel("gemini-cli")).toBe("gemini-cli");
    expect(hostLabel(undefined)).toBe("未知宿主");
  });
});

describe("writtenByBadge", () => {
  it("reads the host that actually wrote it", () => {
    const b = writtenByBadge({ writtenBy: { kind: "host", host: "claude-code" } });
    expect(b?.text).toBe("Claude 写");
    expect(b?.title).toContain("claude-code");
  });

  it("reads the provider name for the internal writer", () => {
    const b = writtenByBadge({ writtenBy: { kind: "engine", provider: "DeepSeek", model: "deepseek-chat" } });
    expect(b?.text).toBe("DeepSeek 写");
    expect(b?.title).toContain("deepseek-chat");
  });

  it("stays silent on old drafts and on half-filled records", () => {
    expect(writtenByBadge({})).toBeNull();
    expect(writtenByBadge({ writtenBy: null })).toBeNull();
    expect(writtenByBadge({ writtenBy: { kind: "host" } })).toBeNull();
    expect(writtenByBadge({ writtenBy: { kind: "engine" } })).toBeNull();
  });
});

describe("claimBadge", () => {
  it("shows who is on it and for how long while the lease holds", () => {
    const b = claimBadge(
      { claim: { employee: "cover", host: "codex", at: minutesAgo(12), leaseUntil: minutesAhead(18) } },
      NOW,
    );
    expect(b?.text).toBe("Codex 封面中 · 12 分钟前");
    expect(b?.tone).toBe("host");
    expect(b?.title).toContain("会被拒");
  });

  it("greys out an expired lease and says takeover is possible", () => {
    const b = claimBadge(
      { claim: { employee: "writer", host: "codex", at: minutesAgo(45), leaseUntil: minutesAgo(15) } },
      NOW,
    );
    expect(b?.text).toBe("租约过期");
    expect(b?.tone).toBe("stale");
    expect(b?.title).toContain("接管");
  });

  it("survives missing or unparsable fields", () => {
    expect(claimBadge({}, NOW)).toBeNull();
    expect(claimBadge({ claim: null }, NOW)).toBeNull();
    expect(claimBadge({ claim: { host: "codex" } }, NOW)).toBeNull();
    expect(claimBadge({ claim: { host: "codex", leaseUntil: "不是时间" } }, NOW)).toBeNull();
  });

  it("still renders without the claim timestamp", () => {
    const b = claimBadge({ claim: { employee: "editor", host: "dsh", leaseUntil: minutesAhead(5) } }, NOW);
    expect(b?.text).toBe("dsh 剪辑中");
  });
});

describe("packWaitBadge", () => {
  it("says the pack went out and no draft came back", () => {
    const b = packWaitBadge(
      { status: "drafting", pack: { packId: "wp-1", issuedAt: minutesAgo(12), host: "codex" } },
      NOW,
    );
    expect(b?.text).toBe("未收到稿 · 12 分钟前");
    expect(b?.tone).toBe("stale");
    expect(b?.title).toContain("写作包已发给 Codex");
  });

  it("goes away once the draft arrives, and never fires outside drafting/revision", () => {
    const pack = { packId: "wp-1", issuedAt: minutesAgo(12), host: "codex" };
    expect(packWaitBadge({ status: "drafting", pack: { ...pack, submittedAt: minutesAgo(1) } }, NOW)).toBeNull();
    expect(packWaitBadge({ status: "draft_ready", pack }, NOW)).toBeNull();
    expect(packWaitBadge({ status: "drafting" }, NOW)).toBeNull();
    expect(packWaitBadge({ status: "revision", pack }, NOW)?.key).toBe("pack");
  });
});

describe("hostBadges", () => {
  it("orders them 谁写的 → 谁在动 → 领了没交", () => {
    const badges = hostBadges(
      {
        status: "drafting",
        writtenBy: { kind: "host", host: "codex" },
        claim: { employee: "writer", host: "codex", at: minutesAgo(3), leaseUntil: minutesAhead(27) },
        pack: { packId: "wp-1", issuedAt: minutesAgo(3), host: "codex" },
      },
      NOW,
    );
    expect(badges.map((b) => b.key)).toEqual(["written", "claim", "pack"]);
  });

  it("is empty for a plain old draft", () => {
    expect(hostBadges({ status: "draft_ready" }, NOW)).toEqual([]);
  });
});
