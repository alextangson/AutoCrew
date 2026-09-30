/**
 * 等你拍板 2a-1 Codex 第二轮会审 4 条 P2 的回归（~/.cache/autocrew-yt/review-inbox/codex-review-2a1-r2.txt）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { executeContentSave } from "../../tools/content-save.js";
import { founderDecision } from "./decisions.js";
import { decideItem } from "./inbox-decide.js";
import { readInbox } from "./inbox-read.js";
import { scopedId } from "./inbox.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;
const items = async (id: string) => (await readInbox(env.dir, { contentId: id })).items;
const agent = (p: Record<string, unknown>) => executeContentSave({ _dataDir: env.dir, _host: "codex", ...p }) as Promise<Record<string, unknown>>;
async function editing(title = "二轮回归") {
  const c = await videoContent(env, title);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${title}-原片.mov`), "raw"), request_id: "a" });
  return c;
}
const img = (n: string, w: number, h: number) => put(path.join(env.chatcut, n), png(w, h, n));

describe("Codex 2a-1 第二轮 P2", () => {
  it("R2-1 请求参数改不了条目绑定的对象：A 的代次不能拿去确认 B", async () => {
    const c = await editing();
    const a = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.outside, "a.mp4"), "cut-a"), request_id: "ca" });
    const b = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.outside, "b.mp4"), "cut-b"), request_id: "cb" });
    const d = await doc(c.id);
    const shaB = d.facts.find((f) => f.id === b.fact_id)!.sha256;
    const itA = (await items(c.id)).find((i) => i.item_id === scopedId(i.content_id ?? "", `cand:${a.fact_id}`))!;
    const r = await decideItem({ content_id: c.id, item_id: itA.item_id, gen: itA.gen, action: "reject_candidate", fact_id: b.fact_id, sha256: shaB }, env.dir);
    expect(r).toMatchObject({ ok: true });
    const after = await doc(c.id);
    expect(after.facts.find((f) => f.id === b.fact_id)!.state).toBe("candidate");
    expect(after.facts.find((f) => f.id === a.fact_id)!.state).toBe("rejected");
  });

  it("R2-1 「这组不要了」只能作废这个条目清单里的组，不能借它的代次作废别的组", async () => {
    const c = await editing();
    const g = await record(env, { content_id: c.id, kind: "cover", paths: [await img("a.png", 900, 1200), await img("b.png", 1200, 900)], cover_text: "字", request_id: "g" });
    const lone = await record(env, { content_id: c.id, kind: "cover", path: await img("x.png", 900, 1200), request_id: "x" });
    const it = (await items(c.id)).find((i) => i.type === "cover_pick")!;
    expect(await decideItem({ content_id: c.id, item_id: it.item_id, gen: it.gen, action: "retire_cover_group", group_id: lone.group_id }, env.dir)).toMatchObject({ ok: false, code: "stale" });
    expect((await doc(c.id)).decisions.some((d) => d.type === "cover_group_retire")).toBe(false);
    void g;
  });

  it("R2-2 预算吃紧时摘要仍留至少一条请示（已答的在前）和翻页游标", async () => {
    const title = "很长的标题".repeat(20);
    const c = await editing(title);
    for (let i = 0; i < 3; i++) {
      const q = await agent({ action: "ask", content_id: c.id, request_id: `q${i}`, kind: ["粗剪", "样片", "配乐"][i], question: "问一下".repeat(40), options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }] });
      const it = (await items(c.id)).find((x) => x.item_id === scopedId(x.content_id ?? "", `ask:${q.ask_id}`))!;
      await decideItem({ content_id: c.id, item_id: it.item_id, gen: it.gen, action: "answer_ask", option_id: "ok", note: "回答".repeat(30) }, env.dir);
    }
    const s = await agent({ action: "summary", id: c.id });
    expect(Buffer.byteLength(JSON.stringify(s))).toBeLessThanOrEqual(1536);
    expect((s.asks as Array<{ state: string }>).length).toBeGreaterThanOrEqual(1);
    expect((s.asks as Array<{ state: string; option_id?: string }>)[0]).toMatchObject({ state: "answered", option_id: "ok" });
    const seen = new Set((s.asks as Array<{ ask_id: string }>).map((x) => x.ask_id));
    let next = s.asks_next_offset as number | undefined;
    while (next !== undefined) {
      const p = await agent({ action: "summary", id: c.id, asks_offset: next });
      for (const x of p.asks as Array<{ ask_id: string }>) seen.add(x.ask_id);
      next = p.asks_next_offset as number | undefined;
    }
    expect(seen.size).toBe(3);
    void projectRoot;
  });

  it("R2-2 翻页途中有请示被答复：每件恰好出现一次（稳定顺序 = 发起时间 + id）", async () => {
    const c = await editing();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const q = await agent({ action: "ask", content_id: c.id, request_id: `w${i}`, kind: ["粗剪", "样片", "配乐", "花费", "其他"][i], question: `第${i}件`, options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }] });
      ids.push(q.ask_id as string);
    }
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let answered = false;
    while (offset !== undefined) {
      const p = await agent({ action: "summary", id: c.id, asks_offset: offset });
      for (const x of p.asks as Array<{ ask_id: string }>) seen.push(x.ask_id);
      if (!answered) {
        const last = ids[4];
        const it = (await items(c.id)).find((x) => x.item_id === scopedId(x.content_id ?? "", `ask:${last}`))!;
        await decideItem({ content_id: c.id, item_id: it.item_id, gen: it.gen, action: "answer_ask", option_id: "ok" }, env.dir);
        answered = true;
      }
      offset = p.asks_next_offset as number | undefined;
    }
    expect(seen.sort()).toEqual([...ids].sort());
    const s = await agent({ action: "summary", id: c.id, asks_offset: 3 });
    expect((s.asks as Array<{ ask_id: string; state: string }>).at(-1)).toMatchObject({ ask_id: ids[4], state: "answered" });
    await agent({ action: "answer_ask", content_id: c.id, ask_id: ids[0], option_id: "ok", founder_quote: "行" });
    const s0 = await agent({ action: "summary", id: c.id });
    expect((s0.asks as Array<{ state: string }>)[0].state).toBe("reported");
  });

  it("R2-3 已批 [A,B] 时，新组 [A,C] 可以作废（按批准的组保护，不按共用的一张图）", async () => {
    const c = await editing();
    const a = await img("a.png", 900, 1200);
    const g1 = await record(env, { content_id: c.id, kind: "cover", paths: [a, await img("b.png", 1200, 900)], cover_text: "字", request_id: "g1" });
    await founderDecision(c.id, "pick_cover", { group_id: g1.group_id }, env.dir);
    const g2 = await record(env, { content_id: c.id, kind: "cover", paths: [a, await img("c.png", 1200, 900)], cover_text: "字", request_id: "g2" });
    expect(await founderDecision(c.id, "retire_cover_group", { group_id: g2.group_id }, env.dir)).toMatchObject({ ok: true });
    expect(await founderDecision(c.id, "retire_cover_group", { group_id: g1.group_id }, env.dir)).toMatchObject({ ok: false, code: "cover_group_approved" });
  });

  it("R2-4 分镜请示的额外附件变了 → 拒答", async () => {
    const c = await editing();
    const crypto = await import("node:crypto");
    const h = (b: string) => crypto.createHash("sha256").update(b).digest("hex");
    const dir = path.join(projectRoot(env, c.id), "03-broll/review-v001");
    await put(path.join(dir, "boards/B01.svg"), "<svg>b</svg>");
    const html = `<html><img src="boards/B01.svg"></html>`;
    await put(path.join(dir, "review.html"), html);
    await put(path.join(dir, "review.receipt.json"), JSON.stringify({ manifest_sha256: "m", media: [{ item: "B01", path: "boards/B01.svg", sha256: h("<svg>b</svg>") }], html_sha256: h(html) }));
    const sb = await record(env, { content_id: c.id, kind: "storyboard", path: "03-broll/review-v001/review.html", request_id: "sb" });
    const extra = await put(path.join(projectRoot(env, c.id), "04-edit/note.png"), png(10, 10));
    const q = await agent({ action: "ask", content_id: c.id, request_id: "q", kind: "分镜", question: "分镜行吗", fact_id: sb.fact_id, attachments: [extra], options: [{ id: "approve", label: "通过" }, { id: "no", label: "不行" }] });
    await put(extra, png(10, 10, "changed"));
    const it = (await items(c.id)).find((x) => x.item_id === scopedId(x.content_id ?? "", `ask:${q.ask_id}`))!;
    expect(await decideItem({ content_id: c.id, item_id: it.item_id, gen: it.gen, action: "answer_ask", option_id: "approve" }, env.dir)).toMatchObject({ ok: false, code: "attachments_changed" });
  });
});
