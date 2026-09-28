/**
 * spec 2026-09-28 §3 D「生效规则统一读取」：待批 / 丢弃 / 停用的规则不进任何写作路径——
 * 初稿、整稿修订、选区修订、选区改写（按目标稿件平台）、画像生成都走 rulesForPlatform。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addWritingRule, decideWritingRule, loadProfile, saveProfile, updateProfile } from "./creator-profile.js";
import { addApprovedRuleForTest } from "./rule-fixtures.js";
import { generateAudiencePersonaProposal } from "./persona.js";
import { saveContent } from "../../storage/local-store.js";
import { buildScriptPrompts } from "../writing/script-prompt.js";
import { KOUBO_PACK } from "../packs/koubo.js";
import { reviseDraft } from "../writing/draft-revision.js";
import { reviseFocus } from "../writing/revise-focus.js";
import { rewriteSelection } from "../writing/selection-rewrite.js";
import { openaiSseResponse, bodyText } from "../../engine/sse-fixtures.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult, runLoop } from "../../engine/loop.js";

let dir: string;
const ACTIVE_CORE = "生效的内核规则：句子要短";
const ACTIVE_WECHAT = "生效的公众号规则：空行分段";
const ACTIVE_DOUYIN = "生效的抖音规则：开头三秒给结论";
const PENDING = "待批规则：不许进写作";
const REJECTED = "丢弃规则：不许进写作";
const LEGACY_DISABLED = "存量停用规则：不许复活";
const FORBIDDEN = [PENDING, REJECTED, LEGACY_DISABLED];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pending-rules-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "test-key", baseUrl: "https://fake.local" }));
  const now = new Date().toISOString();
  // 存量档案：没有 status 的停用规则（这次清理停用的 7 条就是这个形状）
  await saveProfile({
    industry: "AI 实操", platforms: ["wechat_mp", "douyin"], audiencePersona: null,
    writingRules: [{ rule: LEGACY_DISABLED, source: "calibrated", confidence: 1, disabled: true, createdAt: now }],
    styleBoundaries: { never: [], always: [] }, competitorAccounts: [], performanceHistory: [], styleCalibrated: true, createdAt: now, updatedAt: now,
  }, dir);
  await addApprovedRuleForTest({ rule: ACTIVE_CORE, source: "user_explicit", confidence: 1 }, dir);
  await addApprovedRuleForTest({ rule: ACTIVE_WECHAT, source: "user_explicit", confidence: 1, scope: "platform:wechat_mp" }, dir);
  await addApprovedRuleForTest({ rule: ACTIVE_DOUYIN, source: "user_explicit", confidence: 1, scope: "platform:douyin" }, dir);
  await addWritingRule({ rule: PENDING, source: "auto_distilled", confidence: 0.9, evidence: ["改稿 A → B"] }, dir);
  const withRejected = await addWritingRule({ rule: REJECTED, source: "auto_distilled", confidence: 0.9 }, dir);
  const r = withRejected.writingRules.find((x) => x.rule === REJECTED)!;
  await decideWritingRule({ ruleId: r.id!, revision: r.revision!, decision: "rejected", eventId: "founder-reject-1" }, dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function expectOnlyActive(prompt: string, platform: "wechat_mp" | "douyin" | null) {
  for (const text of FORBIDDEN) expect(prompt).not.toContain(text);
  expect(prompt).toContain(ACTIVE_CORE);
  if (platform === "wechat_mp") { expect(prompt).toContain(ACTIVE_WECHAT); expect(prompt).not.toContain(ACTIVE_DOUYIN); }
  if (platform === "douyin") { expect(prompt).toContain(ACTIVE_DOUYIN); expect(prompt).not.toContain(ACTIVE_WECHAT); }
}

const done = (): LoopResult => ({ finalMessage: "done", turns: 2, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" });

describe("pending / rejected / legacy-disabled rules never reach a writing path", () => {
  it("the legacy disabled rule stays disabled after the profile was rewritten by new code", async () => {
    const profile = (await loadProfile(dir))!;
    const legacy = profile.writingRules.find((x) => x.rule === LEGACY_DISABLED)!;
    expect(legacy.disabled).toBe(true);
    expect(legacy.status).toBeUndefined();
  });

  it("initial draft prompts (buildScriptPrompts)", async () => {
    const profile = await loadProfile(dir);
    expectOnlyActive(buildScriptPrompts(KOUBO_PACK, profile, { topic: "库存", platform: "douyin" }).system, "douyin");
  });

  it("whole-draft revision (reviseDraft)", async () => {
    const c = await saveContent({ title: "标题", body: "原正文", platform: "wechat_mp", status: "draft_ready", tags: [] }, dir);
    let system = "";
    const runLoopImpl = async (_c: EngineConfig, o: LoopOptions): Promise<LoopResult> => {
      system = o.systemPrompt ?? "";
      await o.tools!.find((t) => t.name === "submit_revision")!.execute({ title: "标题", body: "改过的正文" });
      return done();
    };
    await reviseDraft(c.id, "口语一点", dir, { runLoopImpl });
    expectOnlyActive(system, "wechat_mp");
  });

  it("focused revision (reviseFocus)", async () => {
    const c = await saveContent({ title: "标题", body: "第一段。\n\n第二段。", platform: "douyin", status: "draft_ready", tags: [] }, dir);
    let system = "";
    const runLoopImpl = async (_c: EngineConfig, o: LoopOptions): Promise<LoopResult> => {
      system = o.systemPrompt ?? "";
      await o.tools!.find((t) => t.name === "submit_revision")!.execute({ title: "标题", body: "改过。" });
      return done();
    };
    await reviseFocus(c.id, "口语一点", { scope: "draft" }, dir, { runLoopImpl });
    expectOnlyActive(system, "douyin");
  });

  it("selection rewrite takes the platform from the target content", async () => {
    const c = await saveContent({ title: "标题", body: "第一段。需要改的句子。", platform: "wechat_mp", status: "draft_ready", tags: [] }, dir);
    let system = "";
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const messages = (JSON.parse(bodyText(init as { body?: unknown })) as { messages: Array<{ role: string; content: string }> }).messages;
      system = messages.find((m) => m.role === "system")?.content ?? "";
      return openaiSseResponse({ choices: [{ message: { content: "改好了。" } }], usage: { total_tokens: 5 } });
    }) as typeof fetch;
    const res = await rewriteSelection({ contentId: c.id, body: c.body, selection: "需要改的句子。", instruction: "口语一点" }, dir, fetchImpl);
    expect(res.ok).toBe(true);
    expectOnlyActive(system, "wechat_mp");
    // 不知道目标稿件时只给声音内核，不把所有平台的规则都注进去
    await rewriteSelection({ body: c.body, selection: "需要改的句子。", instruction: "口语一点" }, dir, fetchImpl);
    expectOnlyActive(system, null);
    expect(system).not.toContain(ACTIVE_WECHAT);
    expect(system).not.toContain(ACTIVE_DOUYIN);
  });

  it("audience persona generation", async () => {
    await updateProfile({ industry: "AI 实操" }, dir);
    let prompt = "";
    const runLoopImpl = (async (_c: unknown, o: { systemPrompt?: string; userMessage?: string; tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> }) => {
      prompt = `${o.systemPrompt ?? ""}\n${o.userMessage ?? ""}`;
      await o.tools.find((t) => t.name === "submit_persona")!.execute({
        core: { name: "小林", coreAnxiety: "怕被替代", painPoints: ["不会用"] }, basis: "x",
      });
      return { stopReason: "tool", turns: 1, totalTokens: 1, finalText: "" };
    }) as unknown as typeof runLoop;
    await generateAudiencePersonaProposal(dir, { runLoopImpl });
    for (const text of FORBIDDEN) expect(prompt).not.toContain(text);
    expect(prompt).toContain(ACTIVE_CORE);
  });
});
