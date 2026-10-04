/**
 * generate.test.ts — autocrew_generate 工具单测，全 mock，零网络
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeGenerate } from "./generate.js";
import { founderAuthored } from "../modules/research/angle-gate.test-helper.js";
import type { GeneratedScript } from "../modules/writing/generate-script.js";

// ─── Mock factory ──────────────────────────────────────────────────────────────

const GOOD_RESULT: GeneratedScript = {
  contentId: "content-test-001",
  title: "AI时代最值得练的一个技能",
  body: "钩子正文CTA组装后的文本",
  hashtags: ["#AI技能", "#普通人逆袭"],
  violations: [],
  tokensUsed: 350,
  gateFailures: [],
  rulesApplied: 0,
  wroteWithoutBrief: false,
  wroteWithoutAngle: false,
  review: { status: "passed", rounds: 0, fixed: 0, issues: [], reviewedAt: "2026-09-22T00:00:00.000Z" },
  needsEvidence: false,
  unverifiedNumbers: [],
};

function makeGenerateImpl(result: GeneratedScript | Error) {
  return async (): Promise<GeneratedScript> => {
    if (result instanceof Error) throw result;
    return result;
  };
}

// ─── 选题会：generate 每次都开新稿，测试选题先由创始人定了角度（临时资料库，不碰真实资料） ──

const SLATED = "topic-42";
let slateDir = "";
/** 选题文件 + 创始人已定角度：generate 才放行 */
async function seedSlated(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "topics"), { recursive: true });
  await fs.writeFile(path.join(dir, "topics", `${SLATED}.json`), JSON.stringify({ id: SLATED, title: "AI技能", description: "", tags: [], createdAt: "2026-01-01T00:00:00.000Z" }));
  await founderAuthored(dir, SLATED);
}
beforeEach(async () => {
  slateDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-gen-slate-"));
  await seedSlated(slateDir);
});
afterEach(async () => { await fs.rm(slateDir, { recursive: true, force: true }); });
/** 非宿主直调的参数补上已进片单的选题与临时资料库 */
const slated = <T extends Record<string, unknown>>(p: T) => ({ topic_id: SLATED, _dataDir: slateDir, ...p });

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("executeGenerate", () => {
  it("本次要求与手写角度独立透传，不混入 research", async () => {
    await founderAuthored(slateDir, SLATED, "只讲返工成本"); // 带来的方向要是创始人自定的那句
    let seen: Record<string, unknown> | undefined;
    await executeGenerate(slated({
      action: "script", topic: "AI技能", platform: "douyin", research: "用户的实测材料",
      requirements: "  写给小白；按一天经历展开；不要工具清单。  ", direction: "  只讲返工成本  ",
    }), { generateScriptImpl: async (req) => { seen = { ...req }; return GOOD_RESULT; } });
    expect(seen).toMatchObject({
      requirements: "  写给小白；按一天经历展开；不要工具清单。  ", direction: "  只讲返工成本  ", research: "用户的实测材料",
    });
  });

  // 1. Success path — data shape correct
  it("success: returns ok:true with correct data shape", async () => {
    const res = await executeGenerate(
      slated({ action: "script", topic: "AI时代普通人最该练的技能", platform: "douyin" }),
      { generateScriptImpl: makeGenerateImpl(GOOD_RESULT) },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.contentId).toBe("content-test-001");
    expect(res.data.title).toBe(GOOD_RESULT.title);
    expect(res.data.body).toBe(GOOD_RESULT.body);
    expect(res.data.hashtags).toEqual(GOOD_RESULT.hashtags);
    expect(res.data.violations).toEqual([]);
    expect(res.data.tokensUsed).toBe(350);
  });

  // 2. Missing topic
  it("missing topic → ok:false with actionable error", async () => {
    const res = await executeGenerate(
      { action: "script", platform: "douyin" },
      { generateScriptImpl: makeGenerateImpl(GOOD_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/topic/i);
  });

  // 3. Missing platform
  it("missing platform → ok:false with actionable error", async () => {
    const res = await executeGenerate(
      { action: "script", topic: "AI技能" },
      { generateScriptImpl: makeGenerateImpl(GOOD_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/platform/i);
  });

  // 4. Invalid platform — error message lists the 5 valid values
  it("invalid platform → ok:false, error lists valid platforms", async () => {
    const res = await executeGenerate(
      { action: "script", topic: "AI技能", platform: "twitter" },
      { generateScriptImpl: makeGenerateImpl(GOOD_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Error must list all 5 valid platforms
    expect(res.error).toContain("douyin");
    expect(res.error).toContain("xiaohongshu");
    expect(res.error).toContain("wechat_mp");
    expect(res.error).toContain("wechat_video");
    expect(res.error).toContain("bilibili");
  });

  // 5. Unknown action
  it("unknown action → ok:false", async () => {
    const res = await executeGenerate(
      { action: "video", topic: "AI技能", platform: "douyin" },
      { generateScriptImpl: makeGenerateImpl(GOOD_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/action/i);
  });

  // 6. Engine unconfigured — actionable error passthrough
  it("engine unconfigured → error contains DEEPSEEK_API_KEY hint", async () => {
    const configErr = new Error(
      '引擎未配置 model provider：设置环境变量 DEEPSEEK_API_KEY，或在 ~/.autocrew/engine.json 写入 {"apiKey": "..."}',
    );
    const res = await executeGenerate(
      slated({ action: "script", topic: "AI技能", platform: "douyin" }),
      { generateScriptImpl: makeGenerateImpl(configErr) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("DEEPSEEK_API_KEY");
  });

  // 7. Violations passthrough
  it("violations are passed through in data", async () => {
    const resultWithViolations: GeneratedScript = {
      ...GOOD_RESULT,
      violations: ["翻墙", "某敏感词"],
    };
    const res = await executeGenerate(
      slated({ action: "script", topic: "AI技能", platform: "douyin" }),
      { generateScriptImpl: makeGenerateImpl(resultWithViolations) },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.violations).toEqual(["翻墙", "某敏感词"]);
  });

  // 8. research field is passed through to generateScript
  it("research param is forwarded to generateScript", async () => {
    let capturedReq: Record<string, unknown> | null = null;
    const impl = async (req: Record<string, unknown>): Promise<GeneratedScript> => {
      capturedReq = req;
      return GOOD_RESULT;
    };

    await executeGenerate(
      slated({ action: "script", topic: "AI技能", platform: "douyin", research: "参考资料..." }),
      { generateScriptImpl: impl as Parameters<typeof executeGenerate>[1]["generateScriptImpl"] },
    );

    expect(capturedReq).not.toBeNull();
    expect((capturedReq as Record<string, unknown>).research).toBe("参考资料...");
  });

  // 9. topic_id → ScriptRequest.topicId — 简报注入与选题血缘都挂在它上面
  //    （注入本身在生成管线，MCP 路径含简报块的集成验证见 generate-script-brief.test.ts）
  it("topic_id param is forwarded as ScriptRequest.topicId", async () => {
    let capturedReq: Record<string, unknown> | null = null;
    const impl = async (req: Record<string, unknown>): Promise<GeneratedScript> => {
      capturedReq = req;
      return GOOD_RESULT;
    };

    await executeGenerate(
      slated({ action: "script", topic: "AI技能", platform: "douyin", topic_id: "topic-42" }),
      { generateScriptImpl: impl as Parameters<typeof executeGenerate>[1]["generateScriptImpl"] },
    );

    expect(capturedReq).not.toBeNull();
    expect((capturedReq as Record<string, unknown>).topicId).toBe("topic-42");
  });

  // 10. 不带 topic_id / 空串 → 没有选题的新稿必然不在片单上：结构化拒绝，不进生成
  it("absent or empty topic_id → needs_founder_angle, generateScript never called", async () => {
    const impl = vi.fn(makeGenerateImpl(GOOD_RESULT));
    for (const topic_id of [undefined, "", "   "]) {
      const res = await executeGenerate({ action: "script", topic: "AI技能", platform: "douyin", topic_id, _dataDir: slateDir }, { generateScriptImpl: impl });
      expect(res).toMatchObject({ ok: false, code: "needs_founder_angle", next_action: { skill: "topic-meeting", tool: "autocrew_workflow" } });
    }
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("MCP 默认写作路径纠正", () => {
  const request = {
    action: "script", topic: "门店库存复盘", platform: "douyin", _host: "claude",
    direction: "从一次盘点失败讲起", requirements: "自然叙事，不要工具清单",
    research: "创作者提供的盘点记录与出处", research_mode: "provided",
    research_reason: "沿用用户给的材料", skip_reason: "用户已明确这一稿的方向",
  };
  const continuation = {
    platform: request.platform, direction: request.direction, requirements: request.requirements,
    research: request.research, research_mode: request.research_mode,
    research_reason: request.research_reason, skip_reason: request.skip_reason,
  };

  it("已有选题的纠正下一步完整保留材料、方向和调研选择，不调用引擎", async () => {
    const generateScriptImpl = vi.fn(makeGenerateImpl(GOOD_RESULT));
    const result = await executeGenerate({ ...request, topic_id: "topic-existing" }, { generateScriptImpl });
    expect(result).toMatchObject({
      ok: false, code: "host_writer_default",
      continue_params: { topic_id: "topic-existing", ...continuation },
      next_action: { tool: "autocrew_workflow", params: { action: "prepare", topic_id: "topic-existing", ...continuation } },
    });
    expect(generateScriptImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("无 topic_id（%s）时给可执行的创建选题下一步，并保存后续参数", async (topicId) => {
    const generateScriptImpl = vi.fn(makeGenerateImpl(GOOD_RESULT));
    const result = await executeGenerate({ ...request, topic_id: topicId }, { generateScriptImpl });
    expect(result).toMatchObject({
      ok: false, code: "host_writer_default",
      next_action: { tool: "autocrew_topic", params: { action: "create", title: request.topic, description: request.topic, tags: [] } },
      continue_params: continuation,
      note: expect.stringContaining("topic.id"),
    });
    if (result.ok) throw new Error("应先建立选题");
    expect(result.continue_params).not.toHaveProperty("topic_id");
    expect(generateScriptImpl).not.toHaveBeenCalled();
  });

  it("用户明确后台代写但没选题时，也保留要求、材料及后台执行意图", async () => {
    const generateScriptImpl = vi.fn(makeGenerateImpl(GOOD_RESULT));
    const result = await executeGenerate({ ...request, execution: "engine" }, { generateScriptImpl });
    expect(result).toMatchObject({
      ok: false, code: "topic_required", requested_execution: "engine",
      next_action: { tool: "autocrew_topic", params: { action: "create", title: request.topic } },
      continue_params: continuation,
    });
    expect(generateScriptImpl).not.toHaveBeenCalled();
  });
});

describe("后台代写质量回执", () => {
  async function run(result: GeneratedScript) {
    const response = await executeGenerate(
      slated({ action: "script", topic: "复盘", platform: "douyin" }),
      { generateScriptImpl: makeGenerateImpl(result) },
    );
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }

  it.each([
    { gateFailures: ["max_chars"] },
    { violations: ["需人工处理的词"] },
    { unverifiedNumbers: ["几十个"] },
  ])("审稿 passed 也不能隐藏其他检查残留：%j", async (remaining) => {
    const data = await run({ ...GOOD_RESULT, ...remaining });
    expect(data).toMatchObject({ ...remaining, quality_status: "passed_with_notes", needs_attention: true });
  });

  it("附带完整检查残留和被拦原因，硬门失败始终为 blocked", async () => {
    const data = await run({
      ...GOOD_RESULT, needsEvidence: true, blockedReason: "数字缺证据",
      gateFailures: ["unverified_numbers"], unverifiedNumbers: ["45%"], violations: ["待处理词"],
    });
    expect(data).toMatchObject({
      quality_status: "blocked", needs_attention: true, blockedReason: "数字缺证据",
      gateFailures: ["unverified_numbers"], unverifiedNumbers: ["45%"], violations: ["待处理词"],
    });
  });

  it.each(["passed", "revised"] as const)("审稿 %s 且无任何残留时才返回 passed", async (status) => {
    expect(await run({ ...GOOD_RESULT, review: { ...GOOD_RESULT.review, status } })).toMatchObject({
      quality_status: "passed", needs_attention: false, gateFailures: [], unverifiedNumbers: [],
    });
  });

  it.each(["skipped", "stale", "failed"] as const)("审稿 %s 不能报告质量通过", async (status) => {
    expect(await run({ ...GOOD_RESULT, review: { ...GOOD_RESULT.review, status } })).toMatchObject({
      quality_status: status === "failed" ? "issues_remaining" : "unreviewed", needs_attention: true,
    });
  });

  it("保留审稿建议，意外残留 blocker 时标为 issues_remaining", async () => {
    const issue = { id: "i1", severity: "advisory" as const, quote: "具体片段", rule: "表达可更清楚", instruction: "补充所指" };
    expect(await run({ ...GOOD_RESULT, review: { ...GOOD_RESULT.review, issues: [issue] } })).toMatchObject({
      quality_status: "passed_with_notes", needs_attention: true,
    });
    expect(await run({ ...GOOD_RESULT, review: { ...GOOD_RESULT.review, issues: [{ ...issue, severity: "blocker" }] } })).toMatchObject({
      quality_status: "issues_remaining", needs_attention: true,
    });
  });
});

describe("knowledge dedupe", () => {
  // 检索已下沉到生成管线(generate-script.ts runGeneration,那边的测试覆盖注入)。
  // 这里守住去重:入口层不再自行检索,否则 MCP 路径知识块双份注入。
  it("does not retrieve knowledge at the tool layer — research passes through untouched", async () => {
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-gen-knowledge-"));
    await fs.mkdir(path.join(testDir, "knowledge"), { recursive: true });
    await fs.writeFile(path.join(testDir, "knowledge", "agent.md"), "工具调用循环是 Agent 的核心。");
    await seedSlated(testDir);

    let capturedReq: Record<string, unknown> | null = null;
    const generateScriptImpl = async (req: Record<string, unknown>) => {
      capturedReq = req;
      return { contentId: "c1", title: "t", body: "b", hashtags: [], violations: [], tokensUsed: 1 };
    };

    await executeGenerate(
      { action: "script", topic: "Agent 工具调用", platform: "douyin", research: "用户给的资料", _dataDir: testDir, topic_id: SLATED },
      { generateScriptImpl } as never,
    );

    expect(capturedReq).not.toBeNull();
    expect((capturedReq as { research?: string }).research).toBe("用户给的资料");
    await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

describe("engine entry keeps persisted creative intent", () => {
  it("inherits omitted original requirements rather than clearing them with undefined fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "generate-creative-task-"));
    try {
      const { saveTopic } = await import("../storage/local-store.js");
      const { saveBrief } = await import("../modules/research/brief-store.js");
      const { topicHashOf, upsertJob } = await import("../modules/research/research-job-store.js");
      const topic = await saveTopic({ title: "返工复盘", description: "真实经历", tags: [] }, dir);
      const creativeTask = { version: 1 as const, platform: "douyin", requirements: "  保留完整经历\n不要口号  ", direction: "从失败原因展开" };
      await founderAuthored(dir, topic.id, creativeTask.direction);
      const topicHash = topicHashOf(topic.title, topic.description);
      await saveBrief(topic.id, { schemaVersion: 1, summary: "已有素材", perspectives: [], tensions: [], angleSuggestions: [], angleCards: [], evidence: [], assetPicks: [], missingPerspectives: [], gaps: [], generatedAt: "2026-09-22T00:00:00Z", revision: 1, topicHash, creativeTask }, dir);
      await upsertJob({ topicId: topic.id, topicHash, creativeTask, status: "succeeded", startedAt: "2026-09-22T00:00:00Z", perspectives: [], briefRevision: 1 }, dir);
      const generateScriptImpl = vi.fn(async () => GOOD_RESULT);
      const result = await executeGenerate({ action: "script", topic: topic.title, topic_id: topic.id, platform: "douyin", execution: "engine", _host: "claude_desktop", _dataDir: dir }, { generateScriptImpl });
      expect(result.ok).toBe(true);
      expect(generateScriptImpl).toHaveBeenCalledWith(expect.objectContaining({ requirements: creativeTask.requirements, direction: creativeTask.direction }), dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
