/** Codex 审 seg3（~/.cache/autocrew-yt/ontology-advisor/codex-review-seg3.txt）的回归测试 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, saveContent } from "../../storage/local-store.js";
import { emptyProductionDoc } from "../../storage/production-types.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { executeAsset } from "../../tools/asset.js";
import { boardData } from "../../desktop/board-data.js";
import { founderProjectReview } from "../video/handoff/founder-review.js";
import { oldEntryClosed } from "./closed.js";
import { founderDecision } from "./decisions.js";
import { publishReceipts } from "./derive.js";
import { enableOntology } from "./enable.js";
import { cardPanel } from "./panel.js";
import { reconcileAll } from "./reconcile.js";
import { mergeReceipts } from "./receipts.js";
import { reopenScript } from "./reopen.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, SRT, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

const TITLE = "AI 又忘了怎么办";
const decide = (id: string, a: string, p: Record<string, unknown> = {}) => founderDecision(id, a, p, env.dir);

describe("Codex 审 seg3", () => {
  it("[P1 receipts.ts:89] 时间不明的回执重开后第二次对账也不自动核实；早于重开的可信回执不核实本轮声明", () => {
    const doc = emptyProductionDoc();
    doc.decisions.push({ id: "r", type: "reopen", round: 1, at: "2026-09-20T00:00:00Z", source: "founder" });
    doc.round = 2;
    const noTime = { platform: "douyin", item_id: "1", pub_state: "public" as const, verified: true, source: "reconcile" as const, evidence: "发布器" };
    mergeReceipts(doc, [noTime]);
    mergeReceipts(doc, [noTime]);
    expect(doc.facts[0]).toMatchObject({ verified: false, round_unsure: true });
    doc.facts.push({ id: "claim", kind: "publish", round: 2, state: "accepted", availability: "present", source: "record", at: "x", platform: "bilibili", url: "https://b", verified: false, pub_state: "reviewing" });
    mergeReceipts(doc, [{ platform: "bilibili", url: "https://b", pub_state: "public", verified: true, source: "reconcile", evidence: "发布器", at: "2026-09-10T00:00:00Z" }]);
    expect(doc.facts.find((f) => f.id === "claim")!.verified).toBe(false);
    expect(publishReceipts(doc).live).toEqual([]);
  });

  it("[P1 asset.ts:66] 库内路径夹着指向库外的符号链接：按真实路径算库外，关闭、不搬", async () => {
    const c = await videoContent(env, TITLE, "approved");
    const outside = await put(path.join(env.outside, "real", "b.mp4"), "v");
    await fs.symlink(path.dirname(outside), path.join(env.dir, "link"));
    expect(await executeAsset({ _dataDir: env.dir, action: "add", content_id: c.id, filename: "b.mp4", asset_type: "video", source_path: path.join(env.dir, "link", "b.mp4") })).toMatchObject({ code: "entry_closed" });
    expect(await fs.readFile(outside, "utf8")).toBe("v");
  });

  it("[P2 closed.ts:17] 图文稿不关旧入口（图文不动）", async () => {
    const c = await saveContent({ title: "长文", body: "正文", platform: "wechat_mp", status: "approved", tags: [] }, env.dir);
    expect(await oldEntryClosed(env.dir, c.id)).toBe(false);
  });

  it("[P2 decisions.ts:151] 挂 A-roll 前核时长：读不出时长的不收、不搬", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    const broken = await put(path.join(env.outside, "broken.mov"), "x");
    expect(await decide(c.id, "attach_aroll", { path: broken })).toMatchObject({ ok: false, code: "file_unstable" });
    expect(await fs.readFile(broken, "utf8")).toBe("x");
    expect(await readProductionDoc(c.id, env.dir)).toMatchObject({ facts: [] });
  });

  it("[P2 workbench.ts:93] 旧页面打回整批封面：批次指纹对不上就拒，不否决后来新批的封面", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "a.png"), png(900, 1200)), request_id: "a" });
    const oldView = await founderProjectReview(c.id, env.dir);
    const oldBatch = (oldView.gates as Record<string, { reject_sha256: string }>).gate4.reject_sha256;
    await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "b.png"), png(1200, 900)), version: 1, request_id: "b" });
    await expect(founderProjectReview(c.id, env.dir, { action: "reject", which: "covers", artifact_sha256: oldBatch, note: "不行" })).rejects.toThrow(/刷新/);
  });

  it("[P2 board-api.ts:73] 重开文稿带轮次：别处已重开 → 不再结束新的一轮；同轮重复确认幂等", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
    expect(await reopenScript(c.id, env.dir, undefined, 1)).toMatchObject({ ok: true, round: 2 });
    expect(await reopenScript(c.id, env.dir, undefined, 1)).toMatchObject({ ok: true, round: 2 });
    expect(await reopenScript(c.id, env.dir, undefined, 5)).toMatchObject({ ok: false, code: "stale" });
    expect((await readProductionDoc(c.id, env.dir))!.round).toBe(2);
  });

  it("[P2 Board.tsx:99] 看板按单张卡给启用状态：启用时被排除的稿 active=false，走旧拖动", async () => {
    const shadow = await makeEnv();
    try {
      const bad = await videoContent(shadow, TITLE, "approved");
      const good = await videoContent(shadow, "另一条好好的稿", "approved");
      await put(path.join(projectRoot(shadow, bad.id), "01-script/frozen"), "not a dir");
      await put(path.join(projectRoot(shadow, bad.id), "02-aroll/raw.mov"), "raw");
      await enableOntology(shadow.dir, { exclude: [bad.id] });
      const items = (await boardData(shadow.dir)).items;
      expect(items.find((i) => i.id === bad.id)!.active).toBe(false);
      expect(items.find((i) => i.id === good.id)!.active).toBe(true);
    } finally { await shadow.cleanup(); }
  });

  it("[P2 Board.tsx:215] 面板的发布记录新的在前（纠正最近一条真是最近的）", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
    await decide(c.id, "i_published", { platform: "douyin" });
    await new Promise((r) => setTimeout(r, 5));
    await decide(c.id, "i_published", { platform: "bilibili" });
    const p = await cardPanel(c.id, env.dir);
    expect((p.published as Array<{ platform: string }>)[0].platform).toBe("bilibili");
  });

  it("[P2 registration.ts:184] 自动登记（record 字幕触发）投影失败：回执与对账报告都带 warning", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "AI又忘了怎么办.mp4"), "cut"), request_id: "c" });
    const a = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "a.png"), png(900, 1200)), request_id: "p1" });
    const b = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "b.png"), png(1200, 900)), version: 1, request_id: "p2" });
    const doc = (await readProductionDoc(c.id, env.dir))!;
    const sha = (id: unknown) => doc.facts.find((f) => f.id === id)!.sha256;
    await decide(c.id, "approve_cut", { fact_id: cut.fact_id, sha256: sha(cut.fact_id) });
    await decide(c.id, "pick_cover", { cover_3x4_fact_id: a.fact_id, cover_3x4_sha: sha(a.fact_id), cover_4x3_fact_id: b.fact_id, cover_4x3_sha: sha(b.fact_id), cover_text: "字" });
    const reg = await import("./registration.js");
    vi.spyOn(reg, "registrationPatch").mockRejectedValueOnce(new Error("meta 写不进去"));
    const srt = await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), SRT), for_cut: cut.fact_id, request_id: "s" });
    expect(srt.registration).toBeTruthy();
    expect(String(srt.warnings)).toContain("没写完");
    vi.restoreAllMocks();
    vi.spyOn(reg, "commitRegistration").mockResolvedValueOnce({ ok: false, reason: "注入的失败" });
    const report = await reconcileAll(env.dir);
    expect(report.warnings.join("")).toContain("注入的失败");
    expect((await getContent(c.id, env.dir))!.video?.final).toBeTruthy();
  });
});
