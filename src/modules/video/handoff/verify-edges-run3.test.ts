/**
 * verifier 第三轮真机验收（preview :4318，2026-09-28 09:49–10:00）补的边界。
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
import { executeDesk } from "../../../tools/desk.js";
import type { DialogRunner } from "./dialog.js";

let fx: HandoffFixture;

beforeEach(async () => {
  fx = await makeFixture();
  await fs.unlink(path.join(fx.dir, "video.json"));
  await initializeProjectLayout(fx.dir, "lib-deadbeef", "default");
  const dialog: DialogRunner = {
    choose: async (o) => ({ kind: "ok", value: o.items[0] }),
    ask: async () => ({ kind: "ok", value: "确认" }),
    input: async () => ({ kind: "timeout" }),
  };
  setPullDeps({ dialog, transcriber: { transcribe: async () => ({ ok: false, unavailable: true, reason: "测试不转写" }) } });
});
afterEach(async () => { setPullDeps(null); await fx.cleanup(); });

const TITLE = "你每天纠正 AI 同一件事？它根本不会从纠正里学";
const SESSION = "codex-session-1";
const codex = (params: Record<string, unknown>) => callVideo(fx.dir, { _session: SESSION, ...params }, "codex");

async function cited(): Promise<Content> {
  const c = await seedAccepted(fx.dir, TITLE);
  const first = c.body.slice(0, c.body.indexOf("。") + 1);
  await saveCoverage(c, { draft_hash: draftHash(c), citations: [{ start: 0, end: first.length, excerpt: first, evidence_id: "creator", sourceType: "creator_opinion", quote: "", verification: "亲历" }], reviewed_by: "writer", reviewed_at: new Date().toISOString() }, fx.dir);
  return (await getContent(c.id, fx.dir))!;
}

let seq = 0;
/** match → confirm → handoff，同一个 Codex 会话发起 */
async function pull(c: Content, aroll: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const n = ++seq;
  const m = await codex({ action: "match", aroll_path: aroll, request_id: `m-${n}` });
  const cfm = await codex({ action: "confirm", receipt_id: m.receipt_id, cover_text: "AI 不会从纠正里学", target_seconds: 480, request_id: `c-${n}` });
  expect(cfm).toMatchObject({ ok: true, status: "confirmed" });
  return codex({ action: "handoff", content_id: c.id, aroll_path: aroll, confirmation_id: cfm.confirmation_id, request_id: `h-${n}`, ...extra });
}

describe.skipIf(!HAS_FFMPEG)("verifier 第三轮补边界：Codex 认稿自接后撤回，认领落到谁手上", () => {
  // 真机复现（2026-09-28 09:54）：Codex 自接 g1 → Codex 带令牌 revoke → 回执里多了一枚 claim_token，
  // meta.claim 变成 {employee:"writer", host:"codex", 租约 30 分钟}。此时写稿侧 Claude
  // autocrew_desk claim{employee:"writer"} 回 claim_held「这篇正由 codex 处理（写手，还剩 30 分钟）」。
  // 撤回回执自己说「改完稿重新 handoff」，改稿的是写稿侧；自接流程里写稿侧早已 release，
  // 撤回却把写手认领交给了 Codex（revoke.ts returnClaim：input.host === record.by 就转成 writer 认领给发起方）。
  it("Codex 撤回自接的交接后，写稿侧 Claude 能立刻认领写手桌", async () => {
    const c = await cited();
    const aroll = await makeMp4(path.join(fx.outside, `${TITLE} take 3.mov`));
    const h = await pull(c, aroll);
    expect(h).toMatchObject({ ok: true, status: "handed_off", generation: 1 });
    const revoked = await codex({ action: "revoke", content_id: c.id, claim_token: h.claim_token });
    expect(revoked).toMatchObject({ ok: true, status: "revoked", content_status: "draft_ready" });
    const writer = await executeDesk({ _dataDir: fx.dir, _host: "claude-code", action: "claim", content_id: c.id, employee: "writer" });
    expect(writer).toMatchObject({ ok: true });
  });

  // 真机复现（2026-09-28 09:55）：同一个 Codex 会话 revoke 后重新 match + confirm（创始人又点了一次弹窗）+ handoff，
  // 不带 revoke 回执里那枚新令牌 → claim_held「这篇由同宿主的另一个会话认领着」。
  // 持有者 session 与调用方是同一个，文案说「另一个会话」是错的，会让 Codex 以为有别的会话抢活、去问创始人。
  // （要不要非带令牌才能重接，spec 没写，见报告的 spec 缺口；这里只钉文案不能说错人。）
  it("同一会话撤回后重接被拒时，不能说成「另一个会话」", async () => {
    const c = await cited();
    const aroll = await makeMp4(path.join(fx.outside, `${TITLE} take 3.mov`));
    const h = await pull(c, aroll);
    await codex({ action: "revoke", content_id: c.id, claim_token: h.claim_token });
    const again = await pull(c, aroll);
    if (again.ok) return; // 放行也符合预期：同一会话自己的认领不该挡自己
    expect(again.code).toBe("claim_held");
    expect(String(again.error)).not.toMatch(/另一个会话/);
  });

  it("对照：带上撤回回执里的新令牌重接，得到第 2 代", async () => {
    const c = await cited();
    const aroll = await makeMp4(path.join(fx.outside, `${TITLE} take 3.mov`));
    const h = await pull(c, aroll);
    const revoked = await codex({ action: "revoke", content_id: c.id, claim_token: h.claim_token });
    const again = await pull(c, aroll, { claim_token: revoked.claim_token });
    expect(again).toMatchObject({ ok: true, status: "handed_off", generation: 2 });
  });
});
