/**
 * generate.test.ts — autocrew_generate 工具单测，全 mock，零网络
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { executeGenerate } from "./generate.js";
import type { GeneratedScript } from "../modules/writing/generate-script.js";

// ─── Mock factory ──────────────────────────────────────────────────────────────

const GOOD_RESULT: GeneratedScript = {
  contentId: "content-test-001",
  title: "AI时代最值得练的一个技能",
  body: "钩子正文CTA组装后的文本",
  hashtags: ["#AI技能", "#普通人逆袭"],
  violations: [],
  tokensUsed: 350,
};

function makeGenerateImpl(result: GeneratedScript | Error) {
  return async (): Promise<GeneratedScript> => {
    if (result instanceof Error) throw result;
    return result;
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("executeGenerate", () => {
  // 1. Success path — data shape correct
  it("success: returns ok:true with correct data shape", async () => {
    const res = await executeGenerate(
      { action: "script", topic: "AI时代普通人最该练的技能", platform: "douyin" },
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
      { action: "script", topic: "AI技能", platform: "douyin" },
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
      { action: "script", topic: "AI技能", platform: "douyin" },
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
      { action: "script", topic: "AI技能", platform: "douyin", research: "参考资料..." },
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
      { action: "script", topic: "AI技能", platform: "douyin", topic_id: "topic-42" },
      { generateScriptImpl: impl as Parameters<typeof executeGenerate>[1]["generateScriptImpl"] },
    );

    expect(capturedReq).not.toBeNull();
    expect((capturedReq as Record<string, unknown>).topicId).toBe("topic-42");
  });

  // 10. 不带 topic_id / 空串 → topicId 不设值，行为与改动前一致（口径同桌面 IPC）
  it("absent or empty topic_id → topicId stays undefined", async () => {
    const seen: Record<string, unknown>[] = [];
    const impl = async (req: Record<string, unknown>): Promise<GeneratedScript> => {
      seen.push(req);
      return GOOD_RESULT;
    };
    const deps = {
      generateScriptImpl: impl as Parameters<typeof executeGenerate>[1]["generateScriptImpl"],
    };

    await executeGenerate({ action: "script", topic: "AI技能", platform: "douyin" }, deps);
    await executeGenerate(
      { action: "script", topic: "AI技能", platform: "douyin", topic_id: "" },
      deps,
    );

    expect(seen).toHaveLength(2);
    expect(seen[0].topicId).toBeUndefined();
    expect(seen[1].topicId).toBeUndefined();
  });
});

describe("knowledge dedupe", () => {
  // 检索已下沉到生成管线(generate-script.ts runGeneration,那边的测试覆盖注入)。
  // 这里守住去重:入口层不再自行检索,否则 MCP 路径知识块双份注入。
  it("does not retrieve knowledge at the tool layer — research passes through untouched", async () => {
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-gen-knowledge-"));
    await fs.mkdir(path.join(testDir, "knowledge"), { recursive: true });
    await fs.writeFile(path.join(testDir, "knowledge", "agent.md"), "工具调用循环是 Agent 的核心。");

    let capturedReq: Record<string, unknown> | null = null;
    const generateScriptImpl = async (req: Record<string, unknown>) => {
      capturedReq = req;
      return { contentId: "c1", title: "t", body: "b", hashtags: [], violations: [], tokensUsed: 1 };
    };

    await executeGenerate(
      { action: "script", topic: "Agent 工具调用", platform: "douyin", research: "用户给的资料", _dataDir: testDir },
      { generateScriptImpl } as never,
    );

    expect(capturedReq).not.toBeNull();
    expect((capturedReq as { research?: string }).research).toBe("用户给的资料");
    await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});
