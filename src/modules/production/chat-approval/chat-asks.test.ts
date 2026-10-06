/**
 * 请示在对话里答（spec 2026-10-06 proactive-chat-review，Addendum：agent asks are chat-decidable）：每条一个测试。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HUMAN_WRITE } from "../../../storage/first-body-guard.js";
import { readProductionDoc } from "../../../storage/production-store.js";
import { executeContentSave } from "../../../tools/content-save.js";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { STORYBOARD_APPROVE } from "../asks.js";
import { setSettleMs } from "../hash-cache.js";
import { readInbox } from "../inbox-read.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, type Env } from "../testkit.js";
import { chatReviewLine } from "./present.js";
import { setPreviewDeps } from "./preview.js";

let env: Env;
let pane: string;
let opened: Array<{ file: string; app: string }>;
beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  setPullDeps({ benchPort: 4317 });
  pane = path.join(env.dir, "..", "session");
  await fs.mkdir(pane, { recursive: true });
  opened = [];
  setPreviewDeps({ open: async (file, app) => { opened.push({ file, app }); } });
});
afterEach(async () => { setSettleMs(null); setPreviewDeps(null); setPullDeps(null); await env.cleanup(); });

const TITLE = "请示对话测试";
type Item = { item_id: string; gen: string; type: string; chat_decidable: boolean; brief: string; decisions: Array<{ decision: string }>; preview?: { files: Array<{ path: string }>; pages?: Array<{ path: string; opened: boolean; reason: string }> } };
const agent = (p: Record<string, unknown>, host = "codex") => executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: host, ...p }) as Promise<Record<string, unknown>>;
const tool = (p: Record<string, unknown>) => executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "s1", ...p });
const askItem = async (p: Record<string, unknown> = {}) => ((await tool({ action: "list", ...p })).items as Item[]).find((i) => i.type === "ask")!;
let rid = 0;
const decideAsk = (it: Item, extra: Record<string, unknown>) => tool({ action: "decide", item_id: it.item_id, gen: it.gen, decision: "answer_ask", founder_words: "行", request_id: `r-${++rid}`, ...extra });

async function editing() {
  const c = await videoContent(env, TITLE);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${TITLE}-原片.mov`), "raw"), request_id: "a" });
  return c;
}
const OPTIONS = [{ id: "ok", label: "可以，就这样" }, { id: "redo", label: "再改改" }];
const ask = (contentId: string, extra: Record<string, unknown> = {}) =>
  agent({ action: "ask", content_id: contentId, request_id: `q-${++rid}`, kind: "粗剪", question: "粗剪这样行吗？", options: OPTIONS, ...extra });

describe("请示在对话里能定（Addendum 第 1 条）", () => {
  it.each(["粗剪", "花费", "分镜外的其他"])("%s 请示 chat_decidable，开场那行也数它", async (kind) => {
    const c = await editing();
    expect(await ask(c.id, { kind: kind === "分镜外的其他" ? "其他" : kind })).toMatchObject({ ok: true });
    const it0 = await askItem();
    expect(it0.chat_decidable).toBe(true);
    expect(it0.decisions.map((d) => d.decision)).toEqual(["answer_ask"]);
    expect(await chatReviewLine(env.dir)).toContain("有 1 件");
  });
});

describe("brief（第 2 条）", () => {
  it("谁问的、原问题、编号选项原文、附件名", async () => {
    const c = await editing();
    const img = await put(path.join(projectRoot(env, c.id), "04-edit/rough.png"), png(10, 10));
    await ask(c.id, { attachments: [img] });
    const b = (await askItem()).brief;
    expect(b).toContain("Codex请示（粗剪）：粗剪这样行吗？");
    expect(b).toContain("1. 可以，就这样\n2. 再改改");
    expect(b).toContain("附件：rough.png");
  });

  it("花费：钱数与用途照原话写进 brief", async () => {
    const c = await editing();
    const q = "要花 38.5 元生成 6 段 B-roll 视频（Kling 按次计费），花吗？";
    await ask(c.id, { kind: "花费", question: q });
    expect((await askItem()).brief).toContain(`要花的钱和花在哪（照它的原话）：「${q}」`);
  });

  it("多个选项没给 option_id（只说「行」）→ 拒，让 agent 先问，什么都不记", async () => {
    const c = await editing();
    await ask(c.id);
    const r = await decideAsk(await askItem(), {});
    expect(r).toMatchObject({ ok: false, code: "selector_required" });
    expect((await readProductionDoc(c.id, env.dir))!.decisions.some((d) => d.type === "ask_answer")).toBe(false);
  });
});

describe("decide（第 3 条）", () => {
  it("answer_ask 走创始人回答：source chat、原话、补充话存成 note", async () => {
    const c = await editing();
    const q = await ask(c.id);
    const r = await decideAsk(await askItem(), { option_id: "redo", note: "第 3 组换成办公室的镜头", founder_words: "第 2 个，第 3 组换成办公室的镜头" });
    expect(r).toMatchObject({ ok: true, recorded_as: "chat" });
    const d = (await readProductionDoc(c.id, env.dir))!;
    expect(d.decisions.find((x) => x.type === "ask_answer")).toMatchObject({ source: "chat", option_id: "redo", note: "第 3 组换成办公室的镜头", founder_words: "第 2 个，第 3 组换成办公室的镜头" });
    expect(d.asks!.find((a) => a.id === q.ask_id)!.answer).toMatchObject({ via: "founder", option_id: "redo" });
  });

  it("分镜请示：提交时仍核分镜，「还在写」的拒绝照样回来；稳定了就通过", async () => {
    const c = await editing();
    const r = await makeReview(projectRoot(env, c.id));
    await record(env, { content_id: c.id, kind: "storyboard", path: r.file, request_id: "sb" });
    const fact = (await readProductionDoc(c.id, env.dir))!.facts.find((x) => x.kind === "storyboard")!;
    await agent({ action: "ask", content_id: c.id, request_id: "sbq", kind: "分镜", question: "12 组分镜行不行", storyboard_fact_id: fact.id, options: [{ id: STORYBOARD_APPROVE, label: "通过" }, { id: "redo", label: "重做" }] });
    setSettleMs(60_000);
    const now = new Date();
    await fs.utimes(path.join(r.dir, "B01.svg"), now, now);
    const it0 = await askItem();
    expect(await decideAsk(it0, { option_id: STORYBOARD_APPROVE })).toMatchObject({ ok: false, code: "file_unsettled" });
    setSettleMs(0);
    const ok = await decideAsk(await askItem(), { option_id: STORYBOARD_APPROVE });
    expect(ok).toMatchObject({ ok: true, storyboard_approved: true });
    expect((await readProductionDoc(c.id, env.dir))!.decisions.find((d) => d.type === "storyboard_approval")).toMatchObject({ source: "chat" });
  });
});

describe("附件（第 4 条）", () => {
  it("图片进会话文件夹；网页用默认浏览器打开原文件并给绝对路径；打不开也说", async () => {
    const c = await editing();
    const pr = projectRoot(env, c.id);
    const img = await put(path.join(pr, "04-edit/rough.png"), png(10, 10));
    const page = await put(path.join(pr, "03-broll/review-v001/review.html"), "<html><img src='B01.svg'></html>");
    await ask(c.id, { attachments: [img, page] });
    const it0 = await askItem({ preview_dir: pane });
    expect(it0.preview!.files[0].path).toMatch(/^review-preview\/.+请示-rough\.png$/);
    expect(it0.preview!.pages![0]).toMatchObject({ path: await fs.realpath(page).catch(() => page), opened: true });
    expect(opened).toEqual([{ file: it0.preview!.pages![0].path, app: "" }]);
    setPreviewDeps({ open: async () => { throw new Error("没有浏览器"); } });
    const it1 = await askItem({ preview_dir: pane });
    expect(it1.preview!.pages![0]).toMatchObject({ opened: false, reason: expect.stringContaining("没有浏览器") });
  });
});

describe("附件变过（第 5 条）", () => {
  it("只给 ask_resend；answer_ask 不收；ask_resend 能记", async () => {
    const c = await editing();
    const file = await put(path.join(projectRoot(env, c.id), "04-edit/rough.png"), png(10, 10));
    await ask(c.id, { attachments: [file] });
    await put(file, png(10, 10, "changed"));
    const it0 = await askItem();
    expect(it0.decisions.map((d) => d.decision)).toEqual(["ask_resend"]);
    expect(it0.brief).toContain("回我「让 Codex 重发」");
    expect(await decideAsk(it0, { option_id: "ok" })).toMatchObject({ ok: false, code: "not_chat_decidable" });
    expect(await tool({ action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "ask_resend", founder_words: "让它重发", request_id: "resend" })).toMatchObject({ ok: true });
  });
});

describe("agent 转述那条路不变（第 6 条）", () => {
  it("agent 转述的回答仍是 agent_reported、带撤回窗，不进对话可定；花费仍不收转述", async () => {
    const c = await editing();
    const q = await ask(c.id);
    expect(await agent({ action: "answer_ask", content_id: c.id, ask_id: q.ask_id, option_id: "ok", founder_quote: "行" })).toMatchObject({ ok: true });
    const d = (await readProductionDoc(c.id, env.dir))!;
    expect(d.asks!.find((a) => a.id === q.ask_id)!.answer).toMatchObject({ via: "agent_reported" });
    const rep = (await readInbox(env.dir)).items.find((i) => i.type === "ask_reported")!;
    expect(rep.actions.map((a) => a.action)).toContain("undo_ask_answer");
    expect(((await tool({ action: "list" })).items as Item[]).find((i) => i.type === "ask_reported")!.chat_decidable).toBe(false);
    const money = await ask(c.id, { kind: "花费", question: "花 10 元？" });
    expect(await agent({ action: "answer_ask", content_id: c.id, ask_id: money.ask_id, option_id: "ok", founder_quote: "行" })).toMatchObject({ ok: false });
  });
});

const sha = (b: string) => crypto.createHash("sha256").update(b).digest("hex");
/** 脚本产出的分镜审阅页（与 storyboard.test 的造法一致，素材放在页面旁边） */
async function makeReview(pr: string) {
  const dir = path.join(pr, "03-broll", "review-v001");
  const bytes = "<svg>B01</svg>";
  await put(path.join(dir, "B01.svg"), bytes);
  const html = `<html><body>分镜<img src="B01.svg" alt="B01"></body></html>`;
  await put(path.join(dir, "review.html"), html);
  await put(path.join(dir, "review.receipt.json"), JSON.stringify({ manifest: "/gone/display.json", manifest_sha256: "m", media: [{ item: "B01", path: "B01.svg", sha256: sha(bytes) }], html_sha256: sha(html), approval_created: false }));
  return { dir, file: path.join(dir, "review.html") };
}
