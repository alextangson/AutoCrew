/**
 * 认稿（P6 §12.4-B）：L1 归一化、L2 评分、候选范围、回执与作废、只读（eval：match-is-read-only、
 * receipt-invalidated-on-draft-change、asr-failure-visible）。转写器一律注入假的，不跑 FunASR。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeFixture, seedAccepted, type HandoffFixture } from "./handoff-testkit.js";
import { initializeProjectLayout } from "../../../storage/content-project.js";
import { getContent, saveContent, updateContent } from "../../../storage/local-store.js";
import { matchL1, stripRecordingSuffixes, compareKey } from "./match-l1.js";
import { scoreTranscript } from "./match-l2.js";
import { matchAroll, readReceipt, receiptProblem, type MatchReceipt } from "./match.js";
import { setPullDeps } from "./pull-deps.js";
import { putArollLock } from "./pull-store.js";
import { executeVideo } from "../../../tools/video.js";
import { HUMAN_WRITE } from "../../../storage/first-body-guard.js";

/** 假原片只是几个字节：媒体探测换成放行，真探测在 verify-edges / pull-handoff 用真 mp4 测 */
const okProbe = async () => ({ ok: true as const });

const LONG = "今天我想认真聊一聊怎么把重复的工作交给 AI 助手去做，这样每天能省下两个小时去陪家人。";

describe("L1 文件名归一化", () => {
  it("只去拍摄尾缀，标题里有语义的数字留着", () => {
    expect(stripRecordingSuffixes("ＧＰＴ-5 发布了_口播_20260926.MOV")).toBe("gpt-5 发布了");
    expect(stripRecordingSuffixes("第 12 期 复盘 take 2.mp4")).toBe("第 12 期 复盘");
    expect(stripRecordingSuffixes("标题 A-Roll 原片 第3条.mov")).toBe("标题");
    expect(stripRecordingSuffixes("karoll.mp4")).toBe("karoll");
    expect(compareKey("GPT-5｜第 12 期")).toBe("gpt5第12期");
  });

  it("强命中只认当前标题全文；短标题、系列前缀、旧标题、多条命中都降级", () => {
    const subjects = [
      { title: "AI 省时三件事｜第二集", oldTitles: [] },
      { title: "短标题", oldTitles: [] },
      { title: "新的标题写法", oldTitles: ["老的标题写法"] },
    ];
    expect(matchL1("AI省时三件事｜第二集_口播.mov", subjects)[0]).toMatchObject({ kind: "strong" });
    expect(matchL1("AI 省时三件事.mov", subjects)[0]).toMatchObject({ kind: "weak", reason: "series_prefix" });
    expect(matchL1("短标题.mov", subjects)[1]).toMatchObject({ kind: "weak", reason: "short_title" });
    expect(matchL1("老的标题写法.mov", subjects)[2]).toMatchObject({ kind: "weak", possibly_old_version: true });
    const twins = matchL1("一模一样的长标题.mov", [{ title: "一模一样的长标题", oldTitles: [] }, { title: "一模一样的长标题", oldTitles: [] }]);
    expect(twins.every((h) => h.kind === "weak" && h.reason === "multiple_hits")).toBe(true);
  });
});

describe("L2 评分", () => {
  it("滑动窗口：长稿不因字多占优，念的那条得分最高", () => {
    const spoken = LONG;
    const other = "完全不同的话题：周末去爬山要带什么装备，水和干粮最重要。".repeat(20);
    const longMixed = other + "把重复的工作交给".repeat(1);
    const [right, wrong, long] = scoreTranscript(spoken, [LONG, "周末去爬山要带什么装备", longMixed]);
    expect(right).toBeGreaterThan(0.9);
    expect(right).toBeGreaterThan(long);
    expect(wrong).toBeLessThan(0.2);
  });
});

let fx: HandoffFixture;
let file: string;
const heard = { text: LONG + LONG, ok: true as const };

beforeEach(async () => {
  fx = await makeFixture();
  await fs.unlink(path.join(fx.dir, "video.json"));
  await initializeProjectLayout(fx.dir, "lib-deadbeef", "default");
  file = path.join(fx.outside, "IMG_1234.MOV");
  await fs.writeFile(file, "fake aroll bytes");
  setPullDeps({ probe: okProbe, transcriber: { transcribe: async () => heard } });
});
afterEach(async () => { setPullDeps(null); await fx.cleanup(); });

const match = (extra: Record<string, unknown> = {}, host = "codex") =>
  executeVideo({ _dataDir: fx.dir, _host: host, action: "match", aroll_path: file, request_id: "m-1", ...extra });

describe("match", () => {
  it("match-is-read-only：不改稿件与认领；回执落盘；标定前不出 proposed", async () => {
    const a = await seedAccepted(fx.dir, "怎么把重复工作交给 AI");
    await updateContent(a.id, { _provenance: HUMAN_WRITE, body: LONG + LONG }, fx.dir);
    await seedAccepted(fx.dir, "周末爬山装备清单");
    const before = JSON.stringify(await getContent(a.id, fx.dir));
    const res = await match();
    expect(res).toMatchObject({ ok: true, status: "ambiguous", calibrated: false });
    expect(res.status).not.toBe("proposed");
    const cands = res.candidates as Array<Record<string, unknown>>;
    expect(cands[0]).toMatchObject({ content_id: a.id, layer: "l2" });
    expect(JSON.stringify(await getContent(a.id, fx.dir))).toBe(before);
    const receipt = await readReceipt(fx.dir, String(res.receipt_id));
    expect(receipt).toMatchObject({ request_id: "m-1", library_id: "lib-deadbeef", aroll_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Date.parse(receipt!.expires_at) - Date.parse(receipt!.issued_at)).toBe(30 * 60_000);
  });

  it("唯一强命中也不出 proposed，且不跑转写", async () => {
    await seedAccepted(fx.dir, "独一无二的长标题呀");
    let called = 0;
    setPullDeps({ probe: okProbe, transcriber: { transcribe: async () => { called++; return heard; } } });
    await fs.rename(file, file = path.join(fx.outside, "独一无二的长标题呀_口播.mov"));
    const res = await match();
    expect(res).toMatchObject({ status: "ambiguous" });
    expect(called).toBe(0);
  });

  it("asr-failure-visible：转写不可用 → 弱命中不升级、降级原因可见", async () => {
    await seedAccepted(fx.dir, "独一无二的长标题呀｜上");
    await fs.rename(file, file = path.join(fx.outside, "独一无二的长标题呀.mov"));
    setPullDeps({ probe: okProbe, transcriber: { transcribe: async () => ({ ok: false, unavailable: true, reason: "未装 uv" }) } });
    const res = await match();
    expect(res).toMatchObject({ status: "no_confident_match", flags: ["asr_unavailable", "l1_only"] });
    expect(String((res.candidates as Array<{ evidence: string }>)[0].evidence)).toContain("未装 uv");
  });

  it("转写太短 → low_quality_transcript；没声音 → no_speech", async () => {
    await seedAccepted(fx.dir, "某条稿子");
    setPullDeps({ probe: okProbe, transcriber: { transcribe: async () => ({ ok: true, text: "把重复的工作交给" }) } });
    expect(await match()).toMatchObject({ status: "no_confident_match", flags: ["low_quality_transcript"] });
    setPullDeps({ probe: okProbe, transcriber: { transcribe: async () => ({ ok: true, text: "……" }) } });
    expect(await match({ request_id: "m-2" })).toMatchObject({ flags: ["no_speech", "l1_only"] });
  });

  it("导入稿进候选并标 unreviewed_import；没审的普通稿进 near_misses", async () => {
    const imported = await saveContent({ _provenance: HUMAN_WRITE, title: "导入的稿", body: LONG, status: "draft_ready", platform: "douyin", tags: [],
      writingSource: { kind: "manual_import", importedAt: "2026-09-27T00:00:00Z", reason: "本地稿导入" } }, fx.dir);
    const res = await match();
    expect((res.candidates as Array<Record<string, unknown>>)[0]).toMatchObject({ content_id: imported.id, unreviewed_import: true });
    // 创始人在看板认稿（draft_ready → approved）后照样是候选
    await updateContent(imported.id, { _provenance: HUMAN_WRITE, status: "approved" }, fx.dir);
    const approved = await match({ request_id: "m-approved" });
    expect((approved.candidates as Array<Record<string, unknown>>)[0]).toMatchObject({ content_id: imported.id, unreviewed_import: true });
    await updateContent(imported.id, { _provenance: HUMAN_WRITE, writingSource: undefined }, fx.dir);
    const none = await match({ request_id: "m-3" });
    expect(none).toMatchObject({ status: "no_candidate" });
    expect((none.near_misses as Array<Record<string, unknown>>)[0]).toMatchObject({ content_id: imported.id, reason: "这一版还没通过审稿" });
  });

  it("原片锁在 → already_handed_off 附持有者，不签回执", async () => {
    const a = await seedAccepted(fx.dir);
    const first = await match();
    await putArollLock(fx.dir, String(first.aroll_sha256), { content_id: a.id, generation: 2, at: "x" });
    expect(await match({ request_id: "m-4" })).toMatchObject({ status: "already_handed_off", holder: { content_id: a.id, generation: 2 } });
  });

  it("receipt-invalidated-on-draft-change：改稿、过期都让回执作废", async () => {
    const a = await seedAccepted(fx.dir);
    const res = await match();
    const receipt = (await readReceipt(fx.dir, String(res.receipt_id))) as MatchReceipt;
    expect(await receiptProblem(receipt, fx.dir)).toBeNull();
    await updateContent(a.id, { _provenance: HUMAN_WRITE, body: "改过的正文" }, fx.dir);
    expect(await receiptProblem(receipt, fx.dir)).toContain("改过");
    setPullDeps({ probe: okProbe, now: () => Date.now() + 31 * 60_000 });
    expect(await receiptProblem(receipt, fx.dir)).toContain("过期");
  });

  it("同 request_id 重发：同原片回原回执不另签；换了原片拒 request_conflict", async () => {
    await seedAccepted(fx.dir);
    const first = await match();
    const again = await match();
    expect(again).toMatchObject({ ok: true, replayed: true, receipt_id: first.receipt_id });
    const other = path.join(fx.outside, "IMG_9999.MOV");
    await fs.writeFile(other, "另一段原片");
    expect(await match({ aroll_path: other })).toMatchObject({ ok: false, code: "request_conflict" });
  });

  it("转写没就绪：不去跑转写、立刻回 asr_unavailable，next_action 指向预热", async () => {
    await seedAccepted(fx.dir, "某条稿子");
    let called = 0;
    setPullDeps({ probe: okProbe, transcriber: { transcribe: async () => { called++; return heard; }, notReady: async () => "ASR 模型还没下载（约 1GB）" } });
    const res = await match();
    expect(called).toBe(0);
    expect(res).toMatchObject({ ok: true, status: "no_confident_match", flags: expect.arrayContaining(["asr_unavailable"]) });
    expect(String(res.next_action)).toContain("预热 ASR 模型");
    expect(String((res.candidates as Array<{ evidence: string }>)[0].evidence)).toContain("模型还没下载");
  });

  it("输入先行：不存在、符号链接、坏 request_id 都拒", async () => {
    await seedAccepted(fx.dir);
    expect(await match({ aroll_path: path.join(fx.outside, "nope.mov") })).toMatchObject({ ok: false, code: "aroll_invalid" });
    const link = path.join(fx.outside, "link.mov");
    await fs.symlink(file, link);
    expect(await match({ aroll_path: link })).toMatchObject({ ok: false, code: "aroll_invalid" });
    expect(await match({ request_id: "../x" })).toMatchObject({ ok: false, code: "invalid_params" });
  });
});
