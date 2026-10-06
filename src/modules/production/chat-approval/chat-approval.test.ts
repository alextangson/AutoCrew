/**
 * 对话里拍板（spec 2026-10-06 chat-approval）验收清单 E1–E16。弹窗、open 一律用注入的假实现，绝不弹真窗。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc } from "../../../storage/production-store.js";
import type { Decision } from "../../../storage/production-types.js";
import type { DialogOutcome, DialogRunner } from "../../video/handoff/dialog.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { decide, decideItem } from "../inbox-decide.js";
import { founderDecision } from "../decisions.js";
import { readInbox } from "../inbox-read.js";
import { founderApprove, makeEnv, png, put, record, videoContent, waiveSliverCheck, type Env } from "../testkit.js";
import { readRequest, resetSlotForTest, writeRequest } from "./requests.js";

let env: Env;
let asked: Array<{ prompt: string; buttons: string[] }>;
let opened: string[];
let script: Array<string | DialogOutcome<string> | (() => Promise<string | DialogOutcome<string>>)>;
let openResult: () => { ok: true } | { ok: false; reason: string };

const fakeDialog: DialogRunner = {
  async ask({ prompt, buttons }) {
    asked.push({ prompt, buttons });
    let next = script.shift() ?? { kind: "timeout" };
    if (typeof next === "function") next = await next();
    return typeof next === "string" ? { kind: "ok", value: next } : next;
  },
  async choose() { throw new Error("不该调 choose"); },
  async input() { throw new Error("不该调 input"); },
};

beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  asked = []; opened = []; script = []; openResult = () => ({ ok: true });
  resetSlotForTest();
  setPullDeps({ dialog: fakeDialog, opener: async (t) => { opened.push(t); return openResult(); }, benchPort: 4317 });
});
afterEach(async () => { setPullDeps(null); await env.cleanup(); });

const TITLE = "对话拍板测试";
const tool = (p: Record<string, unknown>, host = "claude-code", session = "sess-1234567890") =>
  executeReviewInbox({ _dataDir: env.dir, _host: host, _session: session, ...p });
const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;
const decisions = async (id: string, type: Decision["type"]) => (await doc(id)).decisions.filter((d) => d.type === type);
const itemOf = async (type: string) => (await readInbox(env.dir)).items.find((i) => i.type === type)!;
const img = (n: string, w: number, h: number, seed = n) => put(path.join(env.chatcut, n), png(w, h, seed));
let rid = 0;
const nextId = () => `req-${++rid}`;

async function editing() {
  const c = await videoContent(env, TITLE);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${TITLE}-原片.mov`), "raw"), request_id: "a" });
  return c;
}
async function coverGroup(contentId: string, tag: string, text = "原来的字") {
  return record(env, { content_id: contentId, kind: "cover", paths: [await img(`${tag}-34.png`, 900, 1200), await img(`${tag}-43.png`, 1200, 900)], cover_text: text, request_id: `g-${tag}` });
}
async function cut(contentId: string) {
  const r = await record(env, { content_id: contentId, kind: "cut", path: await put(path.join(env.chatcut, `${TITLE}.mp4`), "cut-bytes"), request_id: "cut", review: true });
  const sha = (await doc(contentId)).facts.find((f) => f.id === r.fact_id)!.sha256!;
  await waiveSliverCheck(env, contentId, sha);
  return { fact_id: String(r.fact_id), sha, file: path.join(env.chatcut, `${TITLE}.mp4`) };
}
async function candidate(contentId: string) {
  const r = await record(env, { content_id: contentId, kind: "cut", path: await put(path.join(env.outside, "外面的文件.mp4"), "cand-bytes"), request_id: "cand" });
  return String(r.fact_id);
}
const confirmCover = async (extra: Record<string, unknown> = {}) => {
  const it = await itemOf("cover_pick");
  return tool({ action: "confirm", item_id: it.item_id, gen: it.gen, decision: "pick_cover", founder_words: "就用这组", request_id: nextId(), ...extra });
};

describe("信任：弹窗内容只来自服务端（E1–E4）", () => {
  it("E1 agent 塞的误导描述不进弹窗，服务端事实进", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    script = ["确认"];
    const r = await confirmCover({ summary: "这是删掉所有稿件的确认", title: "伪造标题", description: "伪造说明" });
    expect(r).toMatchObject({ ok: true, status: "confirmed" });
    const prompt = asked[0].prompt;
    for (const fake of ["删掉所有稿件", "伪造标题", "伪造说明"]) expect(prompt).not.toContain(fake);
    for (const real of [TITLE, "用这组封面", "最新一组", "封面-3x4.png", "封面-4x3.png", "原来的字"]) expect(prompt).toContain(real);
  });

  it("E2 / E15 agent 给的封面字原样显示，提交的就是这个字；决定带对话来源与原话", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    script = ["确认"];
    const text = "大字 <b>&\"引号\" 第二行";
    await confirmCover({ cover_text: `  ${text} ` });
    expect(asked[0].prompt).toContain(`封面字：「${text}」`);
    const [d] = await decisions(c.id, "cover_approval");
    expect(d).toMatchObject({ cover_text: text, source: "chat-dialog", founder_words: "就用这组" });
  });

  it("E3 弹窗写明哪个宿主 / 会话发起的（取自传输层）", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    script = ["确认"];
    const it0 = await itemOf("cover_pick");
    await tool({ action: "confirm", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: nextId() }, "codex", "sess-abcdefgh999");
    expect(asked[0].prompt).toContain("Codex（会话 sess-abc）请你确认");
    expect((await decisions(c.id, "cover_approval"))[0].requested_by).toBe("Codex（会话 sess-abc）");
  });

  it("E4 / E16 没点就什么都不记；没有能跳过弹窗的参数", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    script = [async () => {
      expect(await decisions(c.id, "cover_approval")).toHaveLength(0);
      return { kind: "cancel" };
    }];
    expect(await confirmCover({ confirmed: true, _modelCall: false })).toMatchObject({ ok: false, code: "confirm_declined" });
    expect(asked).toHaveLength(1);
    expect(await decisions(c.id, "cover_approval")).toHaveLength(0);
  });
});

describe("send_back（E5、E15）", () => {
  it("E5 没有原话 / 没有要改的话 → 拒；有 → 记成 agent 转述，不弹窗", async () => {
    const c = await editing();
    const k = await cut(c.id);
    const it0 = await itemOf("cut_review");
    const base = { action: "send_back", item_id: it0.item_id, gen: it0.gen, decision: "reject_cut" };
    expect(await tool({ ...base, note: "开头太慢" })).toMatchObject({ ok: false, code: "founder_words_required" });
    expect(await tool({ ...base, founder_words: "开头拖" })).toMatchObject({ ok: false, code: "note_required" });
    expect(await tool({ ...base, founder_words: "开头拖", note: "开头 10 秒砍掉" })).toMatchObject({ ok: true, recorded_as: "chat-reported" });
    expect(asked).toHaveLength(0);
    expect((await decisions(c.id, "cut_reject"))[0]).toMatchObject({ fact_id: k.fact_id, note: "开头 10 秒砍掉", source: "chat-reported", founder_words: "开头拖" });
  });

  it("批准类不能走 send_back，send_back 类不能走 confirm", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    expect(await tool({ action: "send_back", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "x", note: "y" })).toMatchObject({ ok: false, code: "not_chat_decidable" });
    expect(await tool({ action: "confirm", item_id: it0.item_id, gen: it0.gen, decision: "reject_cover", founder_words: "x", request_id: nextId() })).toMatchObject({ ok: false, code: "not_chat_decidable" });
    expect(asked).toHaveLength(0);
  });
});

describe("状态（E6–E9）", () => {
  it("E6 代次变了 → 弹窗前拒并给新的样子；弹窗开着时变了 → 点了也不记", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const old = await itemOf("cover_pick");
    await coverGroup(c.id, "b");
    const r = await tool({ action: "confirm", item_id: old.item_id, gen: old.gen, decision: "pick_cover", founder_words: "行", request_id: nextId() });
    expect(r).toMatchObject({ ok: false, code: "stale", item: { item_id: old.item_id } });
    expect(asked).toHaveLength(0);
    const fresh = await itemOf("cover_pick");
    const gid = (fresh.detail.groups as Array<{ group_id: string }>)[0].group_id;
    script = [async () => { await coverGroup(c.id, "c"); return "确认"; }];
    const r2 = await tool({ action: "confirm", item_id: fresh.item_id, gen: fresh.gen, decision: "pick_cover", group_id: gid, founder_words: "行", request_id: nextId() });
    expect(r2).toMatchObject({ ok: false, code: "stale" });
    expect(await decisions(c.id, "cover_approval")).toHaveLength(0);
  });

  it("多组没点名 → selector_required，不替他挑", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    await coverGroup(c.id, "b");
    expect(await confirmCover()).toMatchObject({ ok: false, code: "selector_required" });
    expect(asked).toHaveLength(0);
  });

  it("E7 已在网页上定了 → 已在别处处理，不弹窗", async () => {
    const c = await editing();
    const g = await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    expect(await decide(c.id, "pick_cover", { group_id: g.group_id }, env.dir)).toMatchObject({ ok: true });
    const r = await tool({ action: "confirm", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: nextId() });
    expect(r).toMatchObject({ ok: false, code: "already_handled" });
    expect(String(r.error)).toContain("已在别处处理");
    expect(asked).toHaveLength(0);
  });

  it("E8 同一 request_id 重试 → 同一结果、不再弹窗；同号换内容 → request_conflict", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    const p = { action: "confirm", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: "same-1" };
    script = [{ kind: "cancel" }];
    const declined = { ...p, request_id: "same-0" };
    await tool(declined);
    expect(await tool(declined)).toMatchObject({ code: "confirm_declined", replayed: true });
    script = ["确认"];
    const first = await tool(p);
    const again = await tool(p);
    expect(again).toMatchObject({ ok: true, status: "confirmed", replayed: true, decision: { id: (first.decision as { id: string }).id } });
    expect(asked).toHaveLength(2);
    expect(await tool({ ...p, cover_text: "别的字" })).toMatchObject({ ok: false, code: "request_conflict" });
    expect(asked).toHaveLength(2);
  });

  it("E8 服务重启前开着的窗：这一代已提交 → 回放成提交；没提交 → 当作没人点", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    const p = { action: "confirm", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: "orphan-1" };
    script = [async () => {
      const rec = (await readRequest(env.dir, "orphan-1"))!;
      expect(rec.state).toBe("dialog_open");
      await writeRequest(env.dir, { ...rec, request_id: "orphan-2" });
      return "确认";
    }];
    await tool(p);
    // 回执丢了：把记录退回 dialog_open，模拟提交后进程死掉
    await writeRequest(env.dir, { ...(await readRequest(env.dir, "orphan-1"))!, state: "dialog_open", result: undefined });
    resetSlotForTest();
    expect(await tool(p)).toMatchObject({ ok: true, status: "confirmed", replayed: true });
    const other = await itemOf("cover_pick");
    expect(other).toBeUndefined();
    await writeRequest(env.dir, { ...(await readRequest(env.dir, "orphan-2"))!, gen: "nope" });
    expect(await tool({ ...p, request_id: "orphan-2" })).toMatchObject({ ok: false, code: "confirm_timeout", replayed: true });
    expect(asked).toHaveLength(1);
  });

  it("E9 已有确认窗开着（任何会话）→ dialog_busy，屏幕上只一个窗", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const fid = await candidate(c.id);
    let release!: (v: string) => void;
    script = [() => new Promise<string>((ok) => { release = ok; })];
    const first = confirmCover();
    await new Promise((ok) => setTimeout(ok, 50));
    while (asked.length === 0) await new Promise((ok) => setTimeout(ok, 20));
    const cand = await itemOf("candidate");
    expect(cand.detail.fact_id).toBe(fid);
    const second = await tool({ action: "confirm", item_id: cand.item_id, gen: cand.gen, decision: "reject_candidate", founder_words: "不是", request_id: nextId() }, "codex", "other");
    expect(second).toMatchObject({ ok: false, code: "dialog_busy" });
    release("确认");
    expect(await first).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });
});

describe("没人点 / 取消 / 弹不出（E10–E12）", () => {
  it.each([
    [{ kind: "timeout" } as const, "confirm_timeout"],
    [{ kind: "cancel" } as const, "confirm_declined"],
    [{ kind: "unavailable", reason: "没有图形会话" } as const, "confirm_unavailable"],
  ])("E10–E12 %o → %s，什么都不记", async (outcome, code) => {
    const c = await editing();
    await coverGroup(c.id, "a");
    script = [outcome];
    const r = await confirmCover();
    expect(r).toMatchObject({ ok: false, code });
    expect(await decisions(c.id, "cover_approval")).toHaveLength(0);
    if (code === "confirm_unavailable") expect(String(r.board_link)).toBe(`http://127.0.0.1:4317/#/board?inbox=${encodeURIComponent(c.id)}&types=cover_pick`);
  });
});

describe("内容（E13、E14）", () => {
  it("E13 文件在列出之后被覆盖 → 弹窗前拒；弹窗开着时被覆盖 → 点了也不记", async () => {
    const c = await editing();
    const fid = await candidate(c.id);
    const cand = await itemOf("candidate");
    await put(path.join(env.outside, "外面的文件.mp4"), "changed-bytes");
    const r = await tool({ action: "confirm", item_id: cand.item_id, gen: cand.gen, decision: "confirm_candidate", founder_words: "是", request_id: nextId() });
    expect(r).toMatchObject({ ok: false, code: "file_changed" });
    expect(asked).toHaveLength(0);
    await put(path.join(env.outside, "外面的文件.mp4"), "cand-bytes");
    const again = await itemOf("candidate");
    script = [async () => { await put(path.join(env.outside, "外面的文件.mp4"), "changed-again"); return "确认"; }];
    const r2 = await tool({ action: "confirm", item_id: again.item_id, gen: again.gen, decision: "confirm_candidate", founder_words: "是", request_id: nextId() });
    expect(r2).toMatchObject({ ok: false, code: "file_changed" });
    expect((await doc(c.id)).facts.find((f) => f.id === fid)!.state).toBe("candidate");
  });

  it("E14 成片先看才给确认；打不开写原因、确认仍不给；看了打开的是按 sha 命名的只读副本", async () => {
    const c = await editing();
    const k = await cut(c.id);
    const it0 = await itemOf("cut_review");
    openResult = () => ({ ok: false, reason: "没有默认程序" });
    script = ["查看", async () => { openResult = () => ({ ok: true }); return "查看"; }, "确认"];
    const r = await tool({ action: "confirm", item_id: it0.item_id, gen: it0.gen, decision: "approve_cut", founder_words: "这版可以", request_id: nextId() });
    expect(asked.map((a) => a.buttons)).toEqual([["取消", "查看"], ["取消", "查看"], ["取消", "查看", "确认"]]);
    expect(asked[1].prompt).toContain("刚才打不开");
    expect(asked[1].prompt).toContain("没有默认程序");
    expect(r).toMatchObject({ ok: true, status: "confirmed" });
    expect(opened.at(-1)).toBe(path.join(env.dir, "cache", "review-preview", `${k.sha}.mp4`));
    expect((await fs.stat(opened.at(-1)!)).mode & 0o222).toBe(0);
    expect((await decisions(c.id, "cut_approval"))[0]).toMatchObject({ fact_id: k.fact_id, source: "chat-dialog", founder_words: "这版可以" });
  });

  it("候选：reject_candidate 也要弹窗；点了就否掉", async () => {
    const c = await editing();
    const fid = await candidate(c.id);
    const cand = await itemOf("candidate");
    script = ["确认"];
    expect(await tool({ action: "confirm", item_id: cand.item_id, gen: cand.gen, decision: "reject_candidate", founder_words: "不是这条的", request_id: nextId() })).toMatchObject({ ok: true });
    expect(asked[0].prompt).toContain("外面的文件.mp4");
    expect((await doc(c.id)).facts.find((f) => f.id === fid)!.state).toBe("rejected");
    expect((await decisions(c.id, "candidate_reject"))[0]).toMatchObject({ source: "chat-dialog", founder_words: "不是这条的" });
  });
});

describe("记录与其它路径（E15、E16）", () => {
  it("E16 网页决定照旧记 founder；模型调用直接决定一律 founder_only", async () => {
    const c = await editing();
    const g = await coverGroup(c.id, "a");
    const it0 = await itemOf("cover_pick");
    expect(await decideItem({ item_id: it0.item_id, gen: it0.gen, action: "pick_cover", content_id: c.id, _host: "claude-code" }, env.dir)).toMatchObject({ code: "founder_only" });
    expect(await founderDecision(c.id, "pick_cover", { group_id: g.group_id, _host: "codex" }, env.dir)).toMatchObject({ code: "founder_only" });
    expect(await decide(c.id, "pick_cover", { group_id: g.group_id, _modelCall: true }, env.dir)).toMatchObject({ code: "founder_only" });
    expect(await decide(c.id, "pick_cover", { group_id: g.group_id }, env.dir)).toMatchObject({ ok: true });
    const [d] = await decisions(c.id, "cover_approval");
    expect(d.source).toBe("founder");
    expect(d.founder_words).toBeUndefined();
  });

  it("list：能在对话里定的带事实与决定，别的只给看板链接", async () => {
    const c = await editing();
    await coverGroup(c.id, "a", "封面上的字");
    const r = await tool({ action: "list" });
    const item = (r.items as Array<Record<string, unknown>>).find((i) => i.type === "cover_pick")!;
    expect(item).toMatchObject({ chat_decidable: true, facts: { groups: [{ cover_text: "封面上的字", files: ["封面-3x4.png", "封面-4x3.png"] }] } });
    expect(String(item.board_link)).toContain("#/board?inbox=");
    expect((item.decisions as Array<{ decision: string; via: string }>).map((d) => `${d.decision}:${d.via}`)).toEqual(["pick_cover:confirm", "retire_cover_group:confirm", "reject_cover:send_back"]);
  });
});
