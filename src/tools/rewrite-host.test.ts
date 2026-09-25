import { describe, it, expect, vi } from "vitest";
vi.mock("../modules/writing/platform-adapt-llm.js", () => ({ adaptPlatformLLM: vi.fn(async (title, body, _tags, platform) => ({ title, body, platform, method: "llm" })) }));
import { executeHostRewrite } from "./rewrite.js";
import { adaptPlatformLLM } from "../modules/writing/platform-adapt-llm.js";
describe("host platform adaptation boundary", () => {
  it("default calls and direct-saving calls hand off before any background writing", async () => {
    for (const params of [{}, { execution: "engine", save_as_draft: true }]) {
      expect(await executeHostRewrite({ action: "adapt_platform", title: "标题", body: "原稿", target_platform: "wechat_mp", ...params })).toMatchObject({ ok: false, code: "writer_submission_required" });
    }
    expect(adaptPlatformLLM).not.toHaveBeenCalled();
  });
  it("explicit backend suggestion reports unreviewed and does not save", async () => {
    expect(await executeHostRewrite({ action: "adapt_platform", title: "标题", body: "原稿", target_platform: "wechat_mp", execution: "engine" })).toMatchObject({ saved: false, quality_status: "unreviewed", needs_attention: true });
  });
});
