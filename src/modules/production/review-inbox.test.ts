/**
 * 等你拍板 2a-1（spec 2026-09-30-review-inbox）：列表推导、单一决定入口（CAS）、请示、发布检查、摘要、附件、工作台。
 * 测试名带 §12 的 R 编号。只用临时库，fixtures 不含真实稿件文本。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createBoardHandler } from "../../desktop/board-route.js";
import { getContent, softDeleteContent } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { executeContentSave } from "../../tools/content-save.js";
import { hostPolicy } from "../../../mcp/host-policy.js";
import { executePublishCheck } from "../publish/review-gate/check.js";
import { fakeJev, planEntry, planOf, registeredVideo } from "../publish/review-gate/testkit.js";
import { founderProjectReview } from "../video/handoff/founder-review.js";
import { decide, decideItem } from "./inbox-decide.js";
import { readInbox } from "./inbox-read.js";
import { scopedId } from "./inbox.js";
import { reopenScript } from "./reopen.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, waiveSliverCheck, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const TITLE = "测试用短视频";
const agent = (p: Record<string, unknown>, host = "claude-code") => executeContentSave({ _dataDir: env.dir, _host: host, ...p }) as Promise<Record<string, unknown>>;
const items = async (contentId?: string) => (await readInbox(env.dir, contentId ? { contentId } : {})).items;
const itemOf = async (id: string, contentId?: string) => (await items(contentId)).find((i) => i.item_id === id || i.item_id === scopedId(i.content_id ?? "", id));
const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;

async function editing() {
  const c = await videoContent(env, TITLE);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "测试用短视频-原片.mov"), "raw"), request_id: "a" });
  return c;
}

async function markedCut(contentId: string, name = "测试用短视频.mp4", bytes = "cut-1", rid = "c1") {
  const r = await record(env, { content_id: contentId, kind: "cut", path: await put(path.join(env.chatcut, name), bytes), request_id: rid, review: true }, "codex");
  const sha = (await doc(contentId)).facts.find((f) => f.id === r.fact_id)!.sha256!;
  return { fact_id: r.fact_id as string, sha };
}

const ask = (contentId: string, extra: Record<string, unknown> = {}) => agent({ action: "ask", content_id: contentId, request_id: `q-${Math.random().toString(36).slice(2, 8)}`, kind: "粗剪", question: "粗剪这样行吗？",
  options: [{ id: "ok", label: "可以" }, { id: "redo", label: "再改改" }], ...extra });

describe("列表推导（§3）", () => {
  it("R14 item_id 稳定、gen 随快照变；看板读零写入", async () => {
    const c = await editing();
    await markedCut(c.id);
    const before = await fs.readFile(path.join(projectRoot(env, c.id), "00-project/autocrew/production.json"), "utf8");
    const a = await itemOf(`cut:r1`, c.id);
    const b = await itemOf(`cut:r1`, c.id);
    expect(a).toMatchObject({ type: "cut_review", summary: "成片剪好了，看一遍", waiting: { label: "Codex" } });
    expect(b!.gen).toBe(a!.gen);
    expect(await fs.readFile(path.join(projectRoot(env, c.id), "00-project/autocrew/production.json"), "utf8")).toBe(before);
    await markedCut(c.id, "测试用短视频-2.mp4", "cut-2", "c2");
    const after = await itemOf(`cut:r1`, c.id);
    expect(after!.item_id).toBe(a!.item_id);
    expect(after!.gen).not.toBe(a!.gen);
    expect((after!.detail.versions as Array<{ label: string }>).map((v) => v.label)).toEqual(["最新一版", "上一版"]);
  });

  it("排序：有 agent 在等的在前 → 挡住推进 → 稿子；正在核对的原片不是条目", async () => {
    const c = await editing();
    await markedCut(c.id);
    await ask(c.id);
    const draft = await videoContent(env, "另一条稿");
    const list = await items();
    const types = list.map((i) => i.type);
    expect(types.indexOf("ask")).toBeLessThan(types.indexOf("cut_review"));
    expect(types.indexOf("cut_review")).toBeLessThan(list.findIndex((i) => i.content_id === draft.id));
    expect(list[0]).toMatchObject({ agent_waiting: true, waiting: { label: "Claude" } });
  });
});

describe("单一决定入口：CAS（§3.1）", () => {
  it("R1 代次不符 → 「刚变过」，不写", async () => {
    const c = await editing();
    const cut = await markedCut(c.id);
    const it0 = (await itemOf("cut:r1", c.id))!;
    await markedCut(c.id, "测试用短视频-2.mp4", "cut-2", "c2");
    const r = await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "reject_cut", fact_id: cut.fact_id, note: "开头拖" }, env.dir);
    expect(r).toMatchObject({ ok: false, code: "stale" });
    expect((await doc(c.id)).decisions.some((d) => d.type === "cut_reject")).toBe(false);
  });

  it("R2 同一件事同一决定点两次 → 回放；不同决定 → 拒", async () => {
    const c = await editing();
    const cut = await markedCut(c.id);
    const it0 = (await itemOf("cut:r1", c.id))!;
    const req = { content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "reject_cut", fact_id: cut.fact_id, note: "开头拖" };
    const a = await decideItem(req, env.dir);
    const b = await decideItem(req, env.dir);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true, replayed: true });
    expect((await doc(c.id)).decisions.filter((d) => d.type === "cut_reject")).toHaveLength(1);
    await waiveSliverCheck(env, c.id, cut.sha);
    expect(await decideItem({ ...req, action: "approve_cut", note: undefined }, env.dir)).toMatchObject({ ok: false, code: "already_decided" });
  });

  it("R22 打回消费当时快照：同快照不再出条目；重新标「可以审了」才开新代次", async () => {
    const c = await editing();
    const cut = await markedCut(c.id);
    const it0 = (await itemOf("cut:r1", c.id))!;
    await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "reject_cut", fact_id: cut.fact_id, note: "开头拖" }, env.dir);
    expect(await itemOf("cut:r1", c.id)).toBeUndefined();
    const v2 = await markedCut(c.id, "测试用短视频-2.mp4", "cut-2", "c2");
    expect(await itemOf("cut:r1", c.id)).toMatchObject({ detail: { review_fact_id: v2.fact_id } });
  });

  it("R18 工作台的决定走同一个入口（旧页面没带代次：按指纹找条目，照样记消费）", async () => {
    const c = await editing();
    const cut = await markedCut(c.id);
    await waiveSliverCheck(env, c.id, cut.sha);
    const r = await founderProjectReview(c.id, env.dir, { action: "approve", which: "final_cut", files: [{ path: "x", sha256: cut.sha }] }) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, editor_label: "Codex" });
    expect((await doc(c.id)).inbox_log).toMatchObject([{ item_id: scopedId(c.id, "cut:r1"), action: "approve_cut" }]);
    expect(await itemOf("cut:r1", c.id)).toBeUndefined();
  });

  it("「新版要不要换」：已批 v1 后标 v2 → 条目换说法；不撤旧批准", async () => {
    const c = await editing();
    const v1 = await markedCut(c.id);
    await waiveSliverCheck(env, c.id, v1.sha);
    await decide(c.id, "approve_cut", { fact_id: v1.fact_id, sha256: v1.sha }, env.dir);
    expect(await itemOf("cut:r1", c.id)).toBeUndefined();
    await markedCut(c.id, "测试用短视频-2.mp4", "cut-2", "c2");
    expect(await itemOf("cut:r1", c.id)).toMatchObject({ summary: "新的一版剪好了，要不要换" });
    expect((await doc(c.id)).decisions.filter((d) => d.type === "approval_revoke")).toHaveLength(0);
  });

  it("模型调用进不了决定入口", async () => {
    const c = await editing();
    await markedCut(c.id);
    const it0 = (await itemOf("cut:r1", c.id))!;
    expect(await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "approve_cut", _host: "codex" }, env.dir)).toMatchObject({ ok: false, code: "founder_only" });
  });
});

describe("请示（§5）", () => {
  it("R5 选项 2–4 个带 id、问题非空、kind 合法；分镜请示必须指定分镜事实", async () => {
    const c = await editing();
    expect(await ask(c.id, { options: [{ id: "a", label: "一" }] })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await ask(c.id, { options: [{ id: "a b", label: "一" }, { id: "b", label: "二" }] })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await ask(c.id, { question: "" })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await ask(c.id, { kind: "别的" })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await ask(c.id, { kind: "分镜", options: [{ id: "approve", label: "通过" }, { id: "no", label: "不行" }] })).toMatchObject({ ok: false, code: "storyboard_required" });
    expect(await ask(c.id, { options: JSON.stringify([{ id: "a", label: "一" }, { id: "b", label: "二" }]) })).toMatchObject({ ok: true });
  });

  it("R4 附件不在本条项目内 → 拒；附件 sha 创建时绑定", async () => {
    const c = await editing();
    const outside = await put(path.join(env.outside, "x.png"), png(10, 10));
    expect(await ask(c.id, { attachments: [{ path: outside }] })).toMatchObject({ ok: false, code: "attachment_outside" });
    const inside = await put(path.join(projectRoot(env, c.id), "04-edit/rough.png"), png(10, 10));
    const r = await ask(c.id, { attachments: [{ path: inside }] });
    expect((await doc(c.id)).asks!.find((a) => a.id === r.ask_id)!.attachments[0]).toMatchObject({ path: "04-edit/rough.png", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("R3 附件在答之前变了 → 条目提示、旧代次拒、再答也拒", async () => {
    const c = await editing();
    const file = await put(path.join(projectRoot(env, c.id), "04-edit/rough.png"), png(10, 10));
    const r = await ask(c.id, { attachments: [file] });
    const it0 = (await itemOf(`ask:${r.ask_id}`, c.id))!;
    await put(file, png(10, 10, "changed"));
    const it1 = (await itemOf(`ask:${r.ask_id}`, c.id))!;
    expect(it1).toMatchObject({ summary: expect.stringContaining("附件变过，请重新发请示"), detail: { attachments_changed: true }, actions: [{ action: "ask_resend" }] });
    expect(await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "answer_ask", option_id: "ok" }, env.dir)).toMatchObject({ ok: false, code: "stale" });
    expect(await decideItem({ content_id: c.id, item_id: it1.item_id, gen: it1.gen, action: "answer_ask", option_id: "ok" }, env.dir)).toMatchObject({ ok: false });
    // 让 agent 重发：记一笔决定，agent 在 asks[] 里看到 stale_attachment
    expect(await decideItem({ content_id: c.id, item_id: it1.item_id, gen: it1.gen, action: "ask_resend" }, env.dir)).toMatchObject({ ok: true });
    const s = await agent({ action: "summary", id: c.id });
    expect(s.asks).toMatchObject([{ ask_id: r.ask_id, state: "stale_attachment", reason: "附件变过，请重新发请示" }]);
  });

  it("创始人答：选项 + 一句话；agent 从 summary 的 asks[] 取答复", async () => {
    const c = await editing();
    const r = await ask(c.id);
    const it0 = (await itemOf(`ask:${r.ask_id}`, c.id))!;
    expect(await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "answer_ask", option_id: "redo", note: "前 10 秒再紧一点" }, env.dir)).toMatchObject({ ok: true });
    const s = await agent({ action: "summary", id: c.id });
    expect(s.asks).toEqual([{ ask_id: r.ask_id, kind: "粗剪", state: "answered", option_id: "redo", via: "founder", note: "前 10 秒再紧一点" }]);
    expect(await itemOf(`ask:${r.ask_id}`, c.id)).toBeUndefined();
  });

  it("R6 新请示取代同 kind 旧请示；取代 / 撤回之后的回答拒", async () => {
    const c = await editing();
    const old = await ask(c.id);
    const oldItem = (await itemOf(`ask:${old.ask_id}`, c.id))!;
    const neu = await ask(c.id);
    expect(neu).toMatchObject({ ok: true, superseded: [old.ask_id] });
    expect(await decideItem({ content_id: c.id, item_id: oldItem.item_id, gen: oldItem.gen, action: "answer_ask", option_id: "ok" }, env.dir)).toMatchObject({ ok: false, code: "gone" });
    expect(await agent({ action: "answer_ask", content_id: c.id, ask_id: old.ask_id, option_id: "ok", founder_quote: "可以" })).toMatchObject({ ok: false, code: "ask_closed" });
    expect(await agent({ action: "withdraw_ask", content_id: c.id, ask_id: neu.ask_id })).toMatchObject({ ok: true, state: "withdrawn" });
    expect(await agent({ action: "answer_ask", content_id: c.id, ask_id: neu.ask_id, option_id: "ok", founder_quote: "可以" })).toMatchObject({ ok: false, code: "ask_closed" });
  });

  it("R7 聊天转述：花费、分镜请示不收；普通请示收下、创始人 24 小时内能撤、过了不能", async () => {
    const c = await editing();
    const cost = await ask(c.id, { kind: "花费", question: "要花 20 元生图，行吗？" });
    expect(await agent({ action: "answer_ask", content_id: c.id, ask_id: cost.ask_id, option_id: "ok", founder_quote: "行" })).toMatchObject({ ok: false, code: "founder_only" });
    const r = await ask(c.id);
    expect(await agent({ action: "answer_ask", content_id: c.id, ask_id: r.ask_id, option_id: "ok", founder_quote: "可以就这样" })).toMatchObject({ ok: true, via: "agent_reported" });
    const it0 = (await itemOf(`ask:${r.ask_id}`, c.id))!;
    expect(it0).toMatchObject({ type: "ask_reported", summary: expect.stringContaining("『可以就这样』") });
    const late = Date.now() + 25 * 3600_000;
    expect(await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "undo_ask_answer" }, env.dir, { now: late })).toMatchObject({ ok: false });
    expect(await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "undo_ask_answer" }, env.dir)).toMatchObject({ ok: true });
    expect((await doc(c.id)).asks!.find((a) => a.id === r.ask_id)).toMatchObject({ state: "open", history: [{ via: "agent_reported" }] });
  });

  it("R7 分镜请示：只认创始人；答「通过」只批准绑定的快照，分镜变了 → 拒", async () => {
    const c = await editing();
    const dir = path.join(projectRoot(env, c.id), "03-broll/review-v001");
    const bytes = "<svg>b1</svg>";
    await put(path.join(dir, "boards/B01.svg"), bytes);
    const html = `<html><body><img src="boards/B01.svg"></body></html>`;
    await put(path.join(dir, "review.html"), html);
    const h = (b: string) => crypto.createHash("sha256").update(b).digest("hex");
    await put(path.join(dir, "review.receipt.json"), JSON.stringify({ manifest_sha256: "m", media: [{ item: "B01", path: "boards/B01.svg", sha256: h(bytes) }], html_sha256: h(html) }));
    const sb = await record(env, { content_id: c.id, kind: "storyboard", path: "03-broll/review-v001/review.html", request_id: "sb" });
    expect(sb).toMatchObject({ ok: true });
    const opts = [{ id: "approve", label: "通过" }, { id: "redo", label: "重画" }];
    const r = await ask(c.id, { kind: "分镜", fact_id: sb.fact_id, options: opts });
    expect(r).toMatchObject({ ok: true });
    expect(await agent({ action: "answer_ask", content_id: c.id, ask_id: r.ask_id, option_id: "approve", founder_quote: "行" })).toMatchObject({ ok: false, code: "founder_only" });
    const it0 = (await itemOf(`ask:${r.ask_id}`, c.id))!;
    expect(await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "answer_ask", option_id: "approve" }, env.dir)).toMatchObject({ ok: true, storyboard_approved: true });
    expect((await doc(c.id)).decisions.find((d) => d.type === "storyboard_approval")).toMatchObject({ fact_id: sb.fact_id, ask_id: r.ask_id });
    const r2 = await ask(c.id, { kind: "分镜", fact_id: sb.fact_id, options: opts });
    await put(path.join(dir, "boards/B01.svg"), "<svg>changed</svg>");
    const it2 = (await itemOf(`ask:${r2.ask_id}`, c.id))!;
    expect(await decideItem({ content_id: c.id, item_id: it2.item_id, gen: it2.gen, action: "answer_ask", option_id: "approve" }, env.dir)).toMatchObject({ ok: false, code: "storyboard_changed" });
  });

  it("R17 摘要 ≤1.5KB；asks[] 用独立游标 asks_offset 翻页", async () => {
    const c = await editing();
    const kinds = ["粗剪", "样片", "花费", "配乐", "其他"];
    for (const kind of kinds) await ask(c.id, { kind, question: "这里要你定一下：".repeat(10) });
    const p1 = await agent({ action: "summary", id: c.id });
    expect(Buffer.byteLength(JSON.stringify(p1))).toBeLessThanOrEqual(1536);
    expect(p1.asks).toHaveLength(3);
    expect(p1.asks_next_offset).toBe(3);
    expect(p1.inbox).toMatchObject({ count: 5, where: "等你拍板" });
    const p2 = await agent({ action: "summary", id: c.id, asks_offset: p1.asks_next_offset });
    expect((p2.asks as unknown[]).length).toBe(2);
    expect(p2.asks_next_offset).toBeUndefined();
  });

  it("R13 稿重开 / 删除 → 条目全消、请示关闭、迟到的回答拒", async () => {
    const c = await editing();
    const r = await ask(c.id);
    const it0 = (await itemOf(`ask:${r.ask_id}`, c.id))!;
    await markedCut(c.id);
    await reopenScript(c.id, env.dir, undefined, 1);
    expect((await items(c.id)).filter((i) => i.type !== "draft")).toEqual([]);
    expect(await decideItem({ content_id: c.id, item_id: it0.item_id, gen: it0.gen, action: "answer_ask", option_id: "ok" }, env.dir)).toMatchObject({ ok: false });
    expect(await agent({ action: "answer_ask", content_id: c.id, ask_id: r.ask_id, option_id: "ok", founder_quote: "可以" })).toMatchObject({ ok: false, code: "ask_closed", error: expect.stringContaining("重开") });
    const s = await agent({ action: "summary", id: c.id });
    expect(s.asks).toMatchObject([{ state: "closed", reason: "稿子重开了" }]);
    const d = await editing();
    await ask(d.id);
    await softDeleteContent(d.id, env.dir);
    expect(await items(d.id)).toEqual([]);
  });

  it("R19 附件：HTML 不从 AutoCrew 网址提供；图片带 sandbox + nosniff；字节变了拒", async () => {
    const c = await editing();
    const root = projectRoot(env, c.id);
    const img = await put(path.join(root, "04-edit/rough.png"), png(10, 10));
    const html = await put(path.join(root, "04-edit/page.html"), "<script>fetch('/api/inbox/decide')</script>");
    const r = await ask(c.id, { attachments: [img, html] });
    const get = async (index: number) => {
      const handler = createBoardHandler({ authorize: () => "session", originAllowed: () => true, resolveDataDir: async () => env.dir, readBody: async () => "" });
      const out = new PassThrough();
      let status = 0; let headers: Record<string, string> = {};
      const chunks: Buffer[] = [];
      out.on("data", (b: Buffer) => chunks.push(b));
      const res = Object.assign(out, { writeHead: (s: number, h: Record<string, string>) => { status = s; headers = h ?? {}; return res; } }) as unknown as http.ServerResponse;
      await handler({ method: "GET" } as http.IncomingMessage, res, new URL(`http://x/api/inbox/attachment?content_id=${c.id}&ask_id=${String(r.ask_id)}&index=${index}`));
      await new Promise((ok) => setTimeout(ok, 20));
      return { status, headers, body: Buffer.concat(chunks) };
    };
    const a = await get(0);
    expect(a).toMatchObject({ status: 200, headers: { "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff", "Content-Type": "image/png" } });
    expect((await get(1)).status).toBe(403);
    await put(img, png(10, 10, "changed"));
    expect((await get(0)).status).toBe(409);
  });

  it("Codex allowlist：ask / answer_ask / withdraw_ask / mark_ready 放行", () => {
    for (const action of ["ask", "answer_ask", "withdraw_ask", "mark_ready"]) expect(hostPolicy("codex", "autocrew_content", { action }, true)).toEqual({ ok: true });
  });
});

describe("发布（§7-4..7）", () => {
  const check = (id: string, plan: unknown, jev = fakeJev().caller) => executePublishCheck({ _dataDir: env.dir, content_id: id, plan }, { jev });

  it("R20 每个平台只留当前一组检查（旧的被取代、不出条目）；检查绑轮次", async () => {
    const r = await registeredVideo(env);
    const first = await check(r.id, planOf(r, [planEntry(r, "douyin", ["3:4"])]));
    await new Promise((ok) => setTimeout(ok, 5));
    const second = await check(r.id, planOf(r, [planEntry(r, "douyin", ["3:4"])]));
    const list = (await items(r.id)).filter((i) => i.type === "publish_check");
    expect(list).toHaveLength(1);
    const ids = (x: Record<string, unknown>) => (x.platforms as Array<{ check_id: string }>)[0].check_id;
    expect(list[0].detail.check_id).toBe(ids(second));
    expect(ids(first)).not.toBe(ids(second));
    const rec = JSON.parse(await fs.readFile(path.join(r.root, "06-publish/checks", `${ids(second)}.json`), "utf8"));
    expect(rec.round).toBe(1);
  });

  it("「没问题」只记一笔（不是硬门）；破例 = 用你的原话重跑出新检查，旧检查不改", async () => {
    const r = await registeredVideo(env);
    await check(r.id, planOf(r, [planEntry(r, "xiaohongshu", ["4:3"])]));
    const it0 = (await items(r.id)).find((i) => i.type === "publish_check")!;
    expect(it0.detail.verdict).toBe("block");
    const oldId = String(it0.detail.check_id);
    const oldRaw = await fs.readFile(path.join(r.root, "06-publish/checks", `${oldId}.json`), "utf8");
    const out = await decideItem({ content_id: r.id, item_id: it0.item_id, gen: it0.gen, action: "publish_check_override", note: "这次横版就行" }, env.dir, { jev: fakeJev().caller });
    expect(out).toMatchObject({ ok: true, rerun_of: oldId });
    expect(out.check_id).not.toBe(oldId);
    expect(await fs.readFile(path.join(r.root, "06-publish/checks", `${oldId}.json`), "utf8")).toBe(oldRaw);
    const rec = JSON.parse(await fs.readFile(path.join(r.root, "06-publish/checks", `${String(out.check_id)}.json`), "utf8"));
    expect(rec).toMatchObject({ rerun_of: oldId, inputs: { overrides: expect.arrayContaining([expect.objectContaining({ founder_quote: "这次横版就行", source: "founder" })]) } });
    const it1 = (await items(r.id)).find((i) => i.type === "publish_check")!;
    expect(it1.detail.check_id).toBe(out.check_id);
    expect(await decideItem({ content_id: r.id, item_id: it1.item_id, gen: it1.gen, action: "publish_check_confirm" }, env.dir)).toMatchObject({ ok: true });
    expect((await items(r.id)).filter((i) => i.type === "publish_check")).toEqual([]);
    expect((await doc(r.id)).decisions.find((d) => d.type === "publish_check_confirm")).toMatchObject({ check_id: out.check_id });
  });

  it("R21 「发了吗」按平台槽：一个平台发了，另一个照样问", async () => {
    const r = await registeredVideo(env);
    await fs.mkdir(path.join(r.root, "06-publish"), { recursive: true });
    await fs.writeFile(path.join(r.root, "06-publish/publish-plan.json"), JSON.stringify(planOf(r, [planEntry(r, "douyin", ["3:4"]), planEntry(r, "bilibili", ["4:3"])])));
    const asks = async () => (await items(r.id)).filter((i) => i.type === "published_ask").map((i) => i.detail.platform);
    expect((await asks()).sort()).toEqual(["bilibili", "douyin"]);
    const dy = (await items(r.id)).find((i) => i.type === "published_ask" && i.detail.platform === "douyin")!;
    expect(await decideItem({ content_id: r.id, item_id: dy.item_id, gen: dy.gen, action: "i_published" }, env.dir)).toMatchObject({ ok: true });
    expect(await asks()).toEqual(["bilibili"]);
  });

  it("「Claude 说已经发了」：agent 的说法是条目，创始人点「对，发了」", async () => {
    const r = await registeredVideo(env);
    await record(env, { content_id: r.id, kind: "publish", platform: "douyin", url: "https://example.com/v/1", request_id: "pub" }, "claude-code");
    const it0 = (await items(r.id)).find((i) => i.type === "publish_claim")!;
    expect(it0.summary).toBe("Claude说已经发了（抖音）");
    expect(await decideItem({ content_id: r.id, item_id: it0.item_id, gen: it0.gen, action: "confirm_receipt" }, env.dir)).toMatchObject({ ok: true, stage: "已发布" });
  });

  it("「还差一步」：两项批准有效但缺这版字幕", async () => {
    const c = await editing();
    const cut = await markedCut(c.id);
    await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, "a.png"), png(900, 1200)), await put(path.join(env.chatcut, "b.png"), png(1200, 900))], cover_text: "字", request_id: "g" });
    await waiveSliverCheck(env, c.id, cut.sha);
    await decide(c.id, "approve_cut", { fact_id: cut.fact_id, sha256: cut.sha }, env.dir);
    const cover = (await items(c.id)).find((i) => i.type === "cover_pick")!;
    expect(await decideItem({ content_id: c.id, item_id: cover.item_id, gen: cover.gen, action: "pick_cover", group_id: cover.actions[0].params!.group_id }, env.dir)).toMatchObject({ ok: true });
    expect((await items(c.id)).find((i) => i.type === "register_blocked")).toMatchObject({ summary: "还差一步才能发：缺这版成片的字幕", actions: [{ label: "让 Codex 补" }] });
  });
});

describe("稿子写好了（§3.1）", () => {
  it("认稿走列表：稿子没问题 → 认稿；还要改 → 退回修改并记一句", async () => {
    const a = await videoContent(env, "稿子一");
    const b = await videoContent(env, "稿子二");
    const ia = (await itemOf(`draft:${a.id}`))!;
    expect(await decideItem({ content_id: a.id, item_id: ia.item_id, gen: ia.gen, action: "approve_script" }, env.dir)).toMatchObject({ ok: true });
    expect((await getContent(a.id, env.dir))!.status).toBe("approved");
    const ib = (await itemOf(`draft:${b.id}`))!;
    expect(await decideItem({ content_id: b.id, item_id: ib.item_id, gen: ib.gen, action: "revise_script" }, env.dir)).toMatchObject({ ok: false, code: "note_required" });
    expect(await decideItem({ content_id: b.id, item_id: ib.item_id, gen: ib.gen, action: "revise_script", note: "开头换一句" }, env.dir)).toMatchObject({ ok: true });
    expect((await getContent(b.id, env.dir))!.status).toBe("revision");
  });
});
