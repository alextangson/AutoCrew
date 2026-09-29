/**
 * Segment ③：旧入口只在已启用的资料库关闭（§8）、说明跟着启用状态走、晨报新桶、卡片面板数据与 A-roll 挂载（§9.1、§10）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { executeVideo } from "../../tools/video.js";
import { executeAsset } from "../../tools/asset.js";
import { executeStatus } from "../../tools/status.js";
import { founderProjectReview } from "../video/handoff/founder-review.js";
import { mcpToolView } from "../../../mcp/tool-docs.js";
import { ONTOLOGY_PROJECT_RULES, PROJECT_RULES } from "../../storage/content-project.js";
import { readProductionDoc, writeEnabledVersion } from "../../storage/production-store.js";
import { founderDecision } from "./decisions.js";
import { enableOntology } from "./enable.js";
import { cardPanel } from "./panel.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv(); });
afterEach(async () => { await env.cleanup(); });

const TITLE = "AI 又忘了怎么办";

describe("旧入口只在已启用的资料库关闭（§8）", () => {
  it("未启用：handoff / register 等照旧可用（不返回 entry_closed）；启用后返回指路错误", async () => {
    const c = await videoContent(env, TITLE, "approved");
    for (const action of ["handoff", "register", "report", "revoke", "match", "confirm"]) {
      const before = await executeVideo({ _dataDir: env.dir, _host: "codex", action, content_id: c.id });
      expect((before as { code?: string }).code, action).not.toBe("entry_closed");
    }
    await writeEnabledVersion(env.dir);
    for (const action of ["handoff", "register", "report", "revoke", "match", "confirm"]) {
      const after = await executeVideo({ _dataDir: env.dir, _host: "codex", action, content_id: c.id }) as { code?: string; error?: string };
      expect(after, action).toMatchObject({ code: "entry_closed" });
      expect(after.error).toContain("autocrew_content record");
    }
  });

  it("asset add：启用后封面分支与库外文件挪入关闭，库内素材登记照旧", async () => {
    const c = await videoContent(env, TITLE, "approved");
    await writeEnabledVersion(env.dir);
    const outside = await put(path.join(env.outside, "c.png"), png(900, 1200));
    expect(await executeAsset({ _dataDir: env.dir, action: "add", content_id: c.id, filename: "c.png", asset_type: "cover", source_path: outside })).toMatchObject({ code: "entry_closed" });
    expect(await executeAsset({ _dataDir: env.dir, action: "add", content_id: c.id, filename: "b.mp4", asset_type: "video", source_path: outside })).toMatchObject({ code: "entry_closed" });
  });

  it("工作台「撤回交接」在本体下关闭，指向重开文稿 / 撤销批准", async () => {
    const c = await videoContent(env, TITLE, "approved");
    await writeEnabledVersion(env.dir);
    expect(await founderProjectReview(c.id, env.dir, { action: "revoke", manifest_hash: "x" })).toMatchObject({ code: "entry_closed" });
  });
});

describe("说明跟着启用状态走（§8 同步改口）", () => {
  it("MCP 工具说明：启用后 content / video / asset 换成 record 口径", () => {
    const tool = { name: "autocrew_video", description: "原说明", parameters: { type: "object", properties: {} } };
    expect(mcpToolView(tool).description).toContain("handoff");
    expect(mcpToolView(tool, true).description).toContain("autocrew_content record");
  });

  it("项目 AGENTS.md：启用时没手改过的旧约定换成一行指向", async () => {
    const c = await videoContent(env, TITLE, "approved");
    const file = path.join(projectRoot(env, c.id), "AGENTS.md");
    expect(await fs.readFile(file, "utf8")).toBe(PROJECT_RULES);
    expect((await enableOntology(env.dir)).ok).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe(ONTOLOGY_PROJECT_RULES);
    const later = await videoContent(env, "启用之后新建的稿", "draft_ready");
    expect(await fs.readFile(path.join(projectRoot(env, later.id), "AGENTS.md"), "utf8")).toBe(ONTOLOGY_PROJECT_RULES);
  });

  it("晨报：启用后是 待写 / 待认稿 / 等 A-roll / 剪辑中 / 等你审 / 待发布，候选待确认非零才出现", async () => {
    await writeEnabledVersion(env.dir);
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    let r = await executeStatus({ _dataDir: env.dir, brief: true }) as { brief: string };
    expect(r.brief).toMatch(/待写 \/ \d+ 待认稿 \/ 1 等 A-roll \/ 0 剪辑中 \/ 0 等你审 \/ 0 待发布$/);
    await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.outside, "x.mp4"), "maybe"), request_id: "r1" });
    r = await executeStatus({ _dataDir: env.dir, brief: true }) as { brief: string };
    expect(r.brief).toContain("1 候选待确认");
  });
});

describe("卡片面板与 A-roll 挂载（§9.1、§10）", () => {
  beforeEach(async () => { await writeEnabledVersion(env.dir); });

  it("面板给阶段、还差什么、候选（带 sha 供「是这条」）、能不能重开", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.outside, "录的.mov"), "raw"), request_id: "r1" });
    const p = await cardPanel(c.id, env.dir);
    expect(p).toMatchObject({ ok: true, active: true, stage: "待录制", missing: ["A-roll"], can_reopen: true });
    expect((p.candidates as Array<{ sha256?: string }>)[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("贴路径挂 A-roll = 创始人决定：挪进项目、accepted；像别条就先提醒，再确认才挂", async () => {
    const c = await videoContent(env, TITLE);
    const other = await videoContent(env, "完全不同的第二条标题");
    await founderApprove(env, c.id);
    const looksOther = await put(path.join(env.outside, "完全不同的第二条标题.mov"), "raw-x");
    expect(await founderDecision(c.id, "attach_aroll", { path: looksOther }, env.dir)).toMatchObject({ ok: false, code: "looks_like_other", other_id: other.id });
    const r = await founderDecision(c.id, "attach_aroll", { path: looksOther, confirm_other: true }, env.dir);
    expect(r).toMatchObject({ ok: true, state: "accepted", stage: "剪辑中" });
    expect((await readProductionDoc(c.id, env.dir))!.facts[0]).toMatchObject({ kind: "aroll", state: "accepted", source: "founder" });
    expect(await fs.stat(looksOther).catch(() => null)).toBeNull();
  });
});
