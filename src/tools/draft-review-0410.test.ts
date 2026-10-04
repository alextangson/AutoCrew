/** Codex 审 main...HEAD（10-04 晚）逐条回归：每条先在修复前复现 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "./draft.js";
import { setQuoteFetch } from "../modules/draft/verify-quote.js";
import { contentTransaction, getContent } from "../storage/local-store.js";
import { draftHash } from "../storage/draft-hash.js";
import { finalizeByFounder } from "../modules/draft/draft-finalize.js";

let dir: string;
let page = "";
const BODY = "你是不是也觉得用了 AI 以后反而更忙了？省下来的时间，被你自己又填满了。可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的那段时间写进日历，标成不许约会。";
const ANGLE = { main_line: "AI 省下的时间会被你自己填满", for_whom: "职场人", opening: "你是不是也觉得更忙了？", why_viral: "同题材播放第一", chain: ["一", "二", "三", "四"], founder_words: "就这个" };
const run = (action: string, args: Record<string, unknown>) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });
async function written(): Promise<string> {
  const id = (await run("start", { inspiration: "AI 越用越忙" })).content_id as string;
  await run("angle", { content_id: id, base_version: 1, ...ANGLE });
  expect((await run("save", { content_id: id, base_version: 1, body: BODY })).ok).toBe(true);
  return id;
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-0410-"));
  page = "研究显示，有 37% 的人每天用 AI 写周报。详情 https://example.com/report 里还有别的。";
  setQuoteFetch(async (url) => ({ finalUrl: url, text: page }));
});
afterEach(async () => { setQuoteFetch(undefined); await fs.rm(dir, { recursive: true, force: true }); });

describe("P1 引文洗白：被替换成 [链接] 的区域里夹带的文字不能进台账", () => {
  it("引文里的链接段夹带数字 → 拒；台账里只有真核过的原文", async () => {
    const id = await written();
    const r = await run("verify_quote", { content_id: id, url: "https://example.com/r", quote: "详情 https://attacker.example/增长了999%" });
    expect(r.ok).toBe(false);
    expect((await getContent(id, dir))!.evidenceLedger?.entries ?? []).toEqual([]);
    expect(await run("verify_quote", { content_id: id, url: "https://example.com/r", quote: "有 37% 的人每天用 AI 写周报" })).toMatchObject({ ok: true });
  });
});

describe("P2 重新出清单要让工作台面板刷新", () => {
  it("稿已在等你认稿时再 prepare_final：稿件上的清单时间戳变了（面板按它重读）", async () => {
    const id = await written();
    await run("prepare_final", { content_id: id, base_version: 2, citations: [] });
    const before = (await getContent(id, dir))!;
    await new Promise((r) => setTimeout(r, 5));
    await run("prepare_final", { content_id: id, base_version: 2, citations: [] });
    const after = (await getContent(id, dir))!;
    expect(after.draftPath?.checklistAt).toBeDefined();
    expect(after.draftPath?.checklistAt).not.toBe(before.draftPath?.checklistAt);
  });
});

describe("P2 定了不能丢掉同时登记的证据", () => {
  it("finalize 期间 verify_quote 写进的 ev 条目保留", async () => {
    const id = await written();
    await run("prepare_final", { content_id: id, base_version: 2, citations: [] });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const hold = contentTransaction(id, dir, async (tx) => {
      await gate;
      const c = (await tx.read())!;
      await tx.write({ evidenceLedger: { entries: [...(c.evidenceLedger?.entries ?? []), { id: "ev-d9", source: "verified_quote", quote: "并发登记的", sourceUrl: "https://example.com/x" }], lookups: [], budget: { max: 0, used: 0 } } });
    });
    const fin = finalizeByFounder(id, { draftHash: draftHash((await getContent(id, dir))!), keep: [] }, dir);
    await new Promise((r) => setTimeout(r, 50));
    open();
    await hold;
    expect(await fin).toMatchObject({ ok: true });
    expect((await getContent(id, dir))!.evidenceLedger!.entries.map((e) => e.id)).toContain("ev-d9");
  });
});

describe("P2 结构化审稿意见：全形状校验与归一", () => {
  const verdicts = (over: Record<string, unknown> = {}) => ({ main_line: { verdict: "pass", reason: "清楚" }, payoff: { verdict: "fail", reason: "太虚", quotes: "今天就试一件事" }, opening: { verdict: "pass", reason: "抓人" }, ...over });
  it("quotes 是单个字符串 → 归一成数组存", async () => {
    const id = await written();
    expect(await run("save", { content_id: id, base_version: 2, body: BODY, review_notes: verdicts() })).toMatchObject({ ok: true });
    const note = (await getContent(id, dir))!.draftPath!.reviewNotes!.at(-1)!.notes as Record<string, { quotes: unknown }>;
    expect(note.payoff.quotes).toEqual(["今天就试一件事"]);
  });
  it.each([
    ["reason 是对象", { opening: { verdict: "pass", reason: { a: 1 } } }],
    ["建议不是数组", { advisories: 7 }],
    ["建议缺 text", { advisories: [{ quote: "x" }] }],
  ])("%s → bad_param", async (_l, over) => {
    const id = await written();
    expect(await run("save", { content_id: id, base_version: 2, body: BODY, review_notes: verdicts(over) })).toMatchObject({ ok: false, code: "bad_param" });
  });
});
