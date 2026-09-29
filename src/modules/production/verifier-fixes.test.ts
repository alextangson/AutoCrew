/**
 * 验收修复（2026-09-29 verifier）里 verifier-findings.test.ts 之外补的回归。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "../../runtime/context.js";
import { EventBus } from "../../runtime/events.js";
import { ToolRunner } from "../../runtime/tool-runner.js";
import { executePublish, publishSchema } from "../../tools/publish.js";
import { makeEnv, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: false }); });
afterEach(async () => { await env.cleanup(); });

describe("P1-2 旧预检", () => {
  it("未启用的资料库旧预检照跑，但报错不建议 force", async () => {
    const c = await videoContent(env, "AI 又忘了怎么办");
    const runner = new ToolRunner({ ctx: createContext({ data_dir: env.dir }), eventBus: new EventBus() });
    runner.register({ name: "autocrew_publish", label: "publish", description: "", parameters: publishSchema, execute: executePublish });
    const res = await runner.execute("autocrew_publish", { action: "ego_lite_prepare", content_id: c.id, _host: "claude-code" }) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: false, error: "pre_publish_check_failed" });
    expect(JSON.stringify(res)).not.toContain("force");
  });
});
