/**
 * 验收修复（2026-09-29 verifier）里 verifier-findings.test.ts 之外补的回归。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "../../runtime/context.js";
import { EventBus } from "../../runtime/events.js";
import { ToolRunner } from "../../runtime/tool-runner.js";
import { executePublish, publishSchema } from "../../tools/publish.js";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { writeEnabledVersion } from "../../storage/production-store.js";
import { founderDecision } from "./decisions.js";
import { reconcileContent } from "./reconcile.js";
import { registeredVideo } from "../publish/review-gate/testkit.js";
import { makeEnv, png, put, videoContent, type Env } from "./testkit.js";

const enable = () => writeEnabledVersion(env.dir);

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

describe("P2-3 / P3 回执与决定", () => {
  it("[P2-3] 封面被覆盖（没改回）：选它回 cover_replaced，不回成功", async () => {
    await enable();
    const r = await registeredVideo(env);
    const doc = (await readProductionDoc(r.id, env.dir))!;
    const c34 = doc.facts.find((f) => f.kind === "cover" && f.ratio === "3:4" && f.state === "accepted")!;
    const c43 = doc.facts.find((f) => f.kind === "cover" && f.ratio === "4:3" && f.state === "accepted")!;
    await put(path.join(r.root, c34.path!), png(900, 1200, "overwritten"));
    await reconcileContent(r.id, env.dir);
    const res = await founderDecision(r.id, "pick_cover", { cover_3x4_fact_id: c34.id, cover_3x4_sha: c34.sha256, cover_4x3_fact_id: c43.id, cover_4x3_sha: c43.sha256, cover_text: "字" }, env.dir);
    expect(res).toMatchObject({ ok: false, code: "cover_replaced" });
  });

  it("[P3 #16] 模型反复 confirm_published 同一链接：只记一条待核", async () => {
    await enable();
    const r = await registeredVideo(env);
    for (let i = 0; i < 3; i++) await executePublish({ _dataDir: env.dir, action: "confirm_published", content_id: r.id, publish_url: "https://v.douyin.com/abc", _host: "codex" });
    const doc = (await readProductionDoc(r.id, env.dir))!;
    expect(doc.facts.filter((f) => f.kind === "publish" && f.obs_source === "claim")).toHaveLength(1);
  });

  it("[P3 #17] 「我发了」不收 javascript: 链接", async () => {
    await enable();
    const r = await registeredVideo(env);
    expect(await founderDecision(r.id, "i_published", { platform: "douyin", url: "javascript:alert(1)" }, env.dir)).toMatchObject({ ok: false, code: "bad_url" });
  });
});
