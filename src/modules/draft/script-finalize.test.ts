/** 顶栏「定稿」（2026-10-26）：写稿中照样能定、释放写手认领、绑正文哈希、幂等、AI 改稿作废 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickOpening } from "../../tools/draft-test-helpers.js";
import { executeDraft } from "../../tools/draft.js";
import { executeContentSave } from "../../tools/content-save.js";
import { ensureClaim } from "../../storage/claims.js";
import { buildIpcHandlers } from "../../desktop/ipc.js";
import { saveContent, getContent } from "../../storage/local-store.js";
import { bodyHash, readProductionDoc, scriptApprovalFor, writeEnabledVersion } from "../../storage/production-store.js";
import "../production/service.js";

let dir: string;
const BODY = "你是不是也觉得用了 AI 以后反而更忙了？省下来的时间，被你自己又填满了。有份调查问了不少职场人，很多人每天用 AI 写周报。可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的那段时间写进日历。";
const ANGLE = { exemplars: [] as unknown[], main_line: "AI 省下的时间会被你自己填满", for_whom: "职场人", opening: "你是不是也觉得更忙了？", why_viral: "同题材播放第一", chain: ["一", "二", "三", "四"], founder_words: "就这个", genre: "ganhuo" };
const run = (action: string, args: Record<string, unknown> = {}) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });
const ipc = (ch: "script:finalize" | "script:final_get", payload: Record<string, unknown>, authMethod: "session" | "bearer" = "session") =>
  buildIpcHandlers()[ch]({ ...payload, _dataDir: dir }, { authMethod }) as Promise<Record<string, unknown>>;

/** 薄路径写到 drafting、AI 还拿着写手认领，返回令牌 */
async function drafting(body = BODY, employee: "writer" | "cover" = "writer"): Promise<{ id: string; token: string }> {
  const started = await run("start", { inspiration: "AI 越用越忙" });
  const id = started.content_id as string;
  await run("angle", { content_id: id, base_version: 1, ...ANGLE });
  await pickOpening(run, id, 1);
  const saved = await run("save", { content_id: id, base_version: 1, body });
  if (!saved.ok) throw new Error(JSON.stringify(saved));
  const claimed = await ensureClaim(id, { host: "claude-code", employee }, dir);
  if (!claimed.ok) throw new Error(claimed.error);
  return { id, token: claimed.claim.token };
}

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "script-final-")); await writeEnabledVersion(dir); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("script:finalize", () => {
  it("占着的是封面等别的工位：定稿不动那份认领（只放写手的）", async () => {
    const { id } = await drafting(BODY, "cover");
    const before = (await getContent(id, dir))!;
    expect(await ipc("script:finalize", { id, expected_body_hash: bodyHash(before.body) })).toMatchObject({ ok: true, status: "approved" });
    const after = (await getContent(id, dir))!;
    expect(after.claim?.employee).toBe("cover");
    expect(after.handoffs?.some((h) => h.note?.includes("写手认领释放"))).toBe(false);
  });

  it("写稿中 + AI 占着认领：直接定到 approved，认稿绑正文哈希，认领释放并记账，没清单照定并记下", async () => {
    const { id, token } = await drafting();
    const before = (await getContent(id, dir))!;
    expect(before.status).toBe("drafting");
    expect(before.claim?.host).toBe("claude-code");
    expect(token).toBeTruthy();
    const r = await ipc("script:finalize", { id, expected_body_hash: bodyHash(before.body) });
    expect(r).toMatchObject({ ok: true, status: "approved" });
    const after = (await getContent(id, dir))!;
    expect(after.status).toBe("approved");
    expect(after.claim).toBeUndefined();
    expect(after.handoffs?.some((h) => h.note?.includes("写手认领释放") && h.from === "claude-code")).toBe(true);
    expect(after.draftFinal).toMatchObject({ checklist: "none", kept: [] });
    const d = scriptApprovalFor((await readProductionDoc(id, dir))!, after.body);
    expect(d?.body_hash).toBe(bodyHash(after.body));
    const s = await ipc("script:final_get", { id });
    expect(s.data).toMatchObject({ status: "approved", approved_at: d!.at, writing: false, gaps: { kind: "none" } });
  });

  it("清单对得上但有没出处的项：不拦，读回「还有 N 处」，定稿把它们记成未核验", async () => {
    const { id } = await drafting(BODY.replace("可周报写得快了", "而且会议时间平均多了 25%。可周报写得快了"));
    const prep = await run("prepare_final", { content_id: id, base_version: 2, citations: [] });
    expect(prep).toMatchObject({ ok: true, unsourced: 1 });
    expect((await ipc("script:final_get", { id })).data).toMatchObject({ gaps: { kind: "unsourced", count: 1 } });
    const c = (await getContent(id, dir))!;
    expect(await ipc("script:finalize", { id, expected_body_hash: bodyHash(c.body) })).toMatchObject({ ok: true });
    const after = (await getContent(id, dir))!;
    expect(after.draftFinal?.kept).toHaveLength(1);
    expect(after.draftFinal?.checklist).toBeUndefined();
    expect(after.evidenceLedger?.entries.some((e) => e.source === "user_claim" && e.quote.includes("25%"))).toBe(true);
  });

  it("模型调用（非浏览器会话）一律拒", async () => {
    const { id } = await drafting();
    const c = (await getContent(id, dir))!;
    expect(await ipc("script:finalize", { id, expected_body_hash: bodyHash(c.body) }, "bearer")).toMatchObject({ ok: false, code: "founder_only" });
    expect((await getContent(id, dir))!.status).toBe("drafting");
  });

  it("正文哈希对不上：拒，状态和认领都不动", async () => {
    const { id } = await drafting();
    const r = await ipc("script:finalize", { id, expected_body_hash: bodyHash("别的正文") });
    expect(r).toMatchObject({ ok: false, code: "body_changed" });
    const c = (await getContent(id, dir))!;
    expect(c.status).toBe("drafting");
    expect(c.claim?.host).toBe("claude-code");
  });

  it("重复点：第二次回 already，不再记第二条认稿", async () => {
    const { id } = await drafting();
    const hash = bodyHash((await getContent(id, dir))!.body);
    expect((await ipc("script:finalize", { id, expected_body_hash: hash })).ok).toBe(true);
    expect(await ipc("script:finalize", { id, expected_body_hash: hash })).toMatchObject({ ok: true, already: true });
    const approvals = (await readProductionDoc(id, dir))!.decisions.filter((x) => x.type === "script_approval");
    expect(approvals).toHaveLength(1);
  });

  it("定稿后 AI 拿旧令牌改正文：认稿作废、退回等你认稿，按钮回到「定稿」", async () => {
    const { id, token } = await drafting();
    const c = (await getContent(id, dir))!;
    await ipc("script:finalize", { id, expected_body_hash: bodyHash(c.body) });
    const edited = await executeContentSave({ action: "update", id, body: `${c.body}再加一句。`, _host: "claude-code", claim_token: token, _dataDir: dir });
    expect(edited.ok).toBe(true);
    const after = (await getContent(id, dir))!;
    expect(after.status).toBe("draft_ready");
    expect(scriptApprovalFor((await readProductionDoc(id, dir))!, after.body)).toBeNull();
    expect((await ipc("script:final_get", { id })).data).toMatchObject({ approved_at: null, writing: true });
  });

  it("定稿后创始人改正文：认稿重绑新正文", async () => {
    const { id } = await drafting();
    const c = (await getContent(id, dir))!;
    await ipc("script:finalize", { id, expected_body_hash: bodyHash(c.body) });
    const edited = await executeContentSave({ action: "update", id, body: `${c.body}我自己加的。`, _dataDir: dir });
    expect(edited.ok).toBe(true);
    const after = (await getContent(id, dir))!;
    expect(after.status).toBe("approved");
    expect(scriptApprovalFor((await readProductionDoc(id, dir))!, after.body)).not.toBeNull();
  });

  it("文字平台不在范围：读回 null，定稿被拒", async () => {
    const c = await saveContent({ title: "公众号", body: "正文", platform: "wechat_mp", status: "drafting", _provenance: { kind: "human" } } as never, dir);
    expect((await ipc("script:final_get", { id: c.id })).data).toBeNull();
    expect(await ipc("script:finalize", { id: c.id, expected_body_hash: bodyHash("正文") })).toMatchObject({ ok: false, code: "not_video" });
  });
});
