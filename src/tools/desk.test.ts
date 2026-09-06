/**
 * desk.test.ts — 三张待办桌、认领令牌门（P3 spec §6.1）。
 *
 * 桌子的判据全部从既有状态推出来，所以这里钉的是**判据**本身：写手桌上「已选卡还没稿」的
 * 选题必须以 `content_id: null` 出现（领包时才建稿），封面桌不许列已定稿封面的稿，
 * 剪辑桌不许列已审过片的稿。另一半钉的是令牌门：别的宿主拿着活租约时，写操作要被拒且说得出持有者。
 *
 * 令牌门用 `autocrew_writer submit` 与 `autocrew_content` 做样本——门在动手之前，
 * 所以不需要真备料/真出图就能观测到它。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { executeDesk } from "./desk.js";
import { executeWriter } from "./writer.js";
import { executeContentSave } from "./content-save.js";
import { claimContent } from "../storage/claims.js";
import {
  getContent,
  saveContent,
  saveCoverReview,
  saveTopic,
  transitionStatus,
  updateContent,
  updateTopic,
  type Content,
  type ContentStatus,
} from "../storage/local-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-desk-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

interface InboxReply {
  ok: boolean;
  count?: number;
  items?: Array<{ content_id: string | null; topic_id?: string; status: string; claim?: Record<string, unknown> }>;
  error?: string;
}

async function inbox(employee: string): Promise<InboxReply> {
  return (await executeDesk({ action: "inbox", employee, _dataDir: dir })) as InboxReply;
}

async function seedTopicWithAngle(title: string): Promise<string> {
  const topic = await saveTopic({ title, description: "描述", tags: [] }, dir);
  await updateTopic(
    topic.id,
    {
      selectedAngle: {
        briefRevision: 1,
        angleId: "angle-1",
        card: { id: "angle-1", angle: "算一笔账", thesis: "省下的被吃回去了" } as never,
        selectedAt: new Date().toISOString(),
      },
    },
    dir,
  );
  return topic.id;
}

async function seedContent(
  status: ContentStatus,
  platform = "wechat_mp",
  topicId?: string,
): Promise<Content> {
  return saveContent(
    { title: `稿-${status}`, body: "正文", platform, status, tags: [], hashtags: [], ...(topicId ? { topicId } : {}) },
    dir,
  );
}

describe("inbox writer", () => {
  it("已选立意卡且无稿的选题：content_id 为 null（领包时才建稿）", async () => {
    const topicId = await seedTopicWithAngle("AI 写码的账");
    const r = await inbox("writer");
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items![0]).toMatchObject({ content_id: null, topic_id: topicId, status: "topic_saved" });
  });

  it("没选卡的选题不上桌；已有活稿的选题也不上桌", async () => {
    await saveTopic({ title: "还没选卡", description: "d", tags: [] }, dir);
    const busy = await seedTopicWithAngle("已经在写了");
    await seedContent("drafting", "wechat_mp", busy);
    expect((await inbox("writer")).count).toBe(0);
  });

  it("归档稿不算「有稿」：选题回到桌上", async () => {
    const topicId = await seedTopicWithAngle("写废了一次");
    const c = await seedContent("drafting", "wechat_mp", topicId);
    await transitionStatus(c.id, "archived", { force: true }, dir);
    const r = await inbox("writer");
    expect(r.items!.map((i) => i.topic_id)).toContain(topicId);
  });

  it("退回修订的稿也在写手桌上，带 content_id", async () => {
    const c = await seedContent("revision");
    const r = await inbox("writer");
    expect(r.items!.some((i) => i.content_id === c.id && i.status === "revision")).toBe(true);
  });
});

describe("inbox cover / editor", () => {
  it("封面桌：封面台上还没定稿封面的稿；定稿了就下桌", async () => {
    const pending = await seedContent("cover_pending", "douyin");
    const done = await seedContent("cover_pending", "douyin");
    await saveCoverReview(
      done.id,
      {
        platform: "douyin",
        status: "publish_ready",
        approvedLabel: "a",
        variants: [{ label: "a", imagePaths: { "3:4": "/tmp/a.png" }, revision: 1 }],
      },
      dir,
    );
    const r = await inbox("cover");
    expect(r.items!.map((i) => i.content_id)).toEqual([pending.id]);
  });

  it("剪辑桌：在剪辑台且成片没审过；盖了 videoDone 就下桌", async () => {
    const open = await seedContent("editing", "douyin");
    const done = await seedContent("editing", "douyin");
    await updateContent(done.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } }, dir);
    const r = await inbox("editor");
    expect(r.items!.map((i) => i.content_id)).toEqual([open.id]);
  });

  it("employee 非法 → 明确报错，不给一张空桌糊弄", async () => {
    const r = await inbox("designer");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("writer");
  });
});

describe("claim / release", () => {
  it("claim 回令牌与租约；inbox 里的 claim 不带令牌", async () => {
    const c = await seedContent("revision");
    const claimed = (await executeDesk({
      action: "claim",
      content_id: c.id,
      employee: "writer",
      _host: "codex",
      _dataDir: dir,
    })) as { ok: boolean; claim_token: string; lease_until: string };
    expect(claimed.ok).toBe(true);
    expect(claimed.claim_token).toMatch(/^clm-/);
    expect(Date.parse(claimed.lease_until)).toBeGreaterThan(Date.now());

    const item = (await inbox("writer")).items!.find((i) => i.content_id === c.id);
    expect(item!.claim).toMatchObject({ host: "codex", employee: "writer" });
    expect(item!.claim).not.toHaveProperty("token");
  });

  it("两个宿主同时认领：第二个被拒并拿到持有者", async () => {
    const c = await seedContent("revision");
    await executeDesk({ action: "claim", content_id: c.id, employee: "writer", _host: "codex", _dataDir: dir });
    const second = (await executeDesk({
      action: "claim",
      content_id: c.id,
      employee: "writer",
      _host: "claude-code",
      _dataDir: dir,
    })) as { ok: boolean; error: string; holder: Record<string, unknown> };
    expect(second.ok).toBe(false);
    expect(second.error).toContain("codex");
    expect(second.holder).not.toHaveProperty("token");
  });

  it("release 要令牌匹配", async () => {
    const c = await seedContent("revision");
    const claimed = (await executeDesk({
      action: "claim",
      content_id: c.id,
      employee: "writer",
      _host: "codex",
      _dataDir: dir,
    })) as { claim_token: string };
    expect((await executeDesk({ action: "release", content_id: c.id, claim_token: "clm-x", _dataDir: dir })).ok).toBe(
      false,
    );
    expect(
      (await executeDesk({ action: "release", content_id: c.id, claim_token: claimed.claim_token, _dataDir: dir })).ok,
    ).toBe(true);
    expect((await getContent(c.id, dir))!.claim).toBeUndefined();
  });
});

describe("令牌门（autocrew_writer / autocrew_content）", () => {
  it("别的宿主无令牌交稿 → 被拒，话里有持有者", async () => {
    const c = await seedContent("drafting");
    await claimContent(c.id, "writer", "codex", dir);
    const r = (await executeWriter({
      action: "submit",
      content_id: c.id,
      pack_id: "wp-x",
      attempt: 1,
      title: "t",
      body: "正文",
      _host: "claude-code",
      _dataDir: dir,
    })) as { ok: boolean; error: string; holder?: Record<string, unknown> };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("codex");
    expect(r.holder).toMatchObject({ employee: "writer" });
  });

  it("带匹配令牌 → 过门（挡下它的是包号，不是认领），并续租", async () => {
    const c = await seedContent("drafting");
    const claimed = await claimContent(c.id, "writer", "codex", dir);
    if (!claimed.ok) throw new Error("claim failed");
    const before = Date.parse(claimed.claim.leaseUntil);
    await new Promise((r) => setTimeout(r, 5));
    const r = (await executeWriter({
      action: "find_evidence",
      content_id: c.id,
      pack_id: "wp-x",
      need: "某案例",
      claim_token: claimed.claim.token,
      _host: "claude-code",
      _dataDir: dir,
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("正由");
    const after = (await getContent(c.id, dir))!.claim!;
    expect(after.token).toBe(claimed.claim.token);
    expect(Date.parse(after.leaseUntil)).toBeGreaterThan(before);
  });

  it("租约过期 → 新宿主直接接管，交接留账", async () => {
    const c = await seedContent("drafting");
    await claimContent(c.id, "writer", "codex", dir);
    const held = await getContent(c.id, dir);
    await updateContent(
      c.id,
      { claim: { ...held!.claim!, leaseUntil: new Date(Date.now() - 1000).toISOString() } },
      dir,
    );
    const r = (await executeWriter({
      action: "submit",
      content_id: c.id,
      pack_id: "wp-x",
      attempt: 1,
      title: "t",
      body: "正文",
      _host: "claude-code",
      _dataDir: dir,
    })) as { ok: boolean; error: string };
    expect(r.error).not.toContain("正由");
    const after = await getContent(c.id, dir);
    expect(after!.claim?.host).toBe("claude-code");
    expect(after!.handoffs?.at(-1)?.note).toContain("接管");
  });

  it("autocrew_content transition / update 同样过门", async () => {
    const c = await seedContent("drafting");
    await claimContent(c.id, "writer", "codex", dir);
    const moved = (await executeContentSave({
      action: "transition",
      id: c.id,
      target_status: "draft_ready",
      _host: "claude-code",
      _dataDir: dir,
    })) as { ok: boolean; error: string };
    expect(moved.ok).toBe(false);
    expect(moved.error).toContain("codex");

    const edited = (await executeContentSave({
      action: "update",
      id: c.id,
      title: "改个标题",
      _host: "claude-code",
      _dataDir: dir,
    })) as { ok: boolean; error: string };
    expect(edited.ok).toBe(false);
    expect((await getContent(c.id, dir))!.title).toBe("稿-drafting");
  });

  it("工作台（无 _host = local-user）越得过门，稿件视图不带令牌", async () => {
    const c = await seedContent("drafting");
    await claimContent(c.id, "writer", "codex", dir);
    const moved = (await executeContentSave({
      action: "transition",
      id: c.id,
      target_status: "draft_ready",
      _dataDir: dir,
    })) as { ok: boolean; content?: { claim?: Record<string, unknown>; handoffs?: unknown[] } };
    expect(moved.ok).toBe(true);
    expect(moved.content!.claim).not.toHaveProperty("token");
    expect(moved.content!.claim).toMatchObject({ host: "codex" });
    expect(moved.content!.handoffs).toHaveLength(1);

    const list = (await executeContentSave({ action: "list", _dataDir: dir })) as {
      contents: Array<{ claim?: Record<string, unknown> }>;
    };
    expect(list.contents[0].claim).not.toHaveProperty("token");
    const got = (await executeContentSave({ action: "get", id: c.id, _dataDir: dir })) as {
      content: { claim?: Record<string, unknown> };
    };
    expect(got.content.claim).not.toHaveProperty("token");
  });
});
