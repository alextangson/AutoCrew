/**
 * 同一 request_id 并发两次（Codex 审 aef8eb37 P2-2 的遗留保证）：第一个还在核字节时第二个进来，只能记一次。
 * 核字节那一步换成可控的闸门，确定地造出这个时序。
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";

let calls = 0;
let gate: Promise<void> = Promise.resolve();
/** 在锁里、decideItem 之前插一手（模拟 locate 之后、锁里的那一刻条目变了） */
let midway: (() => Promise<void>) | null = null;
vi.mock("./files.js", async (orig) => {
  const m = await orig<typeof import("./files.js")>();
  return { ...m, verifyFacts: async (...a: Parameters<typeof m.verifyFacts>) => { if (++calls === 1) await gate; if (midway) await midway(); return m.verifyFacts(...a); } };
});

const { executeReviewInbox } = await import("../../../tools/review-inbox.js");
const { readInbox } = await import("../inbox-read.js");
const { readProductionDoc } = await import("../../../storage/production-store.js");
const { founderApprove, makeEnv, png, put, record, videoContent } = await import("../testkit.js");
const { decide } = await import("../inbox-decide.js");
type Env = Awaited<ReturnType<typeof makeEnv>>;

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); calls = 0; midway = null; });
afterEach(async () => { await env.cleanup(); });

it("同一 request_id 并发两次：第二个回 in_progress，只记一个决定", async () => {
  const c = await videoContent(env, "并发测试");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "并发测试-原片.mov"), "raw"), request_id: "a" });
  await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, "a.png"), png(900, 1200, "a")), await put(path.join(env.chatcut, "b.png"), png(1200, 900, "b"))], cover_text: "字", request_id: "g" });
  const it0 = (await readInbox(env.dir)).items.find((i) => i.type === "cover_pick")!;
  const p = { _dataDir: env.dir, _host: "claude-code", action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: "dup-1" };
  let open!: () => void;
  gate = new Promise((ok) => { open = ok; });
  const first = executeReviewInbox(p);
  const second = await executeReviewInbox(p);
  open();
  expect(await first).toMatchObject({ ok: true });
  expect(second).toMatchObject({ ok: false, code: "in_progress" });
  expect((await readProductionDoc(c.id, env.dir))!.decisions.filter((d) => d.type === "cover_approval")).toHaveLength(1);
});

async function coverReady(title: string) {
  const c = await videoContent(env, title);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${title}-原片.mov`), "raw"), request_id: "a" });
  const g = await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, "a.png"), png(900, 1200, "a")), await put(path.join(env.chatcut, "b.png"), png(1200, 900, "b"))], cover_text: "字", request_id: "g" });
  const it0 = (await readInbox(env.dir)).items.find((i) => i.type === "cover_pick")!;
  return { c, g, it0 };
}

it("P2-4 锁里代次变了 → stale 带新的样子", async () => {
  const { c, it0 } = await coverReady("锁里变了");
  midway = async () => {
    midway = null;
    await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, "c.png"), png(900, 1200, "c")), await put(path.join(env.chatcut, "d.png"), png(1200, 900, "d"))], cover_text: "字", request_id: "g2" });
  };
  const r = await executeReviewInbox({ _dataDir: env.dir, action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", group_id: (it0.detail.groups as Array<{ group_id: string }>)[0].group_id, founder_words: "行", request_id: "mid-1" });
  expect(r).toMatchObject({ ok: false, code: "stale", item: { item_id: it0.item_id } });
});

it("P2-4 锁里被网页定了 → already_handled", async () => {
  const { c, g, it0 } = await coverReady("锁里被定");
  midway = async () => { midway = null; expect(await decide(c.id, "retire_cover_group", { group_id: g.group_id, item_id: it0.item_id, gen: it0.gen }, env.dir)).toMatchObject({ ok: true }); };
  const r = await executeReviewInbox({ _dataDir: env.dir, action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: "mid-2" });
  expect(r).toMatchObject({ ok: false, code: "already_handled" });
});
