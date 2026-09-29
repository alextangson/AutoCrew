/**
 * 验收（verifier, 2026-09-29）：在 :4321 资料库克隆上真跑本体 1a + 发布闸门时发现的问题，写成测试。
 *
 * 标 `it.skip` + 「BUG」的是**目前会失败**的用例：代码有问题，按验收约定留着不修、不改测试去迁就它。
 * 修好之后把 skip 去掉即可。其余 `it` 是这次补的边界回归（现在就过）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { getContent } from "../../storage/local-store.js";
import { createContext } from "../../runtime/context.js";
import { EventBus } from "../../runtime/events.js";
import { ToolRunner } from "../../runtime/tool-runner.js";
import { executePublish, publishSchema } from "../../tools/publish.js";
import { founderProjectReview } from "../video/handoff/founder-review.js";
import { executePublishCheck } from "../publish/review-gate/check.js";
import { fakeJev, planEntry, planOf, registeredVideo, type Reg } from "../publish/review-gate/testkit.js";
import { founderDecision } from "./decisions.js";
import { cardPanel } from "./panel.js";
import { explainContent } from "./read.js";
import { reconcileAll, reconcileContent } from "./reconcile.js";
import { founderApprove, makeEnv, png, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const PLAN = "06-publish/publish-plan.json";
const writePlan = (r: Reg, platforms: unknown[]) => put(path.join(r.root, PLAN), JSON.stringify(planOf(r, platforms)));
async function checkIds(r: Reg): Promise<Record<string, string>> {
  const res = await executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: PLAN }, { jev: fakeJev().caller }) as { platforms: Array<{ platform: string; check_id: string }> };
  return Object.fromEntries(res.platforms.map((p) => [p.platform, p.check_id]));
}

describe("工作台适配（§8）：本体稿打开工作台", () => {
  // 真机：:4321 启用本体后点卡片「打开稿件 / 工作台」→ 整页白屏，控制台
  // `TypeError: Cannot read properties of undefined (reading 'split')`，出自 ProjectBoard.tsx HandoffDetails 的 fileName(h.aroll_path)。
  // workbench.ts workbenchOverlay 给的 handoff 只有 {generation, hash}；前端 ProjectReview.handoff 要 {generation, at, aroll_path, draft_hash, hash}。
  // 结果：启用后创始人在网页上没法审成片、选封面（只能直接调 /api/board/decision）。
  it("返回的 handoff 满足前端 ProjectReview.handoff 形状（aroll_path / at 是字符串）", async () => {
    const c = await videoContent(env, "AI 又忘了怎么办");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
    const review = await founderProjectReview(c.id, env.dir) as { ontology?: boolean; handoff?: Record<string, unknown> };
    expect(review.ontology).toBe(true);
    expect(typeof review.handoff?.aroll_path).toBe("string");
    expect(typeof review.handoff?.at).toBe("string");
  });
});

describe("封面被覆盖又改回（E13 的 ABA）", () => {
  async function registeredWithOverwrite() {
    const r = await registeredVideo(env);
    const doc = (await readProductionDoc(r.id, env.dir))!;
    const c34 = doc.facts.find((f) => f.kind === "cover" && f.ratio === "3:4" && f.state === "accepted")!;
    const file = path.join(r.root, c34.path!);
    const original = await fs.readFile(file);
    await put(file, png(900, 1200, "someone-overwrote-it"));
    await reconcileContent(r.id, env.dir);
    await put(file, original); // 改回原字节
    await reconcileContent(r.id, env.dir);
    const c43 = doc.facts.find((f) => f.kind === "cover" && f.ratio === "4:3" && f.state === "accepted")!;
    return { r, c34, c43 };
  }

  // 真机复现：覆盖 05-cover/v001/封面-3x4.png 再改回，创始人对那张点「用这一版封面」→ ok:true、决定落盘，阶段仍是「封面待你选」，
  // 没有任何错误。pickCover 用 factBy 找到了已 replaced 的事实，validCoverApproval 又立刻判它失效。
  it("对已被替换的封面事实点「用这一版」不能回 ok:true 然后什么都没发生", async () => {
    const { r, c34, c43 } = await registeredWithOverwrite();
    const res = await founderDecision(r.id, "pick_cover", {
      cover_3x4_fact_id: c34.id, cover_3x4_sha: c34.sha256, cover_4x3_fact_id: c43.id, cover_4x3_sha: c43.sha256, cover_text: "换个字",
    }, env.dir);
    // 要么拒绝（说明这张被覆盖过），要么真的生效（成片已批、字幕在 → 登记进待发布）；不能「成功」却什么都没变。
    // 单元环境下现状：ok:true、stage 剪辑中、missing ["封面(3:4)"]——项目里明明有这张图，卡片却说缺 3:4
    if (res.ok) expect({ stage: res.stage, missing: res.missing }).toEqual({ stage: "待发布", missing: [] });
    else expect(res.ok).toBe(false);
  });

  // 真机：record 同一字节回 ok:true、fact_id 指向那条 replaced 的死事实；这张封面再也选不回来
  it("改回原字节后重报这张封面，得到一条可用（未 replaced）的事实，而不是静默回放死事实", async () => {
    const { r, c34 } = await registeredWithOverwrite();
    const res = await record(env, { content_id: r.id, kind: "cover", ratio: "3:4", path: path.join(r.root, c34.path!), request_id: "again" });
    expect(res.ok).toBe(true);
    const doc = (await readProductionDoc(r.id, env.dir))!;
    expect(doc.facts.find((f) => f.id === res.fact_id)?.replaced_at).toBeUndefined();
  });

  // spec E13：「所批文件被覆盖 → 批准失效写原因」。真机卡片只写「有封面待你选」，alerts 为空，看不出批准为什么没了
  it("所批封面被覆盖后，卡片说明批准因文件被覆盖而失效（E13 写原因）", async () => {
    const r = await registeredVideo(env);
    const doc = (await readProductionDoc(r.id, env.dir))!;
    const c34 = doc.facts.find((f) => f.kind === "cover" && f.ratio === "3:4" && f.state === "accepted")!;
    await put(path.join(r.root, c34.path!), png(900, 1200, "overwritten"));
    await reconcileContent(r.id, env.dir);
    const exp = await explainContent((await getContent(r.id, env.dir))!, env.dir);
    const text = [exp.reason, ...(exp.alerts ?? []), ...(exp.badges ?? [])].join(" ");
    expect(text).toMatch(/覆盖|被换|失效/);
  });
});

describe("record 的 request_id（E6）", () => {
  // 真机：r-aroll-2 先报了 aroll，再用同一个 request_id 报 kind=cover 的另一张图 → ok:true、replayed:true、回的是 aroll 回执；
  // 封面没有入库，agent 以为报上了（AGENTS.md：不能静默丢结果还报成功）
  it("同一 request_id 换了 kind / path 再报，要拒（或至少不回 ok:true）", async () => {
    const c = await videoContent(env, "AI 又忘了怎么办");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "same" });
    const res = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c34.png"), png(900, 1200)), request_id: "same" });
    expect(res.ok).toBe(false);
  });

  it("同一 request_id、同样参数重试（原件已被挪走）→ 回放上次结果", async () => {
    const c = await videoContent(env, "AI 又忘了怎么办");
    await founderApprove(env, c.id);
    const src = await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw");
    const a = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "same" });
    const b = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "same" });
    expect(b).toMatchObject({ ok: true, replayed: true, fact_id: a.fact_id });
  });
});

describe("发布槽与把关（§6 / 闸门 §11）", () => {
  // 真机：publish-plan.json 里平台写「视频号」、带着有效的 wechat_video check_id、提交晚于检查 →
  // 槽的平台是「视频号」，gateStamp 按「视频号」找检查对不上 → 卡片「发布前未把关」（误报）。check 本身认中文别名，回执不认
  it("发布计划用中文平台名（视频号）+ 有效 check_id → 不标「发布前未把关」", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "wechat_video", ["3:4", "4:3"])]);
    const ids = await checkIds(r);
    await writePlan(r, [{ ...planEntry(r, "wechat_video", ["3:4", "4:3"]), platform: "视频号", check_id: ids.wechat_video,
      publication: { status: "submitted", submitted_at: new Date(Date.now() + 1000).toISOString() } }]);
    await reconcileAll(env.dir);
    const p = await cardPanel(r.id, env.dir);
    expect((p.alerts as string[]).some((a) => a.includes("发布前未把关"))).toBe(false);
  });

  // 真机：抖音 / 小红书 / 视频号已定时，B站 驳回「封面含二维码」→ 卡片面板 alerts 只有未把关，B站 驳回在面板里完全看不到
  // （derive.ts D1 分支只放 UNREGISTERED + gateAlerts，receipts.rejected 被丢掉）。spec E35「被驳回 → 标原因」
  it("其他平台已投出时，某平台被驳回的原因仍要上卡（D1 不能吞掉驳回）", async () => {
    const r = await registeredVideo(env);
    const now = new Date(Date.now() + 1000).toISOString();
    await writePlan(r, [
      { ...planEntry(r, "douyin", ["3:4", "4:3"]), publication: { status: "scheduled", submitted_at: now }, scheduled_at: "2030-01-01T10:00:00+08:00" },
      { ...planEntry(r, "bilibili", ["4:3"]), publication: { status: "rejected", reject_reason: "封面含二维码", submitted_at: now } },
    ]);
    await reconcileAll(env.dir);
    const exp = await explainContent((await getContent(r.id, env.dir))!, env.dir);
    expect(exp.stage).toBe("已发布");
    expect([...(exp.alerts ?? []), ...(exp.badges ?? [])].join(" ")).toContain("封面含二维码");
  });
});

describe("启用后的出包（闸门 §11）：走真实 ToolRunner", () => {
  // 集成测试直接调 executePublish，绕开了 ToolRunner 的旧 prePublishGateMiddleware。真机经 MCP：带有效 check_ids 调
  // ego_lite_prepare → pre_publish_check_failed（「封面审核：未完成」「Hashtags：无标签」），本体登记的封面不走 cover_review，
  // 这一项永远不过；唯一出路是报错里建议的 force=true。
  it("已登记 + 有效 check_id，不带 force 也能出包（旧 pre_publish 不该再挡本体稿）", async () => {
    const r = await registeredVideo(env);
    await writePlan(r, [planEntry(r, "douyin", ["3:4", "4:3"])]);
    const ids = await checkIds(r);
    const runner = new ToolRunner({ ctx: createContext({ data_dir: env.dir }), eventBus: new EventBus() });
    runner.register({ name: "autocrew_publish", label: "publish", description: "", parameters: publishSchema, execute: executePublish });
    const res = await runner.execute("autocrew_publish", { action: "ego_lite_prepare", content_id: r.id, check_ids: [ids.douyin], _host: "claude-code" });
    expect(res).toMatchObject({ ok: true });
  });
});

describe("record 回执文案", () => {
  // 真机：收件箱里文件名对不上标题 → 记候选（对），但 next_action 说「文件不在可搬入的目录里」——它就在收件箱（可搬入根）里
  it("收件箱里对不上标题的原片，回执不说「不在可搬入的目录里」", async () => {
    const c = await videoContent(env, "AI 又忘了怎么办");
    await founderApprove(env, c.id);
    const res = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "随便录的一段.mov"), "raw"), request_id: "x" });
    expect(res).toMatchObject({ ok: true, state: "candidate" });
    expect(String(res.next_action)).not.toContain("不在可搬入");
  });
});

