/** builder 修 verifier 发现时补的回归测试（公众号文章线） */
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceLedger } from "../research/evidence-ledger.js";
import { verifyNumbers } from "../writing/number-gate.js";
import { getContent } from "../../storage/local-store.js";
import { enSourceVideo, EN_SRT } from "../en-edition/en-test-fixtures.js";
import type { Env } from "../production/testkit.js";
import { executeWechatArticle } from "../../tools/wechat-article.js";
import { seedLedgerFromSourceTranscript, TRANSCRIPT_CLAIM } from "./transcript-evidence.js";

let env: Env;
afterEach(async () => { await env?.cleanup(); });

const SRT_370 = EN_SRT.replace("腾讯的同事刚发了一个测试", "同一批难题做了 370 次测试");

describe("number gate accepts numbers from the approved cut transcript", () => {
  it("370 次 from the source SRT passes and is recorded as a transcript line; other numbers stay blocked", async () => {
    const src = await enSourceVideo(["douyin", "wechat_mp"], SRT_370);
    env = src.env;
    const id = String((await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
    const ledger = createEvidenceLedger();
    expect(await seedLedgerFromSourceTranscript((await getContent(id, env.dir))!, ledger, env.dir)).toBe(1);
    const entry = ledger.entries()[0];
    expect(entry).toMatchObject({ source: "own_claim", claim: TRANSCRIPT_CLAIM });
    expect(entry.id).toBe(`srt:${src.id}:2`);
    const v = verifyNumbers({ title: "", hook: "", body: "实测做了 370 次测试，另外还有 999 次测试。", cta: "" }, ledger.entries());
    expect(v.verified.map((x) => x.mention.raw.replace(/\s/g, ""))).toEqual(["370次"]);
    expect(v.unverified.map((x) => x.raw.replace(/\s/g, ""))).toEqual(["999次"]);
  });

  it("a non-derived item gets nothing added", async () => {
    const src = await enSourceVideo(["douyin", "wechat_mp"], SRT_370);
    env = src.env;
    const ledger = createEvidenceLedger();
    expect(await seedLedgerFromSourceTranscript((await getContent(src.id, env.dir))!, ledger, env.dir)).toBe(0);
  });
});

describe("any body write on an approved derived article reopens it", () => {
  it("autocrew_content update body (model path) puts it back to draft_ready", async () => {
    const { executeContentSave } = await import("../../tools/content-save.js");
    const { setContent } = await import("../production/testkit.js");
    const src = await enSourceVideo(["douyin", "wechat_mp"]);
    env = src.env;
    const id = String((await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
    await setContent(env, id, { body: "旧正文", status: "approved" });
    expect(await executeContentSave({ _dataDir: env.dir, action: "update", id, body: "新正文" })).toMatchObject({ ok: true });
    expect((await getContent(id, env.dir))!.status).toBe("draft_ready");
  });
});
