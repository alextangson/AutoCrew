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
import { enableOntology } from "./enable.js";
import fs from "node:fs/promises";
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

describe("P3 #11 原片收件箱", () => {
  it("启用后建好收件箱（不存在就建）", async () => {
    await fs.rm(env.inbox, { recursive: true, force: true });
    expect((await enableOntology(env.dir)).ok).toBe(true);
    expect((await fs.stat(env.inbox)).isDirectory()).toBe(true);
  });

});

describe("P2-7 启用后不再指向旧交接流程", () => {
  it("手动切剪辑中 / codex handoff / codex 越权 / 写稿页提示都指向 record 与 summary；summary 的阶段来自推导", async () => {
    await enable();
    const { executeContentSave } = await import("../../tools/content-save.js");
    const { hostPolicy } = await import("../../../mcp/host-policy.js");
    const c = await videoContent(env, "AI 又忘了怎么办");
    const t = await executeContentSave({ _dataDir: env.dir, action: "transition", id: c.id, target_status: "editing" }) as { error?: string };
    expect(t.error).toContain("record kind=aroll");
    expect(t.error).not.toContain("剪这条");
    const { executeVideo } = await import("../../tools/video.js");
    expect(await executeVideo({ _dataDir: env.dir, action: "handoff", content_id: c.id, aroll_path: "/x.mov", _host: "claude-code" })).toMatchObject({ ok: false, code: "entry_closed" });
    expect(hostPolicy("codex", "autocrew_video", { action: "handoff" }, true)).toMatchObject({ ok: false, result: { code: "entry_closed" } });
    expect((hostPolicy("codex", "autocrew_writer", { action: "pack" }, true) as { error: string }).error).toContain("只报事实");
    const { createElement } = await import("../../../frontend/node_modules/react/index.js") as typeof import("react");
    const { renderToStaticMarkup } = await import("../../../frontend/node_modules/react-dom/server.node.js") as typeof import("react-dom/server");
    const { SharedProjectPanel } = await import("../../../frontend/src/views/SharedProjectPanel");
    expect(renderToStaticMarkup(createElement(SharedProjectPanel, { status: "approved", isVideo: true, ontology: true }))).toContain("0 原片放这里");
  });

  it("summary：本体稿制作段的 stage / next 来自 explain()", async () => {
    await enable();
    const { executeContentSave } = await import("../../tools/content-save.js");
    const r = await registeredVideo(env);
    const s = await executeContentSave({ _dataDir: env.dir, action: "summary", id: r.id }) as Record<string, unknown>;
    expect(s.stage).toBe("待发布");
    expect(String(s.next)).toContain("check_ids");
  });
});
