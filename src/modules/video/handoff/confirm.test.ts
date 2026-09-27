/**
 * 本机弹窗确认（P6 §12.4-C）：弹窗一律注入假的，绝不弹真窗。
 * eval：chat-text-is-not-confirmation（宿主转述写不出确认），同 request_id 不重复弹窗。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeFixture, seedAccepted, type HandoffFixture } from "./handoff-testkit.js";
import { contentFile, initializeProjectLayout } from "../../../storage/content-project.js";
import { getContent, saveContent, type Content } from "../../../storage/local-store.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { writeJsonAtomic } from "../../../storage/json-atomic.js";
import { founderProjectReview } from "./founder-review.js";
import { handoffEvidence, saveCoverage } from "./project-evidence.js";
import { setPullDeps } from "./pull-deps.js";
import type { DialogOutcome, DialogRunner } from "./dialog.js";
import { IMPORT_LINE, readConfirmation } from "./confirm.js";
import { executeVideo } from "../../../tools/video.js";

/** 假原片只是几个字节：媒体探测换成放行，真探测在 verify-edges / pull-handoff 用真 mp4 测 */
const okProbe = async () => ({ ok: true as const });

type Script = Array<DialogOutcome<string> | "first">;

/** 按顺序回放的假弹窗；记下每次弹了什么 */
function fakeDialog(script: Script) {
  const shown: Array<{ kind: string; prompt: string; items?: string[] }> = [];
  const next = (items?: string[]): DialogOutcome<string> => {
    const step = script.shift() ?? { kind: "timeout" };
    return step === "first" ? { kind: "ok", value: items![0] } : step;
  };
  const dialog: DialogRunner = {
    choose: async (o) => { shown.push({ kind: "choose", prompt: o.prompt, items: o.items }); return next(o.items); },
    ask: async (o) => { shown.push({ kind: "ask", prompt: o.prompt }); return next(); },
    input: async (o) => { shown.push({ kind: "input", prompt: o.prompt }); return next(); },
  };
  setPullDeps({ probe: okProbe, dialog, transcriber: { transcribe: async () => ({ ok: false, unavailable: true, reason: "测试不转写" }) } });
  return shown;
}

let fx: HandoffFixture;
let file: string;
beforeEach(async () => {
  fx = await makeFixture();
  await fs.unlink(path.join(fx.dir, "video.json"));
  await initializeProjectLayout(fx.dir, "lib-deadbeef", "default");
  file = path.join(fx.outside, "AI 工具分享.mov");
  await fs.writeFile(file, "fake aroll");
  fakeDialog([]);
});
afterEach(async () => { setPullDeps(null); await fx.cleanup(); });

async function cited(c: Content): Promise<Content> {
  const first = c.body.slice(0, c.body.indexOf("。") + 1);
  await saveCoverage(c, { draft_hash: draftHash(c), citations: [{ start: 0, end: first.length, excerpt: first, evidence_id: "creator", sourceType: "creator_opinion", quote: "", verification: "亲历" }], reviewed_by: "writer", reviewed_at: new Date().toISOString() }, fx.dir);
  return (await getContent(c.id, fx.dir))!;
}

const call = (params: Record<string, unknown>) => executeVideo({ _dataDir: fx.dir, _host: "codex", ...params });

async function receipt(): Promise<string> {
  const m = await call({ action: "match", aroll_path: file, request_id: "m-1" });
  if (!m.receipt_id) throw new Error(JSON.stringify(m));
  return String(m.receipt_id);
}

const confirm = (receiptId: string, extra: Record<string, unknown> = {}) =>
  call({ action: "confirm", receipt_id: receiptId, cover_text: "三招省时", target_seconds: 90, request_id: "c-1", ...extra });

describe("confirm", () => {
  it("点确认 → 服务端写确认记录与 decisions.json(native-dialog)，交接材料认它；同 request_id 不再弹窗", async () => {
    const c = await cited(await seedAccepted(fx.dir));
    const shown = fakeDialog(["first", { kind: "ok", value: "确认" }]);
    const res = await confirm(await receipt());
    expect(res).toMatchObject({ ok: true, status: "confirmed", source: "native-dialog", content_id: c.id, cover_text: "三招省时", target_seconds: 90 });
    expect(shown.map((s) => s.kind)).toEqual(["choose", "ask"]);
    expect(shown[1].prompt).toContain("原片：AI 工具分享.mov");
    const record = await readConfirmation(fx.dir, String(res.confirmation_id));
    expect(record).toMatchObject({ draft_hash: draftHash(c), aroll_sha256: expect.any(String), receipt_id: expect.any(String) });
    expect(Date.parse(record!.expires_at) - Date.parse(record!.clicked_at)).toBe(30 * 60_000);
    const decisions = JSON.parse(await fs.readFile(contentFile(c.id, fx.dir, "decisions.json"), "utf8"));
    expect(decisions).toMatchObject({ source: "native-dialog", cover_text: "三招省时", confirmation_id: res.confirmation_id });
    await expect(handoffEvidence(c, fx.dir)).resolves.toBeTruthy();
    const again = await confirm("rcpt-whatever");
    expect(again).toMatchObject({ ok: true, replayed: true, confirmation_id: res.confirmation_id });
    expect(shown).toHaveLength(2);
  });

  it("没人点 / 取消 / 弹不出来：各有码，什么都不记", async () => {
    const c = await cited(await seedAccepted(fx.dir));
    const r = await receipt();
    fakeDialog(["first", { kind: "timeout" }]);
    expect(await confirm(r)).toMatchObject({ ok: false, code: "confirm_timeout" });
    fakeDialog([{ kind: "cancel" }]);
    expect(await confirm(r, { request_id: "c-2" })).toMatchObject({ ok: false, code: "confirm_declined" });
    fakeDialog([{ kind: "unavailable", reason: "不是 macOS" }]);
    expect(await confirm(r, { request_id: "c-3" })).toMatchObject({ ok: false, code: "confirm_unavailable" });
    await expect(fs.access(contentFile(c.id, fx.dir, "decisions.json"))).rejects.toThrow();
  });

  it("改一下：创始人在输入框里改封面字和时长", async () => {
    await cited(await seedAccepted(fx.dir));
    fakeDialog(["first", { kind: "ok", value: "改一下" }, { kind: "ok", value: "新封面字" }, { kind: "ok", value: "75" }, { kind: "ok", value: "确认" }]);
    expect(await confirm(await receipt())).toMatchObject({ ok: true, cover_text: "新封面字", target_seconds: 75 });
  });

  it("工作台已有不同决定：并列两套值由创始人选，不静默覆盖", async () => {
    const c = await cited(await seedAccepted(fx.dir));
    await founderProjectReview(c.id, fx.dir, { action: "decisions", draft_hash: draftHash(c), title: c.title, cover_text: "工作台封面", target_seconds: 60 });
    const shown = fakeDialog(["first", { kind: "ok", value: "用工作台的" }]);
    const res = await confirm(await receipt());
    expect(shown[1].prompt).toContain("工作台已确认：封面字「工作台封面」，60 秒");
    expect(shown[1].prompt).toContain("本次：封面字「三招省时」，90 秒");
    expect(res).toMatchObject({ ok: true, cover_text: "工作台封面", target_seconds: 60 });
  });

  it("导入稿：弹窗多一行说明，确认记录带 recorded_as_is", async () => {
    const imported = await saveContent({ title: "导入的稿子标题", body: "我自己录的。第二句。", status: "draft_ready", platform: "douyin", tags: [],
      writingSource: { kind: "manual_import", importedAt: "2026-09-27T00:00:00Z", reason: "本地稿导入" } }, fx.dir);
    await cited(imported);
    const shown = fakeDialog(["first", { kind: "ok", value: "确认" }]);
    const res = await confirm(await receipt());
    expect(shown[0].items?.[0]).toContain("［导入稿］");
    expect(shown[1].prompt).toContain(IMPORT_LINE);
    expect(res).toMatchObject({ ok: true, recorded_as_is: true });
  });

  it("缺出处 → missing_citations，不写记录；候选只能取自回执；原片变了回执作废", async () => {
    const c = await seedAccepted(fx.dir);
    const r = await receipt();
    fakeDialog(["first"]);
    expect(await confirm(r)).toMatchObject({ ok: false, code: "missing_citations" });
    fakeDialog(["first"]);
    expect(await confirm(r, { request_id: "c-2", content_id: "content-1-nothere" })).toMatchObject({ ok: false, code: "invalid_params" });
    await cited(c);
    const fresh = await receipt();
    await fs.writeFile(file, "换了一段");
    expect(await confirm(fresh, { request_id: "c-3" })).toMatchObject({ ok: false, code: "receipt_invalid" });
  });

  it("先核材料再弹窗：弹窗只列材料齐的候选", async () => {
    const good = await cited(await seedAccepted(fx.dir, "AI 工具分享 第一条"));
    await seedAccepted(fx.dir, "AI 工具分享 第二条");
    const shown = fakeDialog(["first", { kind: "ok", value: "确认" }]);
    const res = await confirm(await receipt());
    expect(res).toMatchObject({ ok: true, content_id: good.id });
    expect(shown[0].items).toEqual([expect.stringContaining(good.title)]);
  });

  it("候选都缺材料：不弹窗，拒绝里逐条说明每条为什么交不了", async () => {
    await seedAccepted(fx.dir, "AI 工具分享 第一条");
    await seedAccepted(fx.dir, "AI 工具分享 第二条");
    const shown = fakeDialog(["first", { kind: "ok", value: "确认" }]);
    const res = await confirm(await receipt());
    expect(res).toMatchObject({ ok: false, code: "missing_citations", candidates: [
      expect.objectContaining({ code: "missing_citations" }), expect.objectContaining({ code: "missing_citations" })] });
    expect(shown).toEqual([]);
  });

  it("chat-text-is-not-confirmation：宿主转述写成的 decisions 过不了交接材料检查", async () => {
    const c = await cited(await seedAccepted(fx.dir));
    await writeJsonAtomic(contentFile(c.id, fx.dir, "decisions.json"), { draft_hash: draftHash(c), title: c.title, cover_text: "对，就这个",
      platform: c.platform, target_seconds: 90, confirmed_at: new Date().toISOString(), source: "codex-chat" });
    await expect(handoffEvidence(c, fx.dir)).rejects.toMatchObject({ code: "missing_decisions" });
  });
});
