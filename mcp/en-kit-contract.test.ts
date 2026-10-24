/**
 * 英文发布包的契约（Phase 3 Codex 审 P2-6）：宿主按 tools/list 公布的 schema 校验参数，
 * x 的 {post_text} 和 youtube 的 {tags, chapters} 必须过得了这一关，不能只在直调函数时能用。
 */
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { handleMcpRequest } from "./server.js";

const access = { principal: { subject: "workbuddy", plan: "local" as const }, host: "workbuddy" };

async function prePublishSchema(): Promise<Record<string, unknown>> {
  const r = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, access);
  const tools = (r!.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
  return tools.find((t) => t.name === "autocrew_pre_publish")!.inputSchema;
}

describe("autocrew_pre_publish video_kit 的公开 schema", () => {
  it("x 只给 post_text、youtube 给 tags/chapters、中文平台的旧形状都能过", async () => {
    const validate = new Ajv({ strict: false }).compile(await prePublishSchema());
    const call = (platform: string, kit: unknown) => validate({ action: "video_kit", content_id: "c1", platform, kit });
    expect(call("x", { post_text: "Max effort is not a free upgrade." }), JSON.stringify(validate.errors)).toBe(true);
    expect(call("youtube", { post_title: "T", caption: "D", tags: ["AI"], chapters: [{ at: "0:00", title: "Intro" }] }), JSON.stringify(validate.errors)).toBe(true);
    expect(call("douyin", { post_title: "标题", caption: "简介", cover_text: "大字", hashtags: ["AI"] }), JSON.stringify(validate.errors)).toBe(true);
  });
});
