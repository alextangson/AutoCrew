/**
 * Codex 发起交接（P6 §12.4-D）的不变量 eval：codex-handoff-needs-confirmation-record、token-only-to-initiator、
 * replay-no-token-leak、lost-response-recovers-token、replay-after-materials-change、aroll-lock-concurrent-pull、
 * aroll-lock-release-on-revoke、writer-claim-blocks-pull、editing-claim-no-idle-takeover。
 * 弹窗与转写全用假的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { callVideo, HAS_FFMPEG, makeFixture, makeMp4, seedAccepted, type HandoffFixture } from "./handoff-testkit.js";
import { contentFile, initializeProjectLayout } from "../../../storage/content-project.js";
import { getContent, updateContent, type Content } from "../../../storage/local-store.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { claimContent } from "../../../storage/claims.js";
import { withCallerSession } from "../../../runtime/run-log.js";
import { saveCoverage } from "./project-evidence.js";
import { founderProjectReview } from "./founder-review.js";
import { setPullDeps } from "./pull-deps.js";
import { arollLockOf } from "./pull-store.js";
import { sha256File } from "./manifest.js";
import { executeDesk } from "../../../tools/desk.js";
import { hashClaimToken } from "../../../storage/claim-token.js";

let fx: HandoffFixture;
let pick = "";
let takeoverAnswer = "取消";

beforeEach(async () => {
  fx = await makeFixture();
  await fs.unlink(path.join(fx.dir, "video.json"));
  await initializeProjectLayout(fx.dir, "lib-deadbeef", "default");
  setPullDeps({
    transcriber: { transcribe: async () => ({ ok: false, unavailable: true, reason: "测试不转写" }) },
    dialog: {
      choose: async (o) => ({ kind: "ok", value: o.items.find((i) => i.includes(pick)) ?? o.items[0] }),
      ask: async (o) => ({ kind: "ok", value: o.buttons.includes("接管") ? takeoverAnswer : "确认" }),
      input: async () => ({ kind: "timeout" }),
    },
  });
});
afterEach(async () => { setPullDeps(null); await fx.cleanup(); });

async function ready(title: string): Promise<Content> {
  const c = await seedAccepted(fx.dir, title);
  const first = c.body.slice(0, c.body.indexOf("。") + 1);
  await saveCoverage(c, { draft_hash: draftHash(c), citations: [{ start: 0, end: first.length, excerpt: first, evidence_id: "creator", sourceType: "creator_opinion", quote: "", verification: "亲历" }], reviewed_by: "writer", reviewed_at: new Date().toISOString() }, fx.dir);
  return (await getContent(c.id, fx.dir))!;
}

let seq = 0;
/** match + confirm（创始人在假弹窗里选 title） → confirmation_id */
async function confirmed(aroll: string, title: string): Promise<string> {
  pick = title;
  const m = await callVideo(fx.dir, { action: "match", aroll_path: aroll, request_id: `m-${++seq}` }, "codex");
  const c = await callVideo(fx.dir, { action: "confirm", receipt_id: m.receipt_id, cover_text: "封面", target_seconds: 60, request_id: `c-${seq}` }, "codex");
  if (!c.ok) throw new Error(JSON.stringify(c));
  return String(c.confirmation_id);
}

const pull = (c: Content, aroll: string, confirmationId: string, requestId: string) =>
  callVideo(fx.dir, { action: "handoff", content_id: c.id, aroll_path: aroll, confirmation_id: confirmationId, request_id: requestId }, "codex");

async function grep(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    if ((await fs.readFile(file)).includes(needle)) hits.push(file);
  }
  return hits;
}

describe.skipIf(!HAS_FFMPEG)("Codex 发起交接", () => {
  it("codex-handoff-needs-confirmation-record：没带、造的、用过的确认都不放行", async () => {
    const c = await ready("第一条长长的标题");
    const aroll = await makeMp4(path.join(fx.outside, "第一条长长的标题.mp4"));
    expect(await callVideo(fx.dir, { action: "handoff", content_id: c.id, aroll_path: aroll }, "codex")).toMatchObject({ ok: false, code: "confirmation_required" });
    expect(await pull(c, aroll, "cfm-made-up", "h-0")).toMatchObject({ ok: false, code: "confirmation_invalid" });
    const cfm = await confirmed(aroll, c.title);
    setPullDeps({ now: () => Date.now() + 31 * 60_000 });
    expect(await pull(c, aroll, cfm, "h-1")).toMatchObject({ ok: false, code: "confirmation_invalid" });
  });

  it("token-only-to-initiator + lost-response-recovers-token + replay-no-token-leak", async () => {
    const c = await ready("第一条长长的标题");
    const aroll = await makeMp4(path.join(fx.outside, "第一条长长的标题.mp4"));
    const cfm = await confirmed(aroll, c.title);
    const res = await pull(c, aroll, cfm, "h-1");
    expect(res).toMatchObject({ ok: true, status: "handed_off", content_status: "editing", claim_token: expect.stringMatching(/^clm-/) });
    const after = (await getContent(c.id, fx.dir))!;
    expect(after.claim).toMatchObject({ employee: "editor", host: "codex", token: hashClaimToken(String(res.claim_token)), heartbeat: true });
    expect(await grep(path.join(String(res.project_root), "01-script"), String(res.claim_token))).toEqual([]);
    const again = await pull(c, aroll, cfm, "h-1");
    expect(again).toMatchObject({ replayed: true, claim_token: res.claim_token, manifest_hash: res.manifest_hash });
    const other = await pull(c, aroll, cfm, "h-2");
    expect(other).toMatchObject({ ok: false, code: "confirmation_used", holder: { content_id: c.id, generation: 1 } });
    expect(JSON.stringify(other)).not.toContain(String(res.claim_token));
    setPullDeps({ now: () => Date.now() + 11 * 60_000 });
    const late = await pull(c, aroll, cfm, "h-1");
    expect(late).toMatchObject({ replayed: true, holder: { content_id: c.id, generation: 1 } });
    expect(late.claim_token).toBeUndefined();
  });

  it("replay-after-materials-change：重放按冻结结果，不读源文件、不重生成交接包", async () => {
    const c = await ready("第一条长长的标题");
    const aroll = await makeMp4(path.join(fx.outside, "第一条长长的标题.mp4"));
    const cfm = await confirmed(aroll, c.title);
    const res = await pull(c, aroll, cfm, "h-1");
    const bundle = path.join(String(res.project_root), "01-script/handoff/g0001/decisions.json");
    const frozen = await fs.readFile(bundle, "utf8");
    await fs.writeFile(contentFile(c.id, fx.dir, "decisions.json"), "{}");
    await fs.rm(aroll, { force: true });
    const again = await pull(c, aroll, cfm, "h-1");
    expect(again).toMatchObject({ ok: true, replayed: true, manifest_hash: res.manifest_hash, claim_token: res.claim_token });
    expect(await fs.readFile(bundle, "utf8")).toBe(frozen);
  });

  it("aroll-lock-concurrent-pull：两条稿抢同一段原片只有一个赢；Claude 推送也占锁", async () => {
    const a = await ready("第一条长长的标题");
    const b = await ready("第二条长长的标题");
    const aroll = await makeMp4(path.join(fx.outside, "IMG_0001.mp4"));
    const [ca, cb] = [await confirmed(aroll, a.title), await confirmed(aroll, b.title)];
    const [ra, rb] = await Promise.all([pull(a, aroll, ca, "h-a"), pull(b, aroll, cb, "h-b")]);
    const winner = ra.ok ? ra : rb, loser = ra.ok ? rb : ra;
    expect(winner.ok).toBe(true);
    expect(loser).toMatchObject({ ok: false, code: "aroll_in_use", holder: { content_id: winner.content_id, generation: 1 } });
    expect(loser.claim_token).toBeUndefined();
    const c = await ready("第三条长长的标题");
    await founderProjectReview(c.id, fx.dir, { action: "decisions", draft_hash: draftHash(c), title: c.title, cover_text: "封面", target_seconds: 60 });
    const pushed = await callVideo(fx.dir, { action: "handoff", content_id: c.id, aroll_path: aroll });
    expect(pushed).toMatchObject({ ok: false, code: "aroll_in_use" });
  });

  it("aroll-lock-release-on-revoke：撤回释放原片锁，旧回执作废", async () => {
    const a = await ready("第一条长长的标题");
    const aroll = await makeMp4(path.join(fx.outside, "第一条长长的标题.mp4"));
    const sha = await sha256File(aroll);
    const res = await pull(a, aroll, await confirmed(aroll, a.title), "h-1");
    expect(await arollLockOf(fx.dir, sha)).toMatchObject({ content_id: a.id, generation: 1 });
    const revoked = await callVideo(fx.dir, { action: "revoke", content_id: a.id, claim_token: res.claim_token }, "codex");
    expect(revoked).toMatchObject({ ok: true, status: "revoked" });
    expect(await arollLockOf(fx.dir, sha)).toBeNull();
  });

  it("writer-claim-blocks-pull：写稿认领没释放接不走，释放后放行", async () => {
    const a = await ready("第一条长长的标题");
    const aroll = await makeMp4(path.join(fx.outside, "第一条长长的标题.mp4"));
    const writer = await claimContent(a.id, "writer", "claude-code", fx.dir);
    const cfm = await confirmed(aroll, a.title);
    expect(await pull(a, aroll, cfm, "h-1")).toMatchObject({ ok: false, code: "claim_held" });
    expect(await executeDesk({ _dataDir: fx.dir, _host: "claude-code", action: "release", content_id: a.id, claim_token: writer.ok ? writer.claim.token : "" })).toMatchObject({ ok: true, released: true });
    expect(await pull(a, aroll, cfm, "h-2")).toMatchObject({ ok: true });
  });

  it("editing-claim-no-idle-takeover：心跳续 48 小时；闲置不能接管，创始人弹窗点接管才换人", async () => {
    const a = await ready("第一条长长的标题");
    const aroll = await makeMp4(path.join(fx.outside, "第一条长长的标题.mp4"));
    const res = await pull(a, aroll, await confirmed(aroll, a.title), "h-1");
    const claim = (await getContent(a.id, fx.dir))!.claim!;
    expect(Date.parse(claim.leaseUntil) - Date.now()).toBeGreaterThan(47 * 3600_000);
    await updateContent(a.id, { claim: { ...claim, lastWriteAt: new Date(Date.now() - 3 * 3600_000).toISOString() } }, fx.dir);
    const take = () => withCallerSession("s2", () => executeDesk({ _dataDir: fx.dir, _host: "codex", action: "claim", content_id: a.id, employee: "editor", takeover: true }));
    expect(await take()).toMatchObject({ ok: false, code: "claim_held" });
    takeoverAnswer = "接管";
    const taken = await take();
    expect(taken).toMatchObject({ ok: true });
    expect(taken.claim_token).not.toBe(res.claim_token);
    takeoverAnswer = "取消";
    const stale = await callVideo(fx.dir, { action: "report", content_id: a.id, claim_token: res.claim_token, _session: "s1",
      report: { request_id: "r1", generation: 1, binding_revision: 1, session_id: "s1", files: [], result: "x", next_action: "y" } }, "codex");
    expect(stale).toMatchObject({ ok: false, code: "claim_held" });
  });

  it("原片挪进 02-aroll/<原文件名>，同名加 (2)；撤回挪回原处，原处被占就回 Downloads 加后缀", async () => {
    const a = await ready("第一条长长的标题");
    const aroll = await makeMp4(path.join(fx.outside, "第一条长长的标题.mp4"));
    const sha = await sha256File(aroll);
    const root = (await import("../../../storage/content-project.js")).resolveContentProject(a.id, fx.dir)!.project_root;
    await fs.mkdir(path.join(root, "02-aroll"), { recursive: true });
    await fs.writeFile(path.join(root, "02-aroll/第一条长长的标题.mp4"), "旧文件");
    const res = await pull(a, aroll, await confirmed(aroll, a.title), "h-1");
    const inside = path.join(root, "02-aroll/第一条长长的标题 (2).mp4");
    expect(res).toMatchObject({ ok: true, aroll_moved_to: inside });
    expect((await getContent(a.id, fx.dir))!.video!.handoff).toMatchObject({ aroll_path: inside, aroll_source_path: aroll, aroll_sha256: sha });
    await expect(fs.access(aroll)).rejects.toThrow();
    await fs.writeFile(aroll, "有人在原处放了别的文件");
    const downloads = path.join(fx.outside, "Downloads");
    setPullDeps({ downloadsDir: downloads });
    const revoked = await callVideo(fx.dir, { action: "revoke", content_id: a.id, claim_token: res.claim_token }, "codex");
    expect(revoked).toMatchObject({ ok: true, aroll_restored_to: path.join(downloads, "第一条长长的标题.mp4") });
    expect(await sha256File(path.join(downloads, "第一条长长的标题.mp4"))).toBe(sha);
    await expect(fs.access(inside)).rejects.toThrow();
    expect(await arollLockOf(fx.dir, sha)).toBeNull();
  });
});
