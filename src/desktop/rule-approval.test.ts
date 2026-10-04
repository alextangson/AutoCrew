/**
 * spec 2026-09-28 §3 D（P1）：只有创始人能批规则。
 * 模型带着 user_confirmed:true、source:user_explicit、「用户原话」走每一个现有入口，都不能让 pending 规则生效；
 * 唯一的生效入口是浏览器会话 + 同源的 /api/rules/decision，绑定 rule id + revision + 决定，按 eventId 幂等。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { createRuleApprovalHandler } from "./rule-approval.js";
import { LocalSessionAuth, SESSION_COOKIE } from "./server-auth.js";
import { buildIpcHandlers } from "./ipc.js";
import { buildChatTools, type ChatCard } from "./chat-router.js";
import { addWritingRule, loadProfile, rulesForPlatform, ruleStatus, updateProfile, updateWritingRule, type WritingRule } from "../modules/profile/creator-profile.js";
import { executeEditorial } from "../tools/editorial.js";
import { saveContent } from "../storage/local-store.js";
import { draftHash } from "../storage/draft-hash.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

const PENDING = "开头先说结论，不要铺垫";
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-rule-approval-"));
  await updateProfile({ industry: "AI 实操", platforms: ["douyin"] }, dir);
  await addWritingRule({ rule: PENDING, source: "auto_distilled", confidence: 0.9, evidence: ["改稿 c1：铺垫 → 结论"] }, dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function pendingRule(): Promise<WritingRule> {
  return (await loadProfile(dir))!.writingRules.find((r) => r.rule === PENDING)!;
}
async function expectStillPending(): Promise<void> {
  const profile = (await loadProfile(dir))!;
  expect(profile.writingRules.filter((r) => r.rule === PENDING).map(ruleStatus)).toEqual(["pending"]);
  expect(rulesForPlatform(profile, "douyin").map((r) => r.rule)).not.toContain(PENDING);
  expect(rulesForPlatform(profile, null).map((r) => r.rule)).not.toContain(PENDING);
}

describe("a model cannot activate a pending rule through any existing entry", () => {
  it("MCP editorial feedback with user_confirmed:true and long-term scope only (re)records a pending proposal", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "稿", body: "正文。", platform: "douyin", status: "draft_ready", tags: [] }, dir);
    for (const [i, scope] of (["voice", "platform"] as const).entries()) {
      const res = await executeEditorial({
        _dataDir: dir, action: "feedback", content_id: c.id, draft_hash: draftHash(c), event_id: `model-${i}`,
        feedback: PENDING, scope, ...(scope === "platform" ? { platform: "douyin" } : {}), user_confirmed: true,
      });
      expect(res).toMatchObject({ ok: true, long_term_rule: { status: "pending" } });
    }
    const profile = (await loadProfile(dir))!;
    expect(profile.writingRules.every((r) => ruleStatus(r) !== "active")).toBe(true);
    await expectStillPending();
  });

  it("MCP editorial update_profile cannot carry writingRules at all", async () => {
    const r = await pendingRule();
    const res = await executeEditorial({
      _dataDir: dir, action: "update_profile", user_confirmed: true,
      profile: { writingRules: [{ ...r, status: "active", disabled: false }] },
    });
    expect(res).toMatchObject({ ok: false });
    await expectStillPending();
  });

  it("chat add_style_rule with the user's words stays pending and says so", async () => {
    const sink: ChatCard[] = [];
    const tool = buildChatTools(sink, dir).find((t) => t.name === "add_style_rule")!;
    const out = JSON.parse(await tool.execute({ rule: PENDING, user_confirmed: true, status: "active" }) as string);
    expect(out).toMatchObject({ ok: true, status: "pending" });
    await expectStillPending();
    const fresh = JSON.parse(await tool.execute({ rule: "另一条用户在对话里说的偏好" }) as string);
    expect(fresh.status).toBe("pending");
    const profile = (await loadProfile(dir))!;
    expect(rulesForPlatform(profile, null)).toHaveLength(0);
  });

  it("IPC style:update_rule (reachable with a bearer via /api/invoke) cannot activate: enable → pending, edit → pending", async () => {
    const handlers = buildIpcHandlers();
    let r = await pendingRule();
    const disabled = await handlers["style:update_rule"]({ _dataDir: dir, rule_id: r.id, revision: r.revision, disabled: true });
    expect(disabled.ok).toBe(true);
    r = (await loadProfile(dir))!.writingRules.find((x) => x.id === r.id)!;
    const reenable = await handlers["style:update_rule"]({ _dataDir: dir, rule_id: r.id, revision: r.revision, disabled: false, user_confirmed: true, status: "active" });
    expect(reenable.ok).toBe(true);
    await expectStillPending();
    r = await pendingRule();
    await handlers["style:update_rule"]({ _dataDir: dir, rule_id: r.id, revision: r.revision, rule: `${PENDING}（改）`, user_confirmed: true });
    const edited = (await loadProfile(dir))!.writingRules.find((x) => x.id === r.id)!;
    expect(ruleStatus(edited)).toBe("pending");
    expect(await handlers["style:update_rule"]({ _dataDir: dir, index: 0, disabled: false })).toMatchObject({ ok: false });
  });

  it("no IPC channel is an approval channel", () => {
    const channels = Object.keys(buildIpcHandlers());
    expect(channels.filter((c) => /approv|decid|activate/i.test(c) && c.startsWith("style:"))).toEqual([]);
  });
});

// ─── 工作台路由 ───────────────────────────────────────────────────────────────

async function withServer(auth: "session" | "bearer" | null | LocalSessionAuth, originOk: boolean, fn: (url: string) => Promise<void>): Promise<void> {
  const handler = createRuleApprovalHandler({
    authorize: (req) => auth instanceof LocalSessionAuth
      ? auth.authenticate({ authorization: req.headers.authorization, cookie: req.headers.cookie })
      : auth,
    originAllowed: (req) => auth instanceof LocalSessionAuth ? auth.originAllowed(req.headers.origin as string | undefined) : originOk,
    resolveDataDir: async () => dir,
    readBody: (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); }),
  });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rules/decision`); } finally { server.close(); }
}
const ORIGIN = "http://127.0.0.1:4317";
const postAs = (url: string, body: unknown, headers: Record<string, string>) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("founder workbench decision route", () => {
  it("rejects bearer credentials and cross-origin sessions, even with user_confirmed in the body", async () => {
    const r = await pendingRule();
    const body = { ruleId: r.id, revision: r.revision, decision: "active", eventId: "evt-12345678", user_confirmed: true };
    await withServer("bearer", true, async (url) => { expect((await post(url, body)).status).toBe(403); });
    await withServer("session", false, async (url) => { expect((await post(url, body)).status).toBe(403); });
    await withServer(null, true, async (url) => { expect((await post(url, body)).status).toBe(403); });
    await expectStillPending();
  });

  it("activates only with a matching revision, idempotent per eventId, and conflicting reuse of an eventId is refused", async () => {
    const r = await pendingRule();
    await withServer("session", true, async (url) => {
      expect((await post(url, { ruleId: r.id, revision: r.revision! + 1, decision: "active", eventId: "evt-stale-001" })).status).toBe(409);
      await expectStillPending();
      const ok = await post(url, { ruleId: r.id, revision: r.revision, decision: "active", eventId: "evt-founder-01" });
      expect(ok.status).toBe(200);
      const afterFirst = (await loadProfile(dir))!.writingRules.find((x) => x.id === r.id)!;
      expect(ruleStatus(afterFirst)).toBe("active");
      const replay = await post(url, { ruleId: r.id, revision: r.revision, decision: "active", eventId: "evt-founder-01" });
      expect(replay.status).toBe(200);
      expect((await loadProfile(dir))!.writingRules.find((x) => x.id === r.id)!.revision).toBe(afterFirst.revision);
      const conflict = await post(url, { ruleId: r.id, revision: r.revision, decision: "disabled", eventId: "evt-founder-01" });
      expect(conflict.status).toBe(409);
    });
    expect(rulesForPlatform((await loadProfile(dir))!, "douyin").map((x) => x.rule)).toContain(PENDING);
  });

  it("reject leaves a tombstone that blocks the same rule from being proposed again", async () => {
    const r = await pendingRule();
    await withServer("session", true, async (url) => {
      expect((await post(url, { ruleId: r.id, revision: r.revision, decision: "rejected", eventId: "evt-reject-01" })).status).toBe(200);
    });
    const again = await addWritingRule({ rule: PENDING, source: "auto_distilled", confidence: 0.95 }, dir);
    expect(again.lastRuleOutcome).toBe("blocked_by_tombstone");
    expect(again.writingRules.filter((x) => x.rule === PENDING)).toHaveLength(1);
  });

  it("approving a promotion proposal makes it global and retires the platform original", async () => {
    await withServer("session", true, async (url) => {
      const base = await addWritingRule({ rule: "结尾不上价值", source: "auto_distilled", confidence: 0.8, scope: "platform:wechat_mp" }, dir);
      const original = base.writingRules.find((x) => x.rule === "结尾不上价值")!;
      await post(url, { ruleId: original.id, revision: original.revision, decision: "active", eventId: "evt-orig-0001" });
      const proposed = await addWritingRule({ rule: "结尾不上价值", source: "auto_distilled", confidence: 0.8, scope: "platform:douyin" }, dir);
      expect(proposed.lastRuleOutcome).toBe("promotion_proposed");
      const proposal = proposed.writingRules.find((x) => x.promotes === original.id)!;
      // 提案待批期间：原平台规则照常生效，抖音拿不到
      expect(rulesForPlatform(proposed, "wechat_mp").map((x) => x.rule)).toContain("结尾不上价值");
      expect(rulesForPlatform(proposed, "douyin").map((x) => x.rule)).not.toContain("结尾不上价值");
      expect((await post(url, { ruleId: proposal.id, revision: proposal.revision, decision: "active", eventId: "evt-promo-001" })).status).toBe(200);
    });
    const profile = (await loadProfile(dir))!;
    const texts = profile.writingRules.filter((x) => x.rule === "结尾不上价值");
    expect(texts.map((x) => [x.scope, ruleStatus(x)])).toEqual([["platform:wechat_mp", "disabled"], ["voice_core", "active"]]);
    expect(rulesForPlatform(profile, "douyin").filter((x) => x.rule === "结尾不上价值")).toHaveLength(1);
  });
});

describe("founder workbench route with the real session auth", () => {
  it("a holder of the automation server-token cannot forge a workbench session cookie; only a browser-issued session approves", async () => {
    const SERVER_TOKEN = "automation-server-token-given-to-mcp-forwarder";
    const auth = new LocalSessionAuth("one-time-boot", new Set([ORIGIN]), undefined, undefined, SERVER_TOKEN, undefined, "separate-session-secret");
    const r = await pendingRule();
    const body = { ruleId: r.id, revision: r.revision, decision: "active", eventId: "evt-forged-01" };
    // 攻击者只有 server-token：按会话格式用它签一个 cookie
    const payload = `${"a".repeat(64)}.${Date.now() + 3_600_000}`;
    const forged = `${payload}.${createHmac("sha256", SERVER_TOKEN).update(payload).digest("base64url")}`;
    await withServer(auth, true, async (url) => {
      expect((await postAs(url, body, { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(forged)}` })).status).toBe(403);
      expect((await postAs(url, body, { Authorization: `Bearer ${SERVER_TOKEN}` })).status).toBe(403);
    });
    await expectStillPending();
    const session = auth.issueSession("one-time-boot")!;
    await withServer(auth, true, async (url) => {
      expect((await postAs(url, { ...body, eventId: "evt-browser-01" }, { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(session.sessionId)}` })).status).toBe(200);
    });
    expect(ruleStatus((await pendingRule()))).toBe("active");
  });
});

describe("stale promotion proposals (Codex round 2 P2)", () => {
  it("approving a proposal after the original platform rule was edited and re-approved is refused and disables nothing", async () => {
    await withServer("session", true, async (url) => {
      const base = await addWritingRule({ rule: "结尾不上价值", source: "auto_distilled", confidence: 0.8, scope: "platform:wechat_mp" }, dir);
      let original = base.writingRules.find((x) => x.rule === "结尾不上价值")!;
      await post(url, { ruleId: original.id, revision: original.revision, decision: "active", eventId: "evt-orig-0001" });
      const proposed = await addWritingRule({ rule: "结尾不上价值", source: "auto_distilled", confidence: 0.8, scope: "platform:douyin" }, dir);
      const proposal = proposed.writingRules.find((x) => x.promotes)!;
      // 创始人改了原平台规则并重新批准
      original = (await loadProfile(dir))!.writingRules.find((x) => x.id === original.id)!;
      const edited = await updateWritingRule({ id: original.id!, revision: original.revision! }, { rule: "公众号结尾给一个能照做的动作" }, dir);
      original = edited.writingRules.find((x) => x.id === original.id)!;
      expect((await post(url, { ruleId: original.id, revision: original.revision, decision: "active", eventId: "evt-reapprove1" })).status).toBe(200);
      const res = await post(url, { ruleId: proposal.id, revision: proposal.revision, decision: "active", eventId: "evt-stale-promo" });
      expect(res.status).toBe(409);
    });
    const profile = (await loadProfile(dir))!;
    const edited = profile.writingRules.find((x) => x.rule === "公众号结尾给一个能照做的动作")!;
    expect(ruleStatus(edited)).toBe("active");
    expect(ruleStatus(profile.writingRules.find((x) => x.promotes)!)).toBe("pending");
  });
});

describe("a completed promotion is an ordinary global rule afterwards (Codex round 3 P2)", () => {
  it("disable → re-enable and edit → re-approve of the promoted rule both work and never touch the platform original again", async () => {
    await withServer("session", true, async (url) => {
      const base = await addWritingRule({ rule: "结尾不上价值", source: "auto_distilled", confidence: 0.8, scope: "platform:wechat_mp" }, dir);
      const original = base.writingRules.find((x) => x.rule === "结尾不上价值")!;
      await post(url, { ruleId: original.id, revision: original.revision, decision: "active", eventId: "evt-r3-orig1" });
      const proposed = await addWritingRule({ rule: "结尾不上价值", source: "auto_distilled", confidence: 0.8, scope: "platform:douyin" }, dir);
      let global = proposed.writingRules.find((x) => x.promotes)!;
      expect((await post(url, { ruleId: global.id, revision: global.revision, decision: "active", eventId: "evt-r3-promo" })).status).toBe(200);
      const get = async () => (await loadProfile(dir))!.writingRules.find((x) => x.id === global.id)!;
      global = await get();
      expect((await post(url, { ruleId: global.id, revision: global.revision, decision: "disabled", eventId: "evt-r3-disable" })).status).toBe(200);
      global = await get();
      expect((await post(url, { ruleId: global.id, revision: global.revision, decision: "active", eventId: "evt-r3-enable" })).status).toBe(200);
      global = await get();
      const edited = await updateWritingRule({ id: global.id!, revision: global.revision! }, { rule: "结尾给一个能照做的动作" }, dir);
      global = edited.writingRules.find((x) => x.id === global.id)!;
      expect((await post(url, { ruleId: global.id, revision: global.revision, decision: "active", eventId: "evt-r3-reapprov" })).status).toBe(200);
    });
    const profile = (await loadProfile(dir))!;
    expect(profile.writingRules.map((x) => [x.rule, x.scope, ruleStatus(x)])).toEqual([
      [PENDING, undefined, "pending"],
      ["结尾不上价值", "platform:wechat_mp", "disabled"],
      ["结尾给一个能照做的动作", "voice_core", "active"],
    ]);
  });
});
