/**
 * verifier 补的边界（2026-09-27 真机验收后）：§12.4-B/C/D、§12.5、§12.6、§13.4-F。
 * 弹窗与转写全用假的，绝不弹真窗；媒体用真 ffmpeg 合成。
 *
 * 故意保留失败的用例 = 发现（实现与 spec 不符），不改断言去迁就实现。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { callVideo, HAS_FFMPEG, makeFixture, makeMp4, seedAccepted, type HandoffFixture } from "./handoff-testkit.js";
import { initializeProjectLayout } from "../../../storage/content-project.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { saveCoverage } from "./project-evidence.js";
import { setPullDeps } from "./pull-deps.js";
import { arollLockOf } from "./pull-store.js";
import { sha256File } from "./manifest.js";
import type { DialogRunner } from "./dialog.js";

let fx: HandoffFixture;
let shown: Array<{ kind: string; prompt: string }> = [];

beforeEach(async () => {
  fx = await makeFixture();
  await fs.unlink(path.join(fx.dir, "video.json"));
  await initializeProjectLayout(fx.dir, "lib-deadbeef", "default");
  shown = [];
  const dialog: DialogRunner = {
    choose: async (o) => { shown.push({ kind: "choose", prompt: o.prompt }); return { kind: "ok", value: o.items[0] }; },
    ask: async (o) => { shown.push({ kind: "ask", prompt: o.prompt }); return { kind: "ok", value: "确认" }; },
    input: async (o) => { shown.push({ kind: "input", prompt: o.prompt }); return { kind: "timeout" }; },
  };
  setPullDeps({ dialog, transcriber: { transcribe: async () => ({ ok: false, unavailable: true, reason: "测试不转写" }) } });
});
afterEach(async () => { setPullDeps(null); await fx.cleanup(); });

const TITLE = "你每天纠正 AI 同一件事？它根本不会从纠正里学";

async function cite(c: Content): Promise<Content> {
  const first = c.body.slice(0, c.body.indexOf("。") + 1);
  await saveCoverage(c, { draft_hash: draftHash(c), citations: [{ start: 0, end: first.length, excerpt: first, evidence_id: "creator", sourceType: "creator_opinion", quote: "", verification: "亲历" }], reviewed_by: "writer", reviewed_at: new Date().toISOString() }, fx.dir);
  return (await getContent(c.id, fx.dir))!;
}

const codex = (params: Record<string, unknown>) => callVideo(fx.dir, params, "codex");
const match = (aroll: string, requestId: string) => codex({ action: "match", aroll_path: aroll, request_id: requestId });
const confirm = (receiptId: unknown, requestId: string, extra: Record<string, unknown> = {}) =>
  codex({ action: "confirm", receipt_id: receiptId, cover_text: "AI 不会从纠正里学", target_seconds: 480, request_id: requestId, ...extra });
const handoff = (c: Content, aroll: string, cfm: unknown, requestId: string) =>
  codex({ action: "handoff", content_id: c.id, aroll_path: aroll, confirmation_id: cfm, request_id: requestId });

describe.skipIf(!HAS_FFMPEG)("verifier 补边界", () => {
  // 真机复现（preview :4318，2026-09-27 22:12）：confirm 先弹「录的是哪一条稿？」列表，创始人选完才回 missing_citations。
  // spec §12.4-C：「服务端核回执有效……再按当前稿实时核材料（A）。然后在创始人的 GUI 会话里弹窗」——材料不齐不该打扰创始人。
  it("confirm：只有一条候选且缺出处时，先拒 missing_citations，一个弹窗都不弹", async () => {
    await seedAccepted(fx.dir, TITLE);
    const aroll = await makeMp4(path.join(fx.outside, `${TITLE} take 2.mov`));
    const m = await match(aroll, "m-1");
    expect(m).toMatchObject({ ok: true, candidates: [expect.objectContaining({ layer: "l1" })] });
    const res = await confirm(m.receipt_id, "c-1");
    expect(res).toMatchObject({ ok: false, code: "missing_citations" });
    expect(shown).toEqual([]);
  });

  // spec §12.6「失败可见：回执丢失 → 凭请求号取回」；真机上同 request_id 重发 match 签出了新回执（rcpt-mujw7nso → rcpt-mujwf3rj）。
  it("match：同一 request_id 重发拿回同一张回执，不另签", async () => {
    await seedAccepted(fx.dir, TITLE);
    const aroll = await makeMp4(path.join(fx.outside, `${TITLE}.mov`));
    const first = await match(aroll, "m-same");
    const again = await match(aroll, "m-same");
    expect(again.receipt_id).toBe(first.receipt_id);
  });

  it("confirm 同 request_id 重放：交接用掉确认之后重放仍回同一条记录、不再弹窗；拿它换新 request_id 交接被拒 confirmation_used", async () => {
    const c = await cite(await seedAccepted(fx.dir, TITLE));
    const aroll = await makeMp4(path.join(fx.outside, `${TITLE} take 2.mov`));
    const m = await match(aroll, "m-1");
    const first = await confirm(m.receipt_id, "c-1");
    expect(first).toMatchObject({ ok: true, status: "confirmed" });
    const dialogs = shown.length;
    const h = await handoff(c, aroll, first.confirmation_id, "h-1");
    expect(h).toMatchObject({ ok: true, claim_token: expect.stringMatching(/^clm-/) });
    const replay = await confirm(m.receipt_id, "c-1", { cover_text: "换一个封面字" });
    expect(replay).toMatchObject({ ok: true, replayed: true, confirmation_id: first.confirmation_id, cover_text: "AI 不会从纠正里学" });
    expect(shown.length).toBe(dialogs);
    const reuse = await handoff(c, String(h.aroll_moved_to), first.confirmation_id, "h-2");
    expect(reuse).toMatchObject({ ok: false });
    expect(JSON.stringify(reuse)).not.toContain(String(h.claim_token));
  });

  it("全链：交接后原片挪进 02-aroll 原名；第二个 Codex 拿挪后的文件 match → already_handed_off；撤回挪回原处、放锁，再 match 正常出回执", async () => {
    const c = await cite(await seedAccepted(fx.dir, TITLE));
    const name = `${TITLE} take 2.mov`;
    const aroll = await makeMp4(path.join(fx.outside, name));
    const sha = await sha256File(aroll);
    const m = await match(aroll, "m-1");
    const cfm = await confirm(m.receipt_id, "c-1");
    const h = await handoff(c, aroll, cfm.confirmation_id, "h-1");
    const moved = path.join(String(h.project_root), "02-aroll", name);
    expect(h).toMatchObject({ ok: true, aroll_moved_to: moved });
    expect(await sha256File(moved)).toBe(sha);
    await expect(fs.access(aroll)).rejects.toThrow();
    expect(await arollLockOf(fx.dir, sha)).toMatchObject({ content_id: c.id, generation: 1 });

    const second = await match(moved, "m-2");
    expect(second).toMatchObject({ status: "already_handed_off", holder: { content_id: c.id, generation: 1 } });
    expect(second.receipt_id).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain(String(h.claim_token));

    const replay = await handoff(c, aroll, cfm.confirmation_id, "h-1");
    expect(replay).toMatchObject({ replayed: true, claim_token: h.claim_token });

    const revoked = await codex({ action: "revoke", content_id: c.id, claim_token: h.claim_token });
    expect(revoked).toMatchObject({ ok: true, status: "revoked", aroll_restored_to: aroll });
    expect(await sha256File(aroll)).toBe(sha);
    await expect(fs.access(moved)).rejects.toThrow();
    expect(await arollLockOf(fx.dir, sha)).toBeNull();
    expect((await getContent(c.id, fx.dir))!.status).toBe("draft_ready");

    const after = await match(aroll, "m-3");
    expect(after).toMatchObject({ ok: true, receipt_id: expect.stringMatching(/^rcpt-/) });
    expect(after.status).not.toBe("already_handed_off");
    const stale = await handoff(c, aroll, cfm.confirmation_id, "h-3");
    expect(stale).toMatchObject({ ok: false });
  });

  // spec §12.6「无音轨、超过 30 分钟 → aroll_invalid」。09-27 修复后在 match 当场拒（不签回执），创始人不会先白点弹窗。
  it("无音轨原片：match 当场拒 aroll_invalid、不签回执；原片留在原处、不占锁", async () => {
    const c = await cite(await seedAccepted(fx.dir, TITLE));
    const aroll = await makeMp4(path.join(fx.outside, `${TITLE}.mov`), { audio: false });
    const sha = await sha256File(aroll);
    const m = await match(aroll, "m-1");
    expect(m).toMatchObject({ ok: false, code: "aroll_invalid" });
    expect(m.receipt_id).toBeUndefined();
    await expect(fs.access(aroll)).resolves.toBeUndefined();
    expect(await arollLockOf(fx.dir, sha)).toBeNull();
    expect((await getContent(c.id, fx.dir))!.status).toBe("draft_ready");
  });
});
