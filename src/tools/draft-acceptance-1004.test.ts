/** 创始人首次真机验收（10-04）找出的问题：清单噪音、示意 / 判断项、跨版本审稿记录、立意选项原文、审稿提示词。 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "./draft.js";
import { getContent } from "../storage/local-store.js";
import { finalizeByFounder } from "../modules/draft/draft-finalize.js";
import { draftHash } from "../storage/draft-hash.js";
import { normalizeMapping } from "../modules/draft/draft-final.js";
import { setQuoteFetch } from "../modules/draft/verify-quote.js";

let dir: string;
const PAD = "所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的那段时间写进日历，标成不许约会，坚持下去看看。别把它再还给别人的会议，也别还给刷不完的消息，那是你自己的时间。";
const ANGLE = { main_line: "AI 省下的时间会被你自己填满", for_whom: "职场人", opening: "你是不是也觉得更忙了？", why_viral: "同题材播放第一", chain: ["一", "二", "三", "四"], founder_words: "B" };
const run = (action: string, args: Record<string, unknown>) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });
async function written(body: string): Promise<string> {
  const id = (await run("start", { inspiration: "AI 越用越忙" })).content_id as string;
  await run("angle", { content_id: id, base_version: 1, ...ANGLE });
  expect((await run("save", { content_id: id, base_version: 1, body })).ok).toBe(true);
  return id;
}
const texts = (r: Record<string, unknown>) => (r.items as Array<{ text: string; status: string }>);
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-1004-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("清单噪音：相对时间和约数不算要出处的数字", () => {
  it("前两天 / 几个 / 很多 / 两三个 / 三年前 不进清单；17 分、52 人、67% 照进", async () => {
    const body = `前两天我刷到一条视频。有几个人问我。很多人觉得难。两三个同事也试了。三年前我开始做内容。他考了 17 分。有 52 人报名。占比 67%。${PAD}`;
    const id = await written(body);
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [] });
    const listed = texts(r).map((i) => i.text);
    expect(listed).toEqual(["他考了 17 分。", "有 52 人报名。", "占比 67%。"]);
  });
});

describe("citations.kind：示意 / 判断不列为没出处", () => {
  const body = `我编个例子，你团队有 52 人，每人每天省 2 小时。所以我的判断是，有 30% 的时间会被会议吃掉。有 17 家公司这么做了。${PAD}`;
  it("example / judgment 项 status=exempt，不计入 unsourced；定了不需要保留它们", async () => {
    const id = await written(body);
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [
      { text: "我编个例子，你团队有 52 人，每人每天省 2 小时。", evidence_ids: [], kind: "example" },
      { text: "所以我的判断是，有 30% 的时间会被会议吃掉。", evidence_ids: [], kind: "judgment" },
    ] });
    expect(r.unsourced).toBe(1);
    expect(texts(r).map((i) => i.status)).toEqual(["exempt", "exempt", "unsourced"]);
    expect((r.items as Array<{ kind?: string }>).map((i) => i.kind)).toEqual(["example", "judgment", undefined]);
    const c = (await getContent(id, dir))!;
    const blocked = await finalizeByFounder(id, { draftHash: draftHash(c), keep: [] }, dir);
    expect(blocked).toMatchObject({ ok: false, code: "unsourced_open" });
    const unsourcedId = (r.items as Array<{ id: string; status: string }>).find((i) => i.status === "unsourced")!.id;
    const done = await finalizeByFounder(id, { draftHash: draftHash(c), keep: [unsourcedId] }, dir);
    expect(done).toMatchObject({ ok: true });
  });
  it("kind 归一：字符串数组照解析；不认识的 kind → bad_param", async () => {
    expect(normalizeMapping(JSON.stringify([{ text: "x", evidence_ids: [], kind: "judgment" }]))).toEqual([{ text: "x", evidence_ids: [], kind: "judgment" }]);
    expect(normalizeMapping([{ text: "x", evidence_ids: [] }])).toEqual([{ text: "x", evidence_ids: [], kind: "claim" }]);
    const id = await written(body);
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [{ text: "x", evidence_ids: [], kind: "opinion" }] });
    expect(r).toMatchObject({ ok: false, code: "bad_param" });
  });
});

describe("跨版本审稿记录", () => {
  it("审稿附在第 2 版、定稿是第 3 版：prepare_final 仍报有审稿，并标「审的是第 2 版，之后又改过」", async () => {
    const id = await written(`有 52 人报名。${PAD}`);
    await run("save", { content_id: id, base_version: 2, body: `有 52 人报名。${PAD}`, review_notes: "主线过" });
    const v = (await getContent(id, dir))!.versions!.length;
    await run("save", { content_id: id, base_version: v, body: `有 52 人报名了。${PAD}` });
    const r = await run("prepare_final", { content_id: id, base_version: v + 1, citations: [] });
    expect(r.review).toMatchObject({ version: v + 1, has_notes: true, reviewed_version: v, current: false, note: `审的是第 ${v} 版，之后又改过` });
  });
});

describe("立意选项原文", () => {
  it("angle 带 chosen_option：存在稿上，创始人只回「B」也看得懂", async () => {
    const id = (await run("start", { inspiration: "AI 越用越忙" })).content_id as string;
    const full = "B：AI 省下的时间会被你自己填满——给职场人，开头「你是不是也觉得更忙了？」";
    expect((await run("angle", { content_id: id, base_version: 1, ...ANGLE, chosen_option: full })).ok).toBe(true);
    expect((await getContent(id, dir))!.draftPath?.angle).toMatchObject({ founder_words: "B", chosen_option: full });
  });
});

describe("Codex 审稿提示词", () => {
  it("不再写死外部资料处数；创始人点名要讲的材料不算抢主线；仍只有三项判据", async () => {
    const prompt = await fs.readFile(path.join(import.meta.dirname, "../../skills/write-script/codex-review-prompt.md"), "utf8");
    expect(prompt).not.toMatch(/最多(两|2)\s*处/);
    expect(prompt).toContain("创始人明确要求");
    expect(prompt.match(/^\d\. /gm)).toHaveLength(3);
  });
});

describe("定了：清单忽略的句子交接出处门照样过", () => {
  it("只有相对时间 / 约数的句子不进清单，定了也不报缺出处定位；citations.json 里记为不需要出处", async () => {
    const id = await written(`前两天我刷到一条视频。十几个人在用。${PAD}`);
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [] });
    expect(r.items).toEqual([]);
    const c = (await getContent(id, dir))!;
    expect(await finalizeByFounder(id, { draftHash: draftHash(c), keep: [] }, dir)).toMatchObject({ ok: true });
  });
});

describe("Codex review：示意 / 判断与约数不能洗白事实", () => {
  it("P1 只标半句判断：同句里的归因和 52 人照样要出处，不保留就定不了", async () => {
    const id = await written(`我觉得很棒，报告显示有 52 人报名。${PAD}`);
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [{ text: "我觉得很棒", evidence_ids: [], kind: "judgment" }] });
    expect(texts(r)[0]).toMatchObject({ status: "unsourced" });
    const c = (await getContent(id, dir))!;
    expect(await finalizeByFounder(id, { draftHash: draftHash(c), keep: [] }, dir)).toMatchObject({ ok: false, code: "unsourced_open" });
  });
  it("P1 整句标示意但句里有归因：示意不生效", async () => {
    const id = await written(`打个比方，据报道有家公司一天招了 52 人。${PAD}`);
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [{ text: "打个比方，据报道有家公司一天招了 52 人", evidence_ids: [], kind: "example" }] });
    expect(texts(r)[0]).toMatchObject({ status: "unsourced" });
  });
  it("P1 有具体数值的时长照列：两小时内、半小时；一半人拿不准也列", async () => {
    const id = await written(`两小时内就能做完。半小时就够了。差不多一半人都这样。前两天我刷到一条。${PAD}`);
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [] });
    expect(texts(r).map((i) => i.text)).toEqual(["两小时内就能做完。", "半小时就够了。", "差不多一半人都这样。"]);
  });
});

describe("Codex review P2：台账对得上的数字不能记成创作者自己的话", () => {
  afterEach(() => setQuoteFetch(undefined));
  const ledgered = async (body: string, quote: string) => {
    setQuoteFetch(async (url) => ({ finalUrl: url, text: `原文：${quote}。` }));
    const id = await written(body);
    expect(await run("verify_quote", { content_id: id, url: "https://example.com/r", quote })).toMatchObject({ ok: true });
    return id;
  };
  it("示意句里的 52 人在台账有出处：不再豁免，列出来；保留后能定", async () => {
    const id = await ledgered(`我编个例子，你团队有 52 人。${PAD}`, "这家公司有 52 人");
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [{ text: "我编个例子，你团队有 52 人。", evidence_ids: [], kind: "example" }] });
    expect(r.ok).toBe(true);
    const item = texts(r)[0] as { id: string; status: string };
    expect(item.status).toBe("unsourced");
    const c = (await getContent(id, dir))!;
    expect(await finalizeByFounder(id, { draftHash: draftHash(c), keep: [item.id] }, dir)).toMatchObject({ ok: true });
  });
  it("前两天 vs 台账「两天」：列出来，定了不再报 citations_invalid", async () => {
    const id = await ledgered(`前两天我刷到一条视频。${PAD}`, "只用了两天");
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [] });
    expect(r.ok).toBe(true);
    const item = texts(r)[0] as { id: string; status: string };
    expect(item).toMatchObject({ status: "unsourced" });
    const c = (await getContent(id, dir))!;
    expect(await finalizeByFounder(id, { draftHash: draftHash(c), keep: [item.id] }, dir)).toMatchObject({ ok: true });
  });
});

describe("Codex re-review P2", () => {
  it("空台账：示意句和另一句同为 52 人，预演的保留条目不能让示意句被拒；清单能出、保留后能定", async () => {
    const id = await written(`我编个例子，你团队有 52 人。有 52 人报名。${PAD}`);
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [{ text: "我编个例子，你团队有 52 人。", evidence_ids: [], kind: "example" }] });
    expect(r.ok).toBe(true);
    expect(texts(r).map((i) => i.status)).toEqual(["exempt", "unsourced"]);
    const kept = (r.items as Array<{ id: string; status: string }>).find((i) => i.status === "unsourced")!.id;
    const c = (await getContent(id, dir))!;
    expect(await finalizeByFounder(id, { draftHash: draftHash(c), keep: [kept] }, dir)).toMatchObject({ ok: true });
  });
  it("「前」只认相对时间：目前两小时 / 提前两小时 / 之前两天 都照列，两天前和这两天不列", async () => {
    const id = await written(`目前两小时就能完成。提前两小时到场。之前两天都在下雨。两天前我刷到一条。这两天特别忙。${PAD}`);
    const r = await run("prepare_final", { content_id: id, base_version: 2, citations: [] });
    expect(texts(r).map((i) => i.text)).toEqual(["目前两小时就能完成。", "提前两小时到场。", "之前两天都在下雨。"]);
  });
});
