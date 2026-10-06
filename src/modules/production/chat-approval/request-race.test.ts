/**
 * Codex 审 aef8eb37 P2-2：同一 request_id 并发两次，第一个弹完窗、第二个还在核字节——第二个不能再弹一个窗。
 * 核字节那一步换成可控的闸门，确定地复现这个时序；弹窗与 open 用假的。
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";

let calls = 0;
let gate: Promise<void> = Promise.resolve();
vi.mock("./files.js", async (orig) => {
  const m = await orig<typeof import("./files.js")>();
  return { ...m, verifyFacts: async (...a: Parameters<typeof m.verifyFacts>) => { if (++calls === 2) await gate; return m.verifyFacts(...a); } };
});

const { setPullDeps } = await import("../../video/handoff/pull-deps.js");
const { executeReviewInbox } = await import("../../../tools/review-inbox.js");
const { readInbox } = await import("../inbox-read.js");
const { resetSlotForTest } = await import("./requests.js");
const { founderApprove, makeEnv, png, put, record, videoContent } = await import("../testkit.js");
type Env = Awaited<ReturnType<typeof makeEnv>>;

let env: Env;
let asked = 0;
beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  calls = 0; asked = 0;
  resetSlotForTest();
  setPullDeps({ dialog: { ask: async () => { asked++; return { kind: "cancel" }; }, choose: async () => ({ kind: "cancel" }), input: async () => ({ kind: "cancel" }) }, opener: async () => ({ ok: true }) });
});
afterEach(async () => { setPullDeps(null); await env.cleanup(); });

it("P2-2 同一 request_id 并发两次：只弹一个窗", async () => {
  const c = await videoContent(env, "并发测试");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "并发测试-原片.mov"), "raw"), request_id: "a" });
  await record(env, { content_id: c.id, kind: "cover", paths: [await put(path.join(env.chatcut, "a.png"), png(900, 1200, "a")), await put(path.join(env.chatcut, "b.png"), png(1200, 900, "b"))], cover_text: "字", request_id: "g" });
  const it0 = (await readInbox(env.dir)).items.find((i) => i.type === "cover_pick")!;
  const p = { _dataDir: env.dir, _host: "claude-code", action: "confirm", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", founder_words: "行", request_id: "dup-1" };
  let open!: () => void;
  gate = new Promise((ok) => { open = ok; });
  const second = executeReviewInbox(p).then((r) => r);
  const first = executeReviewInbox(p);
  // 让第一个调用走完（弹窗 → 取消）时，第二个还卡在核字节
  const firstResult = await Promise.race([first, second]);
  open();
  const results = [firstResult, await first, await second];
  expect(asked).toBe(1);
  expect(results.map((r) => r.code)).toContain("dialog_busy");
});
