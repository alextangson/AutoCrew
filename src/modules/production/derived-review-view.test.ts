import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeEnEdition } from "../../tools/en-edition.js";
import { executeWechatArticle } from "../../tools/wechat-article.js";
import { enSourceVideo, SEGMENTS } from "../en-edition/en-test-fixtures.js";
import { readInbox } from "./inbox-read.js";
import { decideItem } from "./inbox-decide.js";
import { derivedReview } from "./derived-review-view.js";
import type { Env } from "./testkit.js";

let env: Env;
let srcId: string;
beforeEach(async () => { const s = await enSourceVideo(["douyin", "youtube", "wechat_mp"]); env = s.env; srcId = s.id; });
afterEach(async () => { await env.cleanup(); });

const draftOf = async (id: string) => (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === id);
const deriveEn = async () => String((await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: srcId })).content_id);

describe("派生稿认稿面板的数据", () => {
  it("英文版：没写脚本时照实说原因；写了脚本给逐段中英对照，认稿件带 derived", async () => {
    const id = await deriveEn();
    expect(await derivedReview(id, env.dir)).toMatchObject({ ok: false, code: "no_script" });
    expect(await executeEnEdition({ _dataDir: env.dir, op: "set_script", content_id: id, segments: SEGMENTS })).toMatchObject({ ok: true });
    const v = await derivedReview(id, env.dir);
    if (!v.ok || v.kind !== "en_edition") throw new Error(JSON.stringify(v));
    expect(v.segments).toHaveLength(3);
    expect(v.segments[1]).toMatchObject({ zh: expect.stringContaining("腾讯"), en: expect.stringContaining("Tariq"), swaps: [expect.objectContaining({ from: "腾讯的同事", factual: false })] });
    expect(v.segments[2].keyword).toBe("the opposite");
    expect((await draftOf(id))?.detail).toMatchObject({ derived: "en_edition", package_hash: v.hash });
  });

  it("英文版：给他看之后脚本变了 → 拒；批过再点一次 → 回放上一次的结果，不批第二次", async () => {
    const id = await deriveEn();
    await executeEnEdition({ _dataDir: env.dir, op: "set_script", content_id: id, segments: SEGMENTS });
    const shown = (await draftOf(id))!;
    await executeEnEdition({ _dataDir: env.dir, op: "set_script", content_id: id, segments: SEGMENTS.map((s, i) => (i === 0 ? { ...s, en: "Honestly. Harder task, higher setting." } : s)) });
    expect(await decideItem({ item_id: shown.item_id, gen: shown.gen, action: "approve_script", content_id: id }, env.dir)).toMatchObject({ ok: false });
    const fresh = (await draftOf(id))!;
    expect(fresh.gen).not.toBe(shown.gen);
    expect(await decideItem({ item_id: fresh.item_id, gen: fresh.gen, action: "approve_script", content_id: id }, env.dir)).toMatchObject({ ok: true });
    expect(await decideItem({ item_id: fresh.item_id, gen: fresh.gen, action: "approve_script", content_id: id }, env.dir)).toMatchObject({ ok: true, replayed: true });
    expect(await draftOf(id)).toBeUndefined();
  });

  it("公众号文章：给标题、正文和还差什么；不是派生稿就说不是", async () => {
    const r = await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: srcId });
    expect(r).toMatchObject({ ok: true });
    expect(await derivedReview(String(r.content_id), env.dir)).toMatchObject({ ok: true, kind: "wechat_article" });
    expect(await derivedReview(srcId, env.dir)).toMatchObject({ ok: false, code: "not_derived" });
  });
});
