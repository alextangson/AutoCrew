/** v1.3 M2：说明变短后，漏了流程守则的调用由工具返回拦住——报错 + next_action 指向正确动作 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMcpRequest } from "./server.js";
import { saveContent, saveTopic } from "../src/storage/local-store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "misuse-"));
const access = { principal: { subject: "workbuddy", plan: "local" as const }, host: "workbuddy" };
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, access, dir);
  return (r!.result as { structuredContent: Record<string, unknown> }).structuredContent;
};
let topicId = "";
let contentId = "";
beforeAll(async () => {
  topicId = (await saveTopic({ title: "t", description: "d", tags: [] }, dir)).id;
  contentId = (await saveContent({ title: "x", body: "", platform: "douyin", topicId, status: "drafting" } as never, dir)).id;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("M2 漏了步骤 → 报错 + next_action 指向正确动作", () => {
  it.each([
    ["writer submit 没领包", "autocrew_writer", () => ({ action: "submit", content_id: contentId, body: "正文", title: "x" }), "autocrew_writer", "pack"],
    ["review_desk submit 没写完稿", "autocrew_review_desk", () => ({ action: "submit", content_id: contentId, review_pack_id: "nope", attempt: 1, issues: [] }), "autocrew_writer", "pack"],
    ["select_angle 还没有简报", "autocrew_workflow", () => ({ action: "select_angle", topic_id: topicId, angle_id: "angle-1" }), "autocrew_workflow", "prepare"],
    ["scout 没带 task_id", "autocrew_scout", () => ({ action: "perspective", topic_id: topicId, payload: {} }), "autocrew_scout", "prepare"],
    ["scout read_page 没带 perspective", "autocrew_scout", () => ({ action: "read_page", topic_id: topicId, task_id: "x", url: "https://example.com" }), "autocrew_scout", undefined],
    ["content save 直接存 AI 新稿", "autocrew_content", () => ({ action: "save", title: "新稿", body: "AI 写的", platform: "douyin" }), "autocrew_workflow", undefined],
    ["writer pack 没调研", "autocrew_writer", () => ({ action: "pack", topic_id: topicId, platform: "douyin" }), "autocrew_workflow", "prepare"],
    ["editorial feedback 没确认", "autocrew_editorial", () => ({ action: "feedback", content_id: contentId, draft_hash: "h", event_id: "e1", feedback: "改短" }), "autocrew_editorial", undefined],
    ["video register 参数不全", "autocrew_video", () => ({ action: "register", content_id: contentId }), "autocrew_video", "status"],
    ["公众号发布没过检查", "autocrew_publish", () => ({ action: "wechat_mp_draft", content_id: contentId }), "autocrew_pre_publish", "check"],
  ])("%s", async (_label, tool, args, nextTool, nextAction) => {
    const r = await call(tool, args());
    expect(r.ok).toBe(false);
    const next = r.next_action as { tool?: string; params?: { action?: string } };
    expect(next?.tool).toBe(nextTool);
    if (nextAction) expect(next.params?.action).toBe(nextAction);
  });
});
