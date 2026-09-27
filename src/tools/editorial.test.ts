import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { executeEditorial } from "./editorial.js";
import { getContent, saveContent, updateContent, adoptionStats } from "../storage/local-store.js";
import { loadProfile, updateProfile } from "../modules/profile/creator-profile.js";
import { buildScriptPrompts } from "../modules/writing/script-prompt.js";
import { KOUBO_PACK } from "../modules/packs/koubo.js";
import { claimContent } from "../storage/claims.js";
import { hashClaimToken } from "../storage/claim-token.js";
let dir: string;
const run = (args: Record<string, unknown>) => executeEditorial({ ...args, _dataDir: dir });
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "editorial-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
async function draft() {
  const content = await saveContent({ title: "仓库的一天", body: "先看仓管怎么工作，再讨论工具。", platform: "wechat_mp", status: "draft_ready", tags: [] }, dir);
  const inspected = await run({ action: "inspect", content_id: content.id });
  return { content, args: { action: "feedback", content_id: content.id, draft_hash: inspected.draft_hash, event_id: "event-1", feedback: "结尾停在那个真实场景，不要强行总结", user_confirmed: true } };
}
describe("editorial user feedback", () => {
  it("保留原话和本稿范围，不改正文、不自动当成采纳，重放幂等", async () => {
    const { content, args } = await draft();
    expect(await run(args)).toMatchObject({ ok: true, receipt: { scope: "draft", state: "applied" }, next_action: { params: { content_id: content.id, force: true } } });
    expect(await run(args)).toMatchObject({ ok: true, replayed: true });
    const saved = await getContent(content.id, dir);
    expect(saved?.body).toBe(content.body);
    expect(saved?.adoption).toBeUndefined();
    expect(saved?.writingFeedback).toHaveLength(1);
    expect(saved?.writingFeedback?.[0].instruction).toBe(args.feedback);
    expect(await loadProfile(dir)).toBeNull();
    expect(await run({ ...args, feedback: "改了事件内容" })).toMatchObject({ ok: false });
  });
  it("用户明确长期平台偏好进入实际写作规则，重复平台规则不自动升格", async () => {
    const { args } = await draft();
    await run({ ...args, scope: "platform", platform: "wechat_mp" });
    await run({ ...args, event_id: "event-2", scope: "platform", platform: "douyin" });
    const p = await loadProfile(dir);
    expect(p?.writingRules.map(r => r.scope)).toEqual(["platform:wechat_mp", "platform:douyin"]);
    expect(buildScriptPrompts(KOUBO_PACK, p, { topic: "库存", platform: "wechat_mp" }).system).toContain(args.feedback);
    expect(buildScriptPrompts(KOUBO_PACK, p, { topic: "库存", platform: "bilibili" }).system).not.toContain(args.feedback);
  });
  it("新稿不能继承旧稿的认可；当前稿明确否决留痕并计入未采纳", async () => {
    const { content, args } = await draft();
    expect(await run({ ...args, verdict: "adopted" })).toMatchObject({ ok: true });
    expect((await getContent(content.id, dir))?.adoption?.verdict).toBe("adopted");
    await updateContent(content.id, { body: "后来改成了另一版。" }, dir);
    expect(await run({ ...args, event_id: "event-2", verdict: "adopted" })).toMatchObject({ ok: false, status: "stale_draft" });
    const current = await run({ action: "inspect", content_id: content.id });
    await run({ ...args, draft_hash: current.draft_hash, event_id: "event-3", verdict: "rejected", feedback: "这一版不满意" });
    expect((await getContent(content.id, dir))?.adoption?.verdict).toBe("rejected");
    expect(await adoptionStats(dir)).toMatchObject({ judged: 1, adopted: 0, rate: 0 });
    expect(await run({ action: "inspect", content_id: content.id })).toMatchObject({ feedback: [expect.objectContaining({ verdict: "adopted" }), expect.objectContaining({ verdict: "rejected" })] });
  });
  it("未确认或非法范围不落盘；不同事件并发保留两条反馈", async () => {
    const { content, args } = await draft();
    expect(await run({ ...args, user_confirmed: false })).toMatchObject({ ok: false });
    expect(await run({ ...args, scope: "platform" })).toMatchObject({ ok: false });
    expect(await run({ ...args, scope: "global" })).toMatchObject({ ok: false });
    await Promise.all([run(args), run({ ...args, event_id: "event-2", feedback: "开头从具体场景讲起" })]);
    expect((await getContent(content.id, dir))?.writingFeedback).toHaveLength(2);
  });
  it("pending事件在重试时恢复，不重复反馈", async () => {
    const { content, args } = await draft();
    await run(args);
    const file = path.join(dir, "editorial-feedback/event-1.json");
    const receipt = JSON.parse(await fs.readFile(file, "utf8"));
    receipt.state = "pending";
    await fs.writeFile(file, JSON.stringify(receipt));
    expect(await run(args)).toMatchObject({ ok: true, receipt: { state: "applied" } });
    expect((await getContent(content.id, dir))?.writingFeedback).toHaveLength(1);
  });
});
describe("editorial profile calibration", () => {
  it("明确确认画像才可作为受众审稿标准；其他更新保留画像和无关数据", async () => {
    const persona = { core: { name: "仓管", coreAnxiety: "缺货" } };
    await updateProfile({ competitorAccounts: [{ name: "保留", platform: "douyin", profileUrl: "https://example.com", addedAt: "now" }] }, dir);
    await run({ action: "update_profile", profile: { audiencePersona: persona }, user_confirmed: true });
    expect((await loadProfile(dir))?.audiencePersona?.calibratedAt).toBeUndefined();
    await run({ action: "update_profile", profile: { audiencePersona: persona }, user_confirmed: true, confirm_audience: true });
    const at = (await loadProfile(dir))?.audiencePersona?.calibratedAt;
    expect(at).toBeTruthy();
    await run({ action: "update_profile", profile: { expressionPersona: "具体，平实" }, user_confirmed: true });
    expect((await loadProfile(dir))?.audiencePersona?.calibratedAt).toBe(at);
    expect((await loadProfile(dir))?.competitorAccounts).toHaveLength(1);
    await run({ action: "update_profile", profile: { audiencePersona: { core: { name: "经理" } } }, user_confirmed: true });
    expect((await loadProfile(dir))?.audiencePersona?.calibratedAt).toBeUndefined();
  });
  it("损坏档案不会被默认空档案覆盖", async () => {
    const file = path.join(dir, "creator-profile.json");
    await fs.writeFile(file, "broken");
    expect(await run({ action: "update_profile", profile: { industry: "零售" }, user_confirmed: true })).toMatchObject({ ok: false });
    expect(await fs.readFile(file, "utf8")).toBe("broken");
  });
});

it("局部更新长期篇幅不删除已有时长与内容深度", async () => {
  await updateProfile({ contentFormat: { videoLength: "3分钟", contentDepth: "具体复盘", wordCount: "1500" } }, dir);
  await run({ action: "update_profile", profile: { contentFormat: { wordCount: "2000" } }, user_confirmed: true });
  expect((await loadProfile(dir))?.contentFormat).toEqual({ videoLength: "3分钟", contentDepth: "具体复盘", wordCount: "2000" });
});

it("段落反馈保留原选区，不能自动推广到全文或长期规则", async () => {
  const { content, args } = await draft();
  expect(await run({ ...args, selection: "正文没有这句" })).toMatchObject({ ok: false });
  expect(await run({ ...args, selection: "先看仓管怎么工作", scope: "voice" })).toMatchObject({ ok: false });
  expect(await run({ ...args, selection: "先看仓管怎么工作" })).toMatchObject({ ok: true });
  expect((await getContent(content.id, dir))?.writingFeedback).toEqual([expect.objectContaining({ scope: "selection", selection: "先看仓管怎么工作" })]);
});

describe("写门（P6 §3.8）", () => {
  it("同宿主另一个会话不带令牌记反馈被拒并看见持有者，回执与稿件都不动；inspect 只读不设卡", async () => {
    const { content, args } = await draft();
    const claimed = await claimContent(content.id, "writer", "claude", dir);
    if (!claimed.ok) throw new Error(claimed.error);
    expect(await run({ ...args, _host: "claude" })).toMatchObject({ ok: false, code: "claim_held", holder: { host: "claude", employee: "writer" } });
    expect((await getContent(content.id, dir))?.writingFeedback ?? []).toHaveLength(0);
    expect(await run({ action: "inspect", content_id: content.id, _host: "claude" })).toMatchObject({ ok: true, feedback: [] });
  });
  it("带着令牌记反馈照常落盘，回执交回同一枚令牌", async () => {
    const { content, args } = await draft();
    const claimed = await claimContent(content.id, "writer", "claude", dir);
    if (!claimed.ok) throw new Error(claimed.error);
    const recorded = await run({ ...args, _host: "claude", claim_token: claimed.claim.token });
    expect(recorded).toMatchObject({ ok: true, status: "recorded", claim_token: claimed.claim.token });
    expect((await getContent(content.id, dir))?.writingFeedback).toHaveLength(1);
  });
  it("工作台 local-user 越过宿主认领照记反馈，越门记 override 账，不拿走也不改宿主的令牌", async () => {
    const { content, args } = await draft();
    const claimed = await claimContent(content.id, "writer", "claude", dir);
    if (!claimed.ok) throw new Error(claimed.error);
    const recorded = await run(args);
    expect(recorded).toMatchObject({ ok: true, status: "recorded" });
    expect(recorded).not.toHaveProperty("claim_token");
    const saved = await getContent(content.id, dir);
    expect(saved?.writingFeedback).toHaveLength(1);
    expect(saved?.claim).toMatchObject({ host: "claude", token: hashClaimToken(claimed.claim.token) });
    expect(saved?.handoffs).toEqual([expect.objectContaining({ from: "claude", to: "local-user", override: true })]);
  });
});
